import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import pytest
from pypdf import PdfWriter

from features.edit_content import inspector_service_manager as manager_module
from features.edit_content.inspector_service_manager import InspectorServiceManager, service_command
from features.edit_content.process_adapter import ContentWorkerAdapter, WorkerLaunchConfig
from features.edit_content.resource_inspector import ReadOnlyResourceInspector
from features.edit_content.resource_inspector_service import answer

BACKEND = Path(__file__).resolve().parents[1]
TOKEN = "t" * 64


def _pdf(path: Path) -> Path:
    writer = PdfWriter()
    writer.add_blank_page(200, 200)
    with path.open("wb") as handle:
        writer.write(handle)
    return path


def _ask(endpoint: str, request: dict) -> dict:
    host, port = endpoint.split(":")
    with socket.create_connection((host, int(port)), timeout=20) as connection:
        connection.sendall(json.dumps(request).encode() + b"\n")
        data = b""
        while not data.endswith(b"\n"):
            chunk = connection.recv(65536)
            if not chunk:
                break
            data += chunk
    return json.loads(data)


@pytest.fixture(autouse=True)
def _service_can_import_backend(monkeypatch):
    # The service is launched as ``python -m features...``; that only resolves when the
    # backend directory is importable, whatever directory pytest was started from.
    existing = os.environ.get("PYTHONPATH")
    monkeypatch.setenv("PYTHONPATH", str(BACKEND) + (os.pathsep + existing if existing else ""))


def _real_manager() -> InspectorServiceManager:
    manager = InspectorServiceManager(service_command(False, sys.executable))
    return manager


