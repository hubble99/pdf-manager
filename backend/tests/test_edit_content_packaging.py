"""Opt-in checks against the actual frozen sidecar and staged desktop resources."""

import io
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import uuid

import httpx
import pytest
from pypdf import PdfWriter


pytestmark = pytest.mark.skipif(
    os.name != "nt" or not os.environ.get("EDIT_CONTENT_TEST_SIDECAR"),
    reason="requires an explicitly selected frozen Windows sidecar",
)


def isolated_environment(tmp_path):
    return dict(os.environ, TEMP_DIR=str(tmp_path / "temp"),
                OUTPUT_DIR=str(tmp_path / "output"), APP_DATA_DIR=str(tmp_path / "data"))


def test_packaged_inspector_does_not_require_or_initialize_the_application(tmp_path):
    source = tmp_path / "invalid.pdf"
    source.write_bytes(b"invalid PDF")
    environment = isolated_environment(tmp_path)
    environment["PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR"] = str(tmp_path / "missing")
    probe = subprocess.run(
        [os.environ["EDIT_CONTENT_TEST_SIDECAR"], "--edit-content-inspector", "--input", str(source)],
        cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    assert probe.returncode == 0, probe.stderr
    assert json.loads(probe.stdout)["supported"] is False
    assert all(not (tmp_path / name).exists() for name in ("temp", "output", "data"))


@pytest.mark.parametrize("resources", ["valid", "missing", "tampered"])
def test_packaged_content_resource_failure_is_isolated(tmp_path, resources):
    environment = isolated_environment(tmp_path)
    token = uuid.uuid4().hex
    environment["PDF_MANAGER_DESKTOP_LIFECYCLE_TOKEN"] = token
    runtime_root = Path(os.environ["EDIT_CONTENT_TEST_RESOURCE_DIR"])
    if resources != "valid":
        runtime_root = tmp_path / "bad-runtime"
        if resources == "tampered":
            runtime_root.mkdir()
            original = Path(os.environ["EDIT_CONTENT_TEST_RESOURCE_DIR"]) / "pdfium-artifacts.json"
            manifest = json.loads(original.read_text(encoding="utf-8"))
            manifest["targets"]["windows-x86_64"]["librarySha256"] = "f" * 64
            (runtime_root / original.name).write_text(json.dumps(manifest), encoding="utf-8")
    environment["PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR"] = str(runtime_root)
    # Keep the selected test artifact independent from developer worker overrides.
    environment.pop("PDF_MANAGER_EDIT_CONTENT_WORKER", None)
    environment.pop("PDF_MANAGER_PDFIUM_LIBRARY", None)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    environment.update(HOST="127.0.0.1", PORT=str(port), LOG_LEVEL="WARNING")
    with (tmp_path / "sidecar.log").open("wb") as log:
        process = subprocess.Popen([os.environ["EDIT_CONTENT_TEST_SIDECAR"]], cwd=tmp_path,
                                   env=environment, stdout=log, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=90) as client:
                deadline = time.monotonic() + 30
                while True:
                    assert process.poll() is None, "packaged backend exited before startup"
                    try:
                        if client.get("/health", timeout=0.5).status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    assert time.monotonic() < deadline, "packaged startup timed out"
                    time.sleep(0.1)
                assert client.post("/api/v1/edit-canvas/save", json={}).status_code == 422
                assert client.post("/api/v1/edit-content/shutdown").status_code == 404
                writer = PdfWriter()
                writer.add_blank_page(width=100, height=100)
                source = io.BytesIO()
                writer.write(source)
                response = client.post("/api/v1/edit-content/sessions",
                    data={"schemaVersion": "edit-content-request/v1", "requestId": "packaged-probe", "command": "open"},
                    files={"file": ("input.pdf", source.getvalue(), "application/pdf")})
                assert response.status_code == (200 if resources == "valid" else 503), response.text
                if resources == "valid":
                    assert response.json()["status"] == "accepted"
                    assert response.json()["result"]["state"]["acceptedRevision"] == 0
                assert client.get("/health").status_code == 200
                closed = client.post("/api/v1/edit-content/shutdown", headers={"X-PDF-Manager-Lifecycle": token})
                assert closed.status_code == 200, closed.text
                assert closed.json()["closedSessions"] == (1 if resources == "valid" else 0)
        finally:
            # This PID is the exact sidecar started by this test; kill its own
            # bootloader/interpreter tree, never another running application.
            if process.poll() is None:
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
            process.wait(timeout=5)
