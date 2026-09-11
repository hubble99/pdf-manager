import json
from pathlib import Path
import struct
import sys

import pytest
from httpx import ASGITransport, AsyncClient

from features.edit_content.process_adapter import (
    ContentWorkerAdapter,
    ContentWorkerError,
    WorkerLaunchConfig,
)
from main import app


_FAKE_WORKER = r'''
import argparse
import json
import os
import struct
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--mode", default="normal")
args, _ = parser.parse_known_args()

def read_exact(length):
    data = bytearray()
    while len(data) < length:
        chunk = sys.stdin.buffer.read(length - len(data))
        if not chunk:
            return None
        data.extend(chunk)
    return bytes(data)

while True:
    header = read_exact(4)
    if header is None:
        break
    payload = read_exact(struct.unpack(">I", header)[0])
    if payload is None:
        break
    request = json.loads(payload)
    if args.mode == "crash" and request["command"] == "open":
        os._exit(17)
    reply = {
        "schemaVersion": "edit-content-reply/v1",
        "requestId": request["requestId"],
        "sessionId": request["sessionId"],
        "status": "accepted",
        "acceptedRevision": 0,
        "result": {"command": request["command"], "workerPid": os.getpid()},
    }
    encoded = json.dumps(reply, separators=(",", ":")).encode()
    sys.stdout.buffer.write(struct.pack(">I", len(encoded)) + encoded)
    sys.stdout.buffer.flush()
    if request["command"] == "close":
        break
'''


def _adapter(tmp_path: Path, *, mode: str = "normal") -> ContentWorkerAdapter:
    worker_script = tmp_path / f"worker-{mode}.py"
    worker_script.write_text(_FAKE_WORKER, encoding="utf-8")
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.4\n%%EOF")
    config = WorkerLaunchConfig.create(
        worker_command=(sys.executable, str(worker_script), "--mode", mode),
        pdfium_library=tmp_path / "pdfium.dll",
        workspace_root=tmp_path / "workspaces",
        inspector_command=(sys.executable, "resource-inspector.py"),
    )
    adapter = ContentWorkerAdapter(config)
    adapter.start(source, session_id="adapter-test")
    return adapter


def test_adapter_open_close_and_restart_are_scoped(tmp_path):
    adapter = _adapter(tmp_path)
    first = adapter.open()
    first_pid = first["result"]["workerPid"]
    assert first["result"]["command"] == "open"

    restarted = adapter.restart()
    assert restarted["result"]["command"] == "open"
    assert restarted["result"]["workerPid"] != first_pid
    closed = adapter.close()
    assert closed["result"]["command"] == "close"
    assert adapter.is_running is False


@pytest.mark.asyncio
async def test_worker_failure_leaves_backend_and_canvas_responsive(tmp_path):
    adapter = _adapter(tmp_path, mode="crash")
    with pytest.raises(ContentWorkerError, match="unavailable"):
        adapter.open()
    adapter.terminate()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        health = await client.get("/health")
        canvas = await client.post("/api/v1/edit-canvas/save")
        content = await client.post("/api/v1/edit-content/save")
    assert health.status_code == 200
    assert canvas.status_code == 422
    assert content.status_code == 404