def _wait_endpoint(manager: InspectorServiceManager, timeout: float = 30.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        endpoint = manager.endpoint()
        if endpoint is not None:
            return endpoint
        time.sleep(0.05)
    raise AssertionError("inspector service did not become ready")


def test_answer_matches_the_one_shot_inspector_and_fails_closed(tmp_path):
    source = _pdf(tmp_path / "a.pdf")
    inspector = ReadOnlyResourceInspector()
    request = json.dumps({"token": TOKEN, "input": str(source)}).encode()
    assert answer(request, TOKEN, inspector) == inspector.inspect(source).to_payload()

    for bad in (
        {"token": "wrong", "input": str(source)},
        {"input": str(source)},
        {"token": TOKEN, "input": "relative.pdf"},
        {"token": TOKEN, "input": str(tmp_path / "missing.pdf")},
        {"token": TOKEN, "input": str(tmp_path)},
        {"token": TOKEN, "input": 7},
    ):
        reply = answer(json.dumps(bad).encode(), TOKEN, inspector)
        assert reply["supported"] is False
    assert answer(b"not json", TOKEN, inspector)["supported"] is False
    garbage = tmp_path / "garbage.pdf"
    garbage.write_bytes(b"not a pdf")
    assert answer(json.dumps({"token": TOKEN, "input": str(garbage)}).encode(), TOKEN, inspector)["supported"] is False


@pytest.mark.skipif(os.name == "nt", reason="symlink creation needs privileges on Windows")
def test_answer_refuses_symlinked_inputs(tmp_path):
    source = _pdf(tmp_path / "a.pdf")
    link = tmp_path / "link.pdf"
    link.symlink_to(source)
    reply = answer(json.dumps({"token": TOKEN, "input": str(link)}).encode(), TOKEN, ReadOnlyResourceInspector())
    assert reply["supported"] is False


def test_real_service_serves_repeated_requests_and_stops_with_its_owner(tmp_path):
    source = _pdf(tmp_path / "a.pdf")
    expected = ReadOnlyResourceInspector().inspect(source).to_payload()
    manager = _real_manager()
    try:
        endpoint, token = _wait_endpoint(manager)
        for _ in range(3):
            assert _ask(endpoint, {"token": token, "input": str(source)}) == expected
        assert _ask(endpoint, {"token": "0" * 64, "input": str(source)})["supported"] is False
        process = manager._process
    finally:
        manager.stop()
    assert process.poll() is not None
    assert manager.endpoint() is None  # stopped managers never relaunch


def test_died_service_is_replaced_within_budget_and_never_blocks(tmp_path):
    manager = _real_manager()
    try:
        _wait_endpoint(manager)
        manager._process.kill()
        manager._process.wait()
        assert manager.endpoint() is None  # caller falls back immediately
        endpoint, _ = _wait_endpoint(manager)
        assert endpoint.startswith("127.0.0.1:")
    finally:
        manager.stop()


def test_unlaunchable_service_just_reports_no_endpoint(monkeypatch):
    monkeypatch.setattr(manager_module, "READY_TIMEOUT_SECONDS", 1.0)
    manager = InspectorServiceManager((sys.executable, "-c", "import sys; sys.exit(3)"))
    assert manager.endpoint() is None
    time.sleep(0.5)
    assert manager.endpoint() is None
    manager.stop()


def test_adapter_hands_the_worker_the_endpoint_cache_dir_and_cleans_up(tmp_path, monkeypatch):
    seen = {}

    class FakeProcess:
        stdin = stdout = stderr = None
        pid = 1

        def poll(self):
            return None

    def fake_popen(command, **kwargs):
        seen["command"] = command
        seen["env"] = kwargs.get("env")
        raise OSError("stop after capturing the launch")

    monkeypatch.setattr("features.edit_content.process_adapter.subprocess.Popen", fake_popen)
    source = _pdf(tmp_path / "a.pdf")
    config = WorkerLaunchConfig.create(
        worker_command=("worker",),
        pdfium_library=tmp_path / "pdfium",
        workspace_root=tmp_path / "ws",
        inspector_command=("python", "x"),
        inspector_service=lambda: ("127.0.0.1:4242", "secret-token"),
        inspection_cache_id="build-1",
    )
    adapter = ContentWorkerAdapter(config)
    with pytest.raises(Exception):
        adapter.start(source)
    command = seen["command"]
    assert command[command.index("--inspector-endpoint") + 1] == "127.0.0.1:4242"
    assert "secret-token" not in command  # the token travels in the environment only
    assert seen["env"]["EDIT_CONTENT_INSPECTOR_TOKEN"] == "secret-token"
    cache_dir = Path(command[command.index("--inspection-cache-dir") + 1])
    assert command[command.index("--inspection-cache-id") + 1] == "build-1"
    assert cache_dir.parent == tmp_path / "ws" and cache_dir.is_dir()
    adapter.discard_inspection_cache()
    assert not cache_dir.exists()


def test_adapter_without_service_or_cache_id_passes_neither(tmp_path, monkeypatch):
    seen = {}

    def fake_popen(command, **kwargs):
        seen["command"] = command
        raise OSError("stop")

    monkeypatch.setattr("features.edit_content.process_adapter.subprocess.Popen", fake_popen)
    config = WorkerLaunchConfig.create(
        worker_command=("worker",), pdfium_library=tmp_path / "p", workspace_root=tmp_path / "ws",
        inspector_command=("python", "x"), inspector_service=lambda: None,
    )
    with pytest.raises(Exception):
        ContentWorkerAdapter(config).start(_pdf(tmp_path / "a.pdf"))
    assert "--inspector-endpoint" not in seen["command"]
    assert "--inspection-cache-dir" not in seen["command"]


def test_default_config_uses_the_native_inspector_and_cache_identity():
    from features.edit_content import session_service

    config = session_service.default_worker_config()
    assert config.native_inspector is True
    assert config.inspector_command is None and config.inspector_service is None
    assert config.inspection_cache_id.startswith(session_service.APP_VERSION)


def test_native_launch_passes_the_flag_and_no_external_inspector(tmp_path, monkeypatch):
    seen = {}

    def fake_popen(command, **kwargs):
        seen["command"] = command
        raise OSError("stop")

    monkeypatch.setattr("features.edit_content.process_adapter.subprocess.Popen", fake_popen)
    config = WorkerLaunchConfig.create(
        worker_command=("worker",), pdfium_library=tmp_path / "p", workspace_root=tmp_path / "ws",
        native_inspector=True, inspection_cache_id="build-1",
    )
    with pytest.raises(Exception):
        ContentWorkerAdapter(config).start(_pdf(tmp_path / "a.pdf"))
    assert "--native-inspector" in seen["command"]
    assert "--inspector-program" not in seen["command"]
    with pytest.raises(ValueError):
        WorkerLaunchConfig.create(worker_command=("w",), pdfium_library=tmp_path, workspace_root=tmp_path)
    with pytest.raises(ValueError):
        WorkerLaunchConfig.create(
            worker_command=("w",), pdfium_library=tmp_path, workspace_root=tmp_path,
            inspector_command=("x",), native_inspector=True,
        )


def test_service_can_be_switched_off(monkeypatch):
    from features.edit_content import session_service

    monkeypatch.setenv(manager_module.DISABLE_ENV, "0")
    monkeypatch.setattr(session_service, "_inspector_service", None)
    assert session_service.get_inspector_service() is None
    assert session_service.default_worker_config().inspector_service is None


def test_prewarm_only_runs_when_a_real_engine_is_configured(monkeypatch):
    from features.edit_content import session_service

    started = []

    class Recorder:
        def start_async(self):
            started.append(True)

    monkeypatch.setattr(session_service, "get_inspector_service", lambda: Recorder())
    monkeypatch.delenv("PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR", raising=False)
    monkeypatch.delenv("PDF_MANAGER_EDIT_CONTENT_WORKER", raising=False)
    session_service.prewarm_inspector_service()
    assert started == []
    monkeypatch.setenv("PDF_MANAGER_EDIT_CONTENT_WORKER", "worker")
    session_service.prewarm_inspector_service()
    assert started == [True]
