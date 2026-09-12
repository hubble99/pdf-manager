"""Package faults must stay inside Content and must not redefine its engine pin."""

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from features.edit_content.engine_identity import load_engine_identity
from features.edit_content.session_service import default_worker_config


BACKEND = Path(__file__).resolve().parents[1]
MANIFEST = BACKEND.parent / "native/edit-content-engine/pdfium-artifacts.json"


@pytest.mark.parametrize("manifest_text", [None, "not json", "[]"])
def test_bad_content_resources_do_not_stop_backend(tmp_path, manifest_text):
    resources = tmp_path / "resources"
    resources.mkdir()
    if manifest_text is not None:
        (resources / "pdfium-artifacts.json").write_text(manifest_text, encoding="utf-8")
    environment = dict(os.environ, PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR=str(resources),
                       TEMP_DIR=str(tmp_path / "temp"), OUTPUT_DIR=str(tmp_path / "output"),
                       APP_DATA_DIR=str(tmp_path / "data"))
    probe = subprocess.run(
        [sys.executable, "-c", """
import asyncio
from httpx import ASGITransport, AsyncClient
from main import app
async def probe():
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.get('/health')).status_code == 200
        assert (await client.post('/api/v1/edit-canvas/save', json={})).status_code == 422
        response = await client.post('/api/v1/edit-content/sessions',
            data={'schemaVersion': 'edit-content-request/v1', 'requestId': 'probe', 'command': 'open'},
            files={'file': ('input.pdf', b'%PDF-test', 'application/pdf')})
        assert response.status_code == 503, response.text
asyncio.run(probe())
"""], cwd=BACKEND, env=environment, capture_output=True, text=True, timeout=30,
    )
    assert probe.returncode == 0, probe.stderr


@pytest.mark.parametrize("field,value", [("librarySha256", "f" * 64), ("libraryFile", "../other.dll")])
def test_runtime_manifest_cannot_redefine_trusted_identity(tmp_path, monkeypatch, field, value):
    monkeypatch.delenv("PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR", raising=False)
    expected = load_engine_identity()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    manifest["targets"][expected.target][field] = value
    (tmp_path / "pdfium-artifacts.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setenv("PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR", str(tmp_path))
    assert load_engine_identity() == expected
    with pytest.raises(RuntimeError):
        default_worker_config()


def test_inspector_mode_does_not_initialize_application(tmp_path):
    source = tmp_path / "invalid.pdf"
    source.write_bytes(b"invalid PDF")
    environment = dict(os.environ, PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR=str(tmp_path / "missing"),
                       TEMP_DIR=str(tmp_path / "temp"), OUTPUT_DIR=str(tmp_path / "output"),
                       APP_DATA_DIR=str(tmp_path / "data"))
    probe = subprocess.run([sys.executable, "main.py", "--edit-content-inspector", "--input", str(source)],
                           cwd=BACKEND, env=environment, capture_output=True, text=True, timeout=15)
    assert probe.returncode == 0, probe.stderr
    assert json.loads(probe.stdout)["supported"] is False
    assert not (tmp_path / "data").exists()
    assert not (tmp_path / "temp").exists()
    assert not (tmp_path / "output").exists()


def test_frozen_backend_uses_its_embedded_pin(tmp_path, monkeypatch):
    expected = load_engine_identity()
    embedded = tmp_path / "edit-content"
    embedded.mkdir()
    (embedded / "pdfium-artifacts.json").write_bytes(MANIFEST.read_bytes())
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setenv("PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR", str(tmp_path / "missing-runtime"))
    assert load_engine_identity() == expected
