"""Long-lived read-only resource inspector.

A one-shot inspector pays interpreter (and, when packaged, one-file extraction)
startup on every call. This service pays it once and then answers inspections
over a loopback socket. It performs exactly the same read-only inspection as
``resource_inspector_cli`` and exits as soon as its owner closes its stdin.

Access control: the listener is bound to loopback only and every request must
carry the random token the owner handed over through the environment, so no
other local process can make it read a file.
"""

from __future__ import annotations

import hmac
import json
import os
from pathlib import Path
import socket
import sys
import threading

from features.edit_content.resource_inspector import ReadOnlyResourceInspector

TOKEN_ENV = "EDIT_CONTENT_INSPECTOR_TOKEN"
MAX_REQUEST_BYTES = 64 * 1024
CLIENT_TIMEOUT_SECONDS = 30.0

_UNAVAILABLE = {"supported": False, "error": "resource inspection is unavailable for this document"}


def _read_line(connection: socket.socket) -> bytes | None:
    data = bytearray()
    while len(data) <= MAX_REQUEST_BYTES:
        chunk = connection.recv(4096)
        if not chunk:
            return None
        data.extend(chunk)
        end = data.find(b"\n")
        if end >= 0:
            return bytes(data[:end])
    return None


def answer(request: bytes, token: str, inspector: ReadOnlyResourceInspector) -> dict:
    """Pure request handler: returns the payload to send, never raises."""
    try:
        message = json.loads(request.decode("utf-8"))
        supplied = message.get("token")
        source = message.get("input")
        if not isinstance(supplied, str) or not hmac.compare_digest(supplied.encode(), token.encode()):
            return {"supported": False, "error": "unauthorized"}
        if not isinstance(source, str) or not source:
            return dict(_UNAVAILABLE)
        path = Path(source)
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            return dict(_UNAVAILABLE)
        return inspector.inspect(path).to_payload()
    except Exception:  # noqa: BLE001 - fail closed, the caller treats this as Unsupported.
        return dict(_UNAVAILABLE)


def _serve_connection(connection: socket.socket, token: str, inspector: ReadOnlyResourceInspector) -> None:
    with connection:
        connection.settimeout(CLIENT_TIMEOUT_SECONDS)
        try:
            request = _read_line(connection)
            if request is None:
                return
            payload = answer(request, token, inspector)
            reply = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
            connection.sendall(reply)
        except OSError:
            return


def _exit_when_owner_closes_stdin() -> None:
    try:
        while sys.stdin.buffer.read(4096):
            pass
    except (OSError, ValueError):
        pass
    os._exit(0)


def main() -> int:
    token = os.environ.get(TOKEN_ENV, "")
    if len(token) < 32:
        return 2
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)
    threading.Thread(target=_exit_when_owner_closes_stdin, daemon=True).start()
    inspector = ReadOnlyResourceInspector()
    print(json.dumps({"ready": True, "port": listener.getsockname()[1]}), flush=True)
    while True:
        try:
            connection, _ = listener.accept()
        except OSError:
            return 1
        threading.Thread(
            target=_serve_connection, args=(connection, token, inspector), daemon=True
        ).start()


if __name__ == "__main__":
    raise SystemExit(main())
