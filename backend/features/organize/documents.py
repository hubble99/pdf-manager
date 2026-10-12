"""Feature-owned registry of documents uploaded for the Organize workspace.

The workspace renders thumbnails in many bounded batches and assembles from the
same documents on save, so a document is uploaded once and referenced afterwards
by an opaque handle. The registry is bounded in both size and age so an
abandoned session cannot retain temporary files indefinitely.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import fitz
from PIL import Image

# A workspace session holds at most a handful of files; the bound only exists to
# stop an abandoned or hostile session from filling the temp directory.
MAX_DOCUMENTS = 32
# Idle lifetime of an uploaded document. Long enough for a real editing session.
DOCUMENT_TTL_SECONDS = 60 * 60

PDF_SUFFIXES = {".pdf"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


class DocumentError(Exception):
    """Raised when a document cannot be registered or resolved."""


@dataclass
class DocumentHandle:
    document_id: str
    path: Path
    name: str
    kind: str  # "pdf" | "image"
    page_count: int
    last_used: float


class DocumentRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._documents: dict[str, DocumentHandle] = {}

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _delete(path: Path) -> None:
        try:
            if path.exists():
                path.unlink()
        except OSError:
            pass  # best effort, as elsewhere in the backend

    def _expire_locked(self, now: float) -> None:
        stale = [key for key, handle in self._documents.items() if now - handle.last_used >= DOCUMENT_TTL_SECONDS]
        for key in stale:
            self._delete(self._documents.pop(key).path)

    def _evict_oldest_locked(self) -> None:
        while len(self._documents) >= MAX_DOCUMENTS:
            oldest = min(self._documents.items(), key=lambda item: item[1].last_used)
            self._delete(self._documents.pop(oldest[0]).path)

    # -- public API ---------------------------------------------------------
    def register(self, path: Path, name: str) -> DocumentHandle:
        """Validate the uploaded file and record it under a new handle."""
        suffix = Path(name).suffix.lower()
        kind: str
        page_count: int

        if suffix in PDF_SUFFIXES:
            kind = "pdf"
            try:
                with fitz.open(str(path)) as document:
                    if document.is_encrypted:
                        raise DocumentError("The PDF is encrypted and cannot be organized.")
                    page_count = document.page_count
            except DocumentError:
                raise
            except Exception as exc:
                raise DocumentError(f"Cannot open PDF: {exc}") from exc
            if page_count < 1:
                raise DocumentError("The PDF has no pages.")
        elif suffix in IMAGE_SUFFIXES:
            kind = "image"
            page_count = 1
            try:
                with Image.open(path) as image:
                    image.verify()
            except Exception as exc:
                raise DocumentError(f"Cannot open image: {exc}") from exc
        else:
            raise DocumentError("Use a PDF or a JPG, JPEG, PNG, WEBP, BMP, or TIFF image.")

        handle = DocumentHandle(
            document_id=uuid.uuid4().hex,
            path=path,
            name=name,
            kind=kind,
            page_count=page_count,
            last_used=time.time(),
        )
        with self._lock:
            self._expire_locked(time.time())
            self._evict_oldest_locked()
            self._documents[handle.document_id] = handle
        return handle

    def get(self, document_id: str) -> DocumentHandle:
        """Resolve a handle, refreshing its idle lifetime."""
        now = time.time()
        with self._lock:
            self._expire_locked(now)
            handle = self._documents.get(document_id)
            if handle is None:
                raise DocumentError("That document is no longer available. Add the file again.")
            handle.last_used = now
            return handle

    def release(self, document_id: str) -> bool:
        with self._lock:
            handle = self._documents.pop(document_id, None)
        if handle is None:
            return False
        self._delete(handle.path)
        return True

    def release_all(self) -> int:
        with self._lock:
            handles = list(self._documents.values())
            self._documents.clear()
        for handle in handles:
            self._delete(handle.path)
        return len(handles)

    def count(self) -> int:
        with self._lock:
            return len(self._documents)


registry = DocumentRegistry()
