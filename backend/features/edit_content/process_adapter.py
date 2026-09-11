"""Private framed-process adapter for the phase-2 Edit Content worker."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import queue
import struct
import subprocess
import threading
from typing import Any, Sequence
import uuid


REQUEST_SCHEMA = "edit-content-request/v1"
REPLY_SCHEMA = "edit-content-reply/v1"
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_REPLY_BYTES = 16 * 1024 * 1024


class ContentWorkerError(RuntimeError):
    """Safe adapter failure that never includes private paths or worker stderr."""


@dataclass(frozen=True)
class WorkerLaunchConfig:
    worker_command: tuple[str, ...]
    pdfium_library: Path
    workspace_root: Path
    inspector_command: tuple[str, ...]
    startup_timeout_seconds: float = 10.0
    inspect_timeout_seconds: float = 30.0
    close_timeout_seconds: float = 10.0

    @classmethod
    def create(
        cls,
        *,
        worker_command: Sequence[str],
        pdfium_library: Path,
        workspace_root: Path,
        inspector_command: Sequence[str],
    ) -> "WorkerLaunchConfig":
        if not worker_command or not inspector_command:
            raise ValueError("worker and inspector commands are required")
        return cls(
            tuple(str(part) for part in worker_command),
            Path(pdfium_library),
            Path(workspace_root),
            tuple(str(part) for part in inspector_command),
        )


class ContentWorkerAdapter:
    """Owns one Content worker process and one in-flight framed command."""

    def __init__(self, config: WorkerLaunchConfig):
        self._config = config
        self._process: subprocess.Popen[bytes] | None = None
        self._replies: queue.Queue[dict[str, Any] | BaseException] = queue.Queue(maxsize=1)
        self._lock = threading.Lock()
        self._session_id: str | None = None
        self._source: Path | None = None

    @property
    def process_id(self) -> int | None:
        return self._process.pid if self._process is not None else None

    @property
    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def start(self, source: Path, *, session_id: str | None = None) -> str:
        with self._lock:
            if self.is_running:
                raise ContentWorkerError("Content worker is already running")
            if self._process is not None:
                self._clear_process()
            source_path = Path(source)
            if source_path.is_symlink() or not source_path.is_file():
                raise ContentWorkerError("Content source is unavailable")
            self._config.workspace_root.mkdir(parents=True, exist_ok=True)
            active_session = session_id or uuid.uuid4().hex
            inspector_program, *inspector_args = self._config.inspector_command
            command = [
                *self._config.worker_command,
                "--pdfium-library",
                str(self._config.pdfium_library),
                "--session-id",
                active_session,
                "--workspace-root",
                str(self._config.workspace_root),
                "--source-file",
                str(source_path),
                "--inspector-program",
                inspector_program,
            ]
            for argument in inspector_args:
                command.extend(("--inspector-arg", argument))
            creationflags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
            try:
                process = subprocess.Popen(
                    command,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                    creationflags=creationflags,
                )
            except OSError as exc:
                raise ContentWorkerError("Content worker could not be started") from exc
            self._process = process
            self._session_id = active_session
            self._source = source_path
            self._replies = queue.Queue(maxsize=1)
            threading.Thread(target=self._read_replies, args=(process,), daemon=True).start()
            threading.Thread(target=self._drain_stderr, args=(process,), daemon=True).start()
            return active_session

    def open(self) -> dict[str, Any]:
        return self._request("open", expected_revision=None, timeout=self._config.startup_timeout_seconds)

    def inspect(self) -> dict[str, Any]:
        return self._request("inspect", expected_revision=0, timeout=self._config.inspect_timeout_seconds)

    def close(self) -> dict[str, Any]:
        with self._lock:
            process = self._process
            if process is None:
                return {"status": "closed"}
        try:
            reply = self._request(
                "close", expected_revision=0, timeout=self._config.close_timeout_seconds
            )
            try:
                process.wait(timeout=self._config.close_timeout_seconds)
            except subprocess.TimeoutExpired as exc:
                self._terminate(process)
                raise ContentWorkerError("Content worker did not close cleanly") from exc
            if process.returncode != 0:
                raise ContentWorkerError("Content worker did not close cleanly")
            return reply
        finally:
            with self._lock:
                if self._process is process:
                    self._clear_process()

    def restart(self, source: Path | None = None) -> dict[str, Any]:
        previous_source = Path(source) if source is not None else self._source
        previous_session = self._session_id
        if previous_source is None:
            raise ContentWorkerError("Content source is unavailable")
        process = self._process
        if process is not None:
            if process.poll() is None:
                try:
                    self.close()
                except ContentWorkerError:
                    self._terminate(process)
            else:
                with self._lock:
                    self._clear_process()
        self.start(previous_source, session_id=previous_session)
        return self.open()

    def terminate(self) -> None:
        with self._lock:
            process = self._process
        if process is not None:
            self._terminate(process)
        with self._lock:
            if self._process is process:
                self._clear_process()

    def _request(
        self,
        command: str,
        *,
        expected_revision: int | None,
        timeout: float,
    ) -> dict[str, Any]:
        with self._lock:
            process = self._process
            session_id = self._session_id
            if process is None or session_id is None or process.poll() is not None:
                raise ContentWorkerError("Content worker is unavailable")
            request_id = uuid.uuid4().hex
            envelope: dict[str, Any] = {
                "schemaVersion": REQUEST_SCHEMA,
                "requestId": request_id,
                "sessionId": session_id,
                "command": command,
                "payload": {},
            }
            if expected_revision is not None:
                envelope["expectedAcceptedRevision"] = expected_revision
            payload = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
            if len(payload) > MAX_REQUEST_BYTES:
                raise ContentWorkerError("Content request exceeds the configured limit")
            try:
                assert process.stdin is not None
                process.stdin.write(struct.pack(">I", len(payload)))
                process.stdin.write(payload)
                process.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise ContentWorkerError("Content worker is unavailable") from exc
            try:
                outcome = self._replies.get(timeout=timeout)
            except queue.Empty as exc:
                self._terminate(process)
                raise ContentWorkerError("Content worker command timed out") from exc
            if isinstance(outcome, BaseException):
                raise ContentWorkerError("Content worker is unavailable") from outcome
            if (
                outcome.get("schemaVersion") != REPLY_SCHEMA
                or outcome.get("requestId") != request_id
                or outcome.get("sessionId") != session_id
            ):
                self._terminate(process)
                raise ContentWorkerError("Content worker returned an invalid reply")
            return outcome

    def _read_replies(self, process: subprocess.Popen[bytes]) -> None:
        try:
            assert process.stdout is not None
            while True:
                header = _read_exact(process.stdout, 4)
                if header is None:
                    raise EOFError
                length = struct.unpack(">I", header)[0]
                if length == 0 or length > MAX_REPLY_BYTES:
                    raise ValueError
                payload = _read_exact(process.stdout, length)
                if payload is None:
                    raise EOFError
                reply = json.loads(payload)
                if not isinstance(reply, dict):
                    raise ValueError
                self._replies.put(reply)
        except BaseException as exc:
            try:
                self._replies.put_nowait(exc)
            except queue.Full:
                pass

    @staticmethod
    def _drain_stderr(process: subprocess.Popen[bytes]) -> None:
        if process.stderr is None:
            return
        while process.stderr.read(4096):
            pass

    @staticmethod
    def _terminate(process: subprocess.Popen[bytes]) -> None:
        if process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)

    def _clear_process(self) -> None:
        process = self._process
        if process is not None:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
        self._process = None


def _read_exact(stream: Any, length: int) -> bytes | None:
    data = bytearray()
    while len(data) < length:
        chunk = stream.read(length - len(data))
        if not chunk:
            return None
        data.extend(chunk)
    return bytes(data)
