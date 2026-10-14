"""Backend-owned lifecycle of the long-lived resource inspector.

The service is a pure accelerator. Whenever it is not ready, has died, or is
disabled, ``endpoint()`` returns ``None`` and workers use the one-shot
inspector exactly as before, so no verification result depends on the service
being up.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import secrets
import subprocess
import threading
from typing import Sequence

from features.edit_content.resource_inspector_service import TOKEN_ENV

logger = logging.getLogger("pdf_manager.edit_content")

READY_TIMEOUT_SECONDS = 60.0
MAX_RESTARTS = 3
DISABLE_ENV = "PDF_MANAGER_EDIT_CONTENT_INSPECTOR_SERVICE"  # "0" turns the service off.


class InspectorServiceManager:
    def __init__(self, command: Sequence[str]):
        self._command = tuple(command)
        self._lock = threading.Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._port: int | None = None
        self._token = ""
        self._starting = False
        self._restarts = 0
        self._stopped = False

    def start_async(self) -> None:
        """Begin launching the service without delaying the caller."""
        with self._lock:
            if self._stopped or self._starting or self._alive_locked():
                return
            if self._restarts > MAX_RESTARTS:
                return
            self._starting = True
            self._restarts += 1
        threading.Thread(target=self._launch, name="edit-content-inspector-service", daemon=True).start()

    def endpoint(self) -> tuple[str, str] | None:
        """Return ``("127.0.0.1:port", token)`` when the service is ready, else None."""
        with self._lock:
            if self._alive_locked() and self._port is not None:
                return f"127.0.0.1:{self._port}", self._token
            starting = self._starting
        if not starting:
            self.start_async()  # A died service is replaced, within the restart budget.
        return None

    def stop(self) -> None:
        with self._lock:
            self._stopped = True
            process, self._process, self._port = self._process, None, None
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()  # The service exits when its owner closes stdin.
            process.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            process.kill()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass

    def _alive_locked(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def _launch(self) -> None:
        process: subprocess.Popen[bytes] | None = None
        try:
            token = secrets.token_hex(32)
            creationflags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
            process = subprocess.Popen(
                self._command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env={**os.environ, TOKEN_ENV: token},
                creationflags=creationflags,
            )
            lines: queue.Queue[bytes] = queue.Queue(maxsize=1)

            def read_ready() -> None:
                assert process is not None and process.stdout is not None
                lines.put(process.stdout.readline())

            threading.Thread(target=read_ready, daemon=True).start()
            ready = json.loads(lines.get(timeout=READY_TIMEOUT_SECONDS))
            port = ready["port"]
            if ready.get("ready") is not True or not isinstance(port, int) or not 0 < port < 65536:
                raise ValueError("invalid readiness message")
            with self._lock:
                if self._stopped:
                    raise RuntimeError("stopped while starting")
                self._process, self._port, self._token = process, port, token
            process = None
        except Exception:  # noqa: BLE001 - the service is optional.
            logger.warning("edit-content inspector service could not start; using one-shot inspector")
        finally:
            if process is not None:
                try:
                    process.kill()
                except OSError:
                    pass
            with self._lock:
                self._starting = False


def service_command(frozen: bool, executable: str) -> tuple[str, ...]:
    if frozen:
        return (executable, "--edit-content-inspector-service")
    return (executable, "-m", "features.edit_content.resource_inspector_service")


def service_enabled() -> bool:
    return os.environ.get(DISABLE_ENV, "1") != "0"
