"""Feature-owned registry of folders the Merge workspace is reading from.

Folder mode works with files already on disk, so the chosen folder is registered
once and every later request refers to it by an opaque handle. Registering is
what makes containment enforceable: without a recorded root there is nothing to
confine a caller-supplied path to.

The registry is bounded and expires idle entries, but expiry **slides on use**:
every list, inspect, or merge refreshes the entry, so a session the user is
actively working in never lapses. Leaving the workspace releases the entry.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

MAX_ROOTS = 8
ROOT_TTL_SECONDS = 60 * 60


class FolderError(Exception):
    """Raised when a folder cannot be registered or resolved."""


@dataclass
class RootHandle:
    root_id: str
    path: str
    name: str
    last_used: float


class RootRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._roots: dict[str, RootHandle] = {}

    # -- internals ----------------------------------------------------------
    def _expire_locked(self, now: float) -> None:
        stale = [key for key, handle in self._roots.items() if now - handle.last_used >= ROOT_TTL_SECONDS]
        for key in stale:
            self._roots.pop(key, None)

    def _evict_oldest_locked(self) -> None:
        while len(self._roots) >= MAX_ROOTS:
            oldest = min(self._roots.items(), key=lambda item: item[1].last_used)
            self._roots.pop(oldest[0], None)

    # -- public API ---------------------------------------------------------
    def register(self, path: str) -> RootHandle:
        """Register an existing folder and return its handle."""
        candidate = Path(path)
        try:
            if not candidate.is_dir():
                raise FolderError("That folder does not exist or is not a folder.")
            resolved = str(candidate.resolve())
        except FolderError:
            raise
        except OSError as exc:
            raise FolderError(f"That folder cannot be read: {exc}") from exc

        handle = RootHandle(
            root_id=uuid.uuid4().hex,
            path=resolved,
            name=Path(resolved).name or resolved,
            last_used=time.time(),
        )
        with self._lock:
            self._expire_locked(time.time())
            self._evict_oldest_locked()
            self._roots[handle.root_id] = handle
        return handle

    def get(self, root_id: str) -> RootHandle:
        """Resolve a handle, refreshing its idle deadline (sliding expiry)."""
        now = time.time()
        with self._lock:
            self._expire_locked(now)
            handle = self._roots.get(root_id)
            if handle is None:
                raise FolderError("Choose folder again.")
            handle.last_used = now
            return handle

    def release(self, root_id: str) -> bool:
        with self._lock:
            return self._roots.pop(root_id, None) is not None

    def release_all(self) -> int:
        with self._lock:
            count = len(self._roots)
            self._roots.clear()
        return count

    def count(self) -> int:
        with self._lock:
            return len(self._roots)


registry = RootRegistry()
