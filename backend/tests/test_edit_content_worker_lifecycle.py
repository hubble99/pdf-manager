"""Actual Windows process-tree containment, using the pinned native worker."""

import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time

import pytest
from pypdf import PdfWriter


@pytest.mark.skipif(os.name != "nt" or not os.environ.get("EDIT_CONTENT_TEST_PDFIUM_PATH"),
                    reason="requires Windows and the explicitly selected pinned PDFium artifact")
def test_parent_exit_stops_worker_and_active_inspector(tmp_path):
    root = Path(__file__).resolve().parents[2]
    worker_path = Path(os.environ.get("EDIT_CONTENT_TEST_WORKER", root / "native/edit-content-engine/target/debug/edit-content-engine.exe"))
    library = Path(os.environ["EDIT_CONTENT_TEST_PDFIUM_PATH"])
    source = tmp_path / "source.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(source)
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    (tmp_path / "workspaces").mkdir()
    inspector_pid_file = tmp_path / "inspector.pid"
    inspector_code = "import ctypes,json,os,sys,time; from pathlib import Path; p=Path(sys.argv[1]); t=p.with_suffix('.tmp'); t.write_text(json.dumps({'pid': os.getpid(), 'console': ctypes.windll.kernel32.GetConsoleWindow()})); t.replace(p); time.sleep(60)"
    owner = subprocess.Popen([sys._base_executable, "-c", "import time; time.sleep(60)"],
                             creationflags=subprocess.CREATE_NO_WINDOW)
    worker = None
    inspector_handle = None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    try:
        worker = subprocess.Popen([
            str(worker_path), "--pdfium-library", str(library), "--session-id", "lifecycle-test",
            "--workspace-root", str(tmp_path / "workspaces"), "--source-file", str(source),
            "--parent-process-id", str(owner.pid), "--inspector-program", sys._base_executable,
            "--inspector-arg", "-c", "--inspector-arg", inspector_code,
            "--inspector-arg", str(inspector_pid_file),
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW)
        for command in ("open", "inspect"):
            request = {"schemaVersion": "edit-content-request/v1", "sessionId": "lifecycle-test",
                       "requestId": command, "command": command, "payload": {}}
            if command == "inspect":
                request["expectedAcceptedRevision"] = 0
            payload = json.dumps(request).encode()
            worker.stdin.write(struct.pack(">I", len(payload)) + payload)
            worker.stdin.flush()
        deadline = time.monotonic() + 10
        while not inspector_pid_file.exists() and time.monotonic() < deadline and worker.poll() is None:
            time.sleep(0.02)
        assert inspector_pid_file.exists(), "worker did not start the inspector"
        inspector_info = json.loads(inspector_pid_file.read_text())
        inspector_handle = kernel.OpenProcess(0x00100000 | 0x0001, False, inspector_info["pid"])
        assert inspector_handle
        assert inspector_info["console"] == 0, "background inspector opened a console window"
        owner.terminate()
        owner.wait(3)
        worker.wait(5)
        assert kernel.WaitForSingleObject(inspector_handle, 3000) == 0, "inspector survived the worker's parent exit"
        assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    finally:
        if inspector_handle:
            kernel.TerminateProcess(inspector_handle, 1)
            kernel.CloseHandle(inspector_handle)
        if worker is not None:
            if worker.poll() is None:
                worker.kill()
            worker.communicate(timeout=5)
        if owner.poll() is None:
            owner.kill()
        owner.wait(3)
