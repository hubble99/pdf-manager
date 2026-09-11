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
parser.add_argument("--session-id")
parser.add_argument("--workspace-root")
parser.add_argument("--accepted-revision", type=int, default=0)
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
    if request["command"] == "apply":
        token = "candidate-%s-0" % os.getpid()
        workspace = os.path.join(args.workspace_root, "edit-content-fake-%s" % os.getpid())
        os.makedirs(os.path.join(workspace, "staging"), exist_ok=True)
        with open(os.path.join(workspace, ".owner.json"), "w", encoding="utf-8") as marker:
            json.dump({"schema": "edit-content-workspace/v1", "owner": "edit-content-engine",
                       "sessionId": args.session_id, "processId": os.getpid()}, marker)
        with open(os.path.join(workspace, "staging", token + ".pdf"), "wb") as candidate:
            candidate.write(b"verified candidate")
        schema, status, result = "edit-content-preparation/v1", "prepared", {"candidateToken": token}
    else:
        schema, status, result = "edit-content-reply/v1", "accepted", {
            "command": request["command"], "workerPid": os.getpid()}
    reply = {
        "schemaVersion": schema,
        "requestId": request["requestId"],
        "sessionId": request["sessionId"],
        "status": status,
        "acceptedRevision": args.accepted_revision,
        "result": result,
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
        # Use the base interpreter, not the venv launcher process, so the fake
        # worker's ownership PID has the same semantics as the real Rust binary.
        worker_command=(getattr(sys, "_base_executable", sys.executable), str(worker_script), "--mode", mode),
        pdfium_library=tmp_path / "pdfium.dll",
        workspace_root=tmp_path / "workspaces",
        inspector_command=(sys.executable, "resource-inspector.py"),
    )
    adapter = ContentWorkerAdapter(config)
    adapter.start(source, session_id="adapter-test")
    return adapter


def test_preparation_token_resolves_only_inside_the_owned_worker_workspace(tmp_path):
    adapter = _adapter(tmp_path)
    adapter.restart(accepted_revision=4)
    lease = adapter.prepare_apply(
        request_id="prepare1", expected_revision=4, target_id="opaque-target",
        accepted_checkpoint_id="checkpoint", accepted_artifact_hash="a" * 64,
        edit={"expectedText": "word", "expectedOldText": "word", "replacementText": "text",
              "utf16Start": 0, "utf16End": 4},
    )
    assert lease.path.read_bytes() == b"verified candidate"
    assert "candidatePath" not in lease.response["result"]
    adapter.close()


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
