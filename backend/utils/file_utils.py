"""
PDF Manager Backend — Utility Functions
"""
import re
import uuid
import shutil
from pathlib import Path
from fastapi import UploadFile
from config import settings
from utils.filename_utils import sanitize_filename, sanitize_stem

__all__ = [
    "cleanup_temp_file",
    "get_file_info",
    "sanitize_filename",
    "sanitize_stem",
    "save_upload",
]


async def save_upload(upload: UploadFile, subdir: str = "uploads") -> Path:
    """
    Save an uploaded file to the temp directory. Returns the saved path.

    Security: Strips path separators from the uploaded filename to prevent
    directory traversal attacks (e.g., `../../evil.pdf`).
    """
    dest_dir = settings.TEMP_DIR / subdir
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Treat both slash styles as separators on every host OS. Path.name alone
    # does not strip Windows backslashes when the backend runs on POSIX.
    basename = re.split(r"[\\/]", upload.filename or "upload")[-1] or "upload"

    # Use a UUID prefix to avoid filename collisions
    safe_name = f"{uuid.uuid4().hex}_{basename}"
    dest_path = dest_dir / safe_name

    with dest_path.open("wb") as f:
        content = await upload.read()
        f.write(content)

    return dest_path


def cleanup_temp_file(path: Path) -> None:
    """Delete a temp file if it exists."""
    try:
        if path.exists():
            path.unlink()
    except Exception:
        pass  # Best-effort cleanup


def get_file_info(path: Path) -> dict:
    """Return basic file metadata."""
    return {
        "filename": path.name,
        "size_bytes": path.stat().st_size,
        "path": str(path),
    }
