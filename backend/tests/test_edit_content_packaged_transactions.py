"""Real frozen Windows sidecar transactions; no verifier or fault bypasses."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import ctypes
import hashlib
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
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

from features.edit_content.resource_inspector import ReadOnlyResourceInspector
from features.edit_content.transaction_state import REQUIRED_CHECKS

pytestmark = pytest.mark.skipif(os.name != "nt" or not os.environ.get("EDIT_CONTENT_TEST_SIDECAR"),
    reason="requires an explicitly selected frozen Windows sidecar")
PREFIX = "/api/v1/edit-content"


def synthetic_pdf(pages=2):
    writer = PdfWriter()
    font = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica"),
        NameObject("/Encoding"): NameObject("/WinAnsiEncoding")}))
    for _ in range(pages):
        page = writer.add_blank_page(width=200, height=200)
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"):
            DictionaryObject({NameObject("/F1"): font})})
        content = DecodedStreamObject()
        content.set_data(b"BT /F1 12 Tf 30 100 Td (word) Tj ET BT /F1 12 Tf 30 70 Td (kept) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(content)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def digest(data):
    return hashlib.sha256(data).hexdigest()


class PackagedBackend:
    def __init__(self, root):
        self.root = Path(root).absolute()
        self.root.mkdir(parents=True, exist_ok=True)
        self.process = None
        self.token = uuid.uuid4().hex
        self.client = None

    def start(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        environment = dict(os.environ, HOST="127.0.0.1", PORT=str(port), LOG_LEVEL="WARNING",
            TEMP_DIR=str(self.root / "temp"), OUTPUT_DIR=str(self.root / "output"),
            APP_DATA_DIR=str(self.root / "data"), PDF_MANAGER_DESKTOP_LIFECYCLE_TOKEN=self.token,
            PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR=os.environ["EDIT_CONTENT_TEST_RESOURCE_DIR"])
        for key in ("PDF_MANAGER_EDIT_CONTENT_WORKER", "PDF_MANAGER_PDFIUM_LIBRARY"):
            environment.pop(key, None)
        self.log = (self.root / "sidecar.log").open("ab")
        self.process = subprocess.Popen([os.environ["EDIT_CONTENT_TEST_SIDECAR"]], cwd=self.root,
            env=environment, stdout=self.log, stderr=self.log, creationflags=subprocess.CREATE_NO_WINDOW)
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=150)
        deadline = time.monotonic() + 40
        while True:
            assert self.process.poll() is None, "packaged backend exited at startup"
            try:
                if self.client.get("/health", timeout=0.5).status_code == 200:
                    return self
            except httpx.TransportError:
                pass
            assert time.monotonic() < deadline, "packaged startup timed out"
            time.sleep(0.1)

    def stop(self, *, graceful=True):
        try:
            if self.process is not None and self.process.poll() is None:
                if graceful:
                    response = self.client.post(PREFIX + "/shutdown", headers={"X-PDF-Manager-Lifecycle": self.token})
                    assert response.status_code == 200, response.text
                # Terminate only our bootloader tree after the app's normal
                # shutdown hook, or deliberately during a crash probe.
                subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                    capture_output=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
                # A child can exit via the parent watcher while taskkill is
                # enumerating the tree. The owned process handle is the oracle,
                # not taskkill's aggregate status for already-exited children.
                self.process.wait(timeout=10)
        finally:
            if self.client is not None:
                self.client.close()
            self.log.close()
            if self.process is not None and self.process.poll() is not None:
                self.process = None

    def open(self, content):
        response = self.client.post(PREFIX + "/sessions", data={"schemaVersion": "edit-content-request/v1",
            "requestId": uuid.uuid4().hex, "command": "open"},
            files={"file": ("synthetic.pdf", content, "application/pdf")})
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["status"] == "accepted", result
        return result

    def command(self, session, command, revision, payload=None, target=None, request_id=None):
        envelope = {"schemaVersion": "edit-content-request/v1", "sessionId": session,
            "requestId": request_id or uuid.uuid4().hex, "command": command,
            "expectedAcceptedRevision": revision, "payload": payload or {}}
        if target:
            envelope["targetId"] = target
        route = "objects" if command == "inspect" else command
        response = self.client.post(f"{PREFIX}/sessions/{session}/{route}", json=envelope)
        assert response.status_code == 200, response.text
        return response.json()

    def download(self, session, output):
        response = self.client.get(f"{PREFIX}/sessions/{session}/outputs/{output}")
        assert response.status_code == 200, response.text
        return response.content

    def record(self, session):
        return self.root / "data" / "edit-content-sessions" / session / "record.json"

    def canvas_healthy(self, source):
        assert self.client.get("/health").status_code == 200
        # Exercise the unchanged Canvas save route using only our synthetic
        # document and isolated output directory, not user data or Canvas code.
        annotations = json.dumps([""] * len(PdfReader(io.BytesIO(source)).pages)).encode()
        response = self.client.post("/api/v1/edit-canvas/save", files={
            "file": ("source.pdf", source, "application/pdf"),
            "annotations": ("annotations.json", annotations, "application/json")})
        assert response.status_code == 200, response.text
        assert len(PdfReader(io.BytesIO(response.content)).pages) == len(PdfReader(io.BytesIO(source)).pages)


@pytest.fixture
def packaged(tmp_path):
    backend = PackagedBackend(tmp_path)
    try:
        yield backend.start()
    finally:
        if backend.process is not None:
            backend.stop()


def target_for(backend, session, revision=0):
    reply = backend.command(session, "inspect", revision)
    assert reply["status"] == "accepted", reply
    return reply["result"]["discovery"]["textObjects"][0]


EDIT = {"expectedText": "word", "expectedOldText": "word", "replacementText": "text",
        "utf16Start": 0, "utf16End": 4}


@pytest.mark.parametrize("joint_save", [False, True])
def test_packaged_verified_transaction_reopen_and_shutdown_download(packaged, joint_save):
    source = synthetic_pdf()
    session = packaged.open(source)["sessionId"]
    target = target_for(packaged, session)
    reply = packaged.command(session, "save" if joint_save else "apply", 0,
        {"draft" if joint_save else "edit": EDIT}, target["targetId"], request_id="edit")
    assert reply["status"] == "accepted", reply
    if not joint_save:
        assert reply["result"]["outputId"] is None
        reply = packaged.command(session, "save", 1, request_id="save")
        assert reply["status"] == "accepted", reply
    output_id = reply["result"]["outputId"]
    output = packaged.download(session, output_id)
    record = json.loads(packaged.record(session).read_bytes())["state"]
    assert record["revision"] == 1
    assert set(record["checkpoints"][-1]["edit"]["checks"]) == REQUIRED_CHECKS
    assert record["source"]["source_hash"] == digest(source)
    assert record["saved_hash"] == digest(output)
    reader = PdfReader(io.BytesIO(output))
    assert len(reader.pages) == 2
    assert [page.extract_text() for page in reader.pages] == ["text\nkept", "word\nkept"]
    saved = packaged.root / "verified-output.pdf"
    saved.write_bytes(output)
    before = packaged.root / "original.pdf"
    before.write_bytes(source)
    inspector = ReadOnlyResourceInspector()
    original_resources, resources = inspector.inspect(before).to_payload(), inspector.inspect(saved).to_payload()
    assert original_resources["supported"] and resources["supported"]
    for original, regenerated in zip(original_resources["pages"], resources["pages"], strict=True):
        assert original["pagePreservation"] == regenerated["pagePreservation"]
        assert original["preservationResources"] == regenerated["preservationResources"]
        assert {font["semanticSha256"] for font in original["fonts"]} == {
            font["semanticSha256"] for font in regenerated["fonts"]}
    old_target = target_for(packaged, session, 1)["targetId"]
    packaged.stop()
    packaged.start()
    assert packaged.download(session, output_id) == output
    restored = target_for(packaged, session, 1)
    assert restored["text"] == "text" and restored["targetId"] != old_target
    assert json.loads(packaged.record(session).read_bytes())["state"] == record
    reopened = packaged.open(output)
    assert target_for(packaged, reopened["sessionId"])["text"] == "text"
    packaged.canvas_healthy(source)


def test_packaged_guard_rejection_rotates_target_without_committing(packaged):
    source = synthetic_pdf()
    opened = packaged.open(source)
    session = opened["sessionId"]
    target = opened["result"]["discovery"]["textObjects"][0]
    original_target = target["targetId"]

    unsupported = {
        "expectedText": "word", "expectedOldText": "word", "replacementText": "Rőtated",
        "utf16Start": 0, "utf16End": 4,
    }
    rejected = packaged.command(
        session, "apply", 0, {"edit": unsupported}, original_target, request_id="guard-rejected",
    )
    assert rejected["status"] == "rejected"
    assert rejected["guardReason"] == "REJECTED_UNSUPPORTED_GLYPH"

    record = json.loads(packaged.record(session).read_bytes())["state"]
    assert record["revision"] == 0
    assert record["outcomes"] == []
    assert record["publications"] == []
    assert len(record["checkpoints"]) == 1
    assert record["source"]["source_hash"] == digest(source)

    stale = packaged.command(
        session, "apply", 0, {"edit": EDIT}, original_target, request_id="stale-retry",
    )
    assert stale["status"] == "rejected"
    assert stale["guardReason"] == "REJECTED_STALE_REVISION"

    fresh_target = target_for(packaged, session)
    assert fresh_target["targetId"] != original_target
    accepted = packaged.command(
        session, "apply", 0, {"edit": EDIT}, fresh_target["targetId"], request_id="fresh-retry",
    )
    assert accepted["status"] == "accepted"
    assert accepted["acceptedRevision"] == 1


@contextmanager
def deny_record_rename(path):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                       ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    create.restype = ctypes.c_void_p
    close = kernel.CloseHandle
    close.argtypes = [ctypes.c_void_p]
    close.restype = ctypes.c_int
    handle = create(str(path), 0x80000000, 3, None, 3, 0, None)  # read/write share, deliberately no DELETE share
    assert handle not in (None, ctypes.c_void_p(-1).value), ctypes.WinError(ctypes.get_last_error())
    try:
        yield
    finally:
        assert close(handle)


@contextmanager
def pause_owned_worker(workspace, session):
    marker = json.loads((workspace / ".owner.json").read_bytes())
    assert marker["owner"] == "edit-content-engine" and marker["sessionId"] == session
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    open_process = kernel.OpenProcess
    open_process.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    open_process.restype = ctypes.c_void_p
    handle = open_process(0x0800, 0, marker["processId"])  # PROCESS_SUSPEND_RESUME, only our fixture worker
    assert handle, ctypes.WinError(ctypes.get_last_error())
    native = ctypes.WinDLL("ntdll")
    for name in ("NtSuspendProcess", "NtResumeProcess"):
        getattr(native, name).argtypes = [ctypes.c_void_p]
        getattr(native, name).restype = ctypes.c_long
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    try:
        assert native.NtSuspendProcess(handle) == 0
        yield
    finally:
        native.NtResumeProcess(handle)  # Harmless if taskkill already ended this owned process.
        kernel.CloseHandle(handle)


def test_packaged_rename_failure_preserves_entire_last_good_state(packaged):
    source = synthetic_pdf()
    session = packaged.open(source)["sessionId"]
    saved = packaged.command(session, "save", 0)
    output_id = saved["result"]["outputId"]
    target = target_for(packaged, session)
    old_record = packaged.record(session).read_bytes()
    with deny_record_rename(packaged.record(session)):
        reply = packaged.command(session, "save", 0, {"draft": EDIT}, target["targetId"])
    assert reply["status"] == "rejected", reply
    assert packaged.record(session).read_bytes() == old_record
    assert packaged.download(session, output_id) == source
    assert target_for(packaged, session)["text"] == "word"
    packaged.canvas_healthy(source)


def test_packaged_committed_response_loss_recovers_without_replay(packaged):
    source = synthetic_pdf()
    session = packaged.open(source)["sessionId"]
    target = target_for(packaged, session)
    request_id = "lost-save-response"
    envelope = {"schemaVersion": "edit-content-request/v1", "sessionId": session,
        "requestId": request_id, "command": "save", "expectedAcceptedRevision": 0,
        "targetId": target["targetId"], "payload": {"draft": EDIT}}
    payload = json.dumps(envelope).encode()
    # Send normally but never consume the response. Commit, not receipt by this
    # client, determines the outcome after the backend is restarted.
    with socket.create_connection(("127.0.0.1", packaged.client.base_url.port), timeout=10) as connection:
        connection.sendall((f"POST {PREFIX}/sessions/{session}/save HTTP/1.1\r\n"
            f"Host: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\n"
            "Connection: close\r\n\r\n").encode() + payload)
        deadline = time.monotonic() + 120
        while True:
            record = json.loads(packaged.record(session).read_bytes())["state"]
            if record["revision"] == 1:
                break
            assert time.monotonic() < deadline, "joint Save never committed"
            time.sleep(0.01)
    packaged.stop(graceful=False)
    packaged.start()
    restored = target_for(packaged, session, 1)
    assert restored["text"] == "text" and restored["targetId"] != target["targetId"]
    replay = packaged.command(session, "save", 0, {"draft": EDIT}, target["targetId"], request_id)
    assert replay["status"] == "accepted", replay
    assert replay["result"]["outputId"] == record["last_output_id"]
    assert json.loads(packaged.record(session).read_bytes())["state"] == record
    assert digest(packaged.download(session, record["last_output_id"])) == record["saved_hash"]
    packaged.canvas_healthy(source)


@pytest.mark.parametrize("command", ["apply", "save"])
def test_packaged_interrupted_precommit_recovers_last_good_and_cleans_orphan(packaged, command):
    source = synthetic_pdf(8)
    session = packaged.open(source)["sessionId"]
    saved = packaged.command(session, "save", 0)
    output_id = saved["result"]["outputId"]
    target = target_for(packaged, session)
    old_record = packaged.record(session).read_bytes()
    # Block only the final OS rename while observing the candidate. Suspending
    # the owned worker makes interruption deterministic even on a busy host;
    # no verifier is bypassed or production fault-injection switch is added.
    with deny_record_rename(packaged.record(session)), ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(packaged.command, session, command, 0,
            {"draft" if command == "save" else "edit": EDIT}, target["targetId"], "interrupted")
        worker_root = packaged.root / "data" / "edit-content-worker"
        deadline = time.monotonic() + 90
        candidates = []
        while not candidates:
            assert not pending.done(), pending.result() if pending.done() else ""
            candidates = list(worker_root.glob("edit-content-*/staging/candidate-*.pdf"))
            assert time.monotonic() < deadline, "candidate boundary was not observed"
            time.sleep(0.01)
        assert packaged.record(session).read_bytes() == old_record
        orphan = candidates[0].parent.parent
        with pause_owned_worker(orphan, session):
            assert packaged.client.get("/health", timeout=2).status_code == 200
            cancellation = packaged.client.post(
                f"{PREFIX}/sessions/{session}/requests/interrupted/cancel", timeout=2)
            assert cancellation.status_code == 200 and cancellation.json()["status"] == "accepted"
            packaged.stop(graceful=False)
        try:
            pending.result(timeout=10)
        except httpx.TransportError:
            pass
    assert packaged.record(session).read_bytes() == old_record
    packaged.start()
    assert target_for(packaged, session)["text"] == "word"
    assert not orphan.exists()
    assert packaged.download(session, output_id) == source
    assert packaged.record(session).read_bytes() == old_record
    packaged.canvas_healthy(source)
