"""
PDF Manager Backend — Utility Functions
"""
import re
import uuid
import shutil
from pathlib import Path
from fastapi import UploadFile
from config import settings


async def save_upload(upload: UploadFile, subdir: str = "uploads") -> Path:
    """Save an uploaded file to the temp directory. Returns the saved path."""
    dest_dir = settings.TEMP_DIR / subdir
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Use a UUID prefix to avoid filename collisions
    safe_name = f"{uuid.uuid4().hex}_{upload.filename}"
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


def sanitize_filename(name: str, extension: str = "pdf") -> str:
    """
    Sanitize a user-supplied filename stem and append the given extension.

    Rules:
    - Strip path-traversal / illegal filesystem characters.
    - Collapse whitespace runs to a single underscore.
    - Strip leading/trailing dots, underscores, and spaces.
    - Remove any existing trailing extension that matches (case-insensitive).
    - Fall back to "output" if result is empty after sanitisation.
    - Always returns "<safe_name>.<extension>" (lowercase extension).

    Args:
        name:      Desired filename, with or without extension.
        extension: Target file extension WITHOUT the leading dot (default "pdf").

    Returns:
        A clean filename string, e.g. "my_document.pdf".
    """
    ext_lower = extension.lower().lstrip(".")

    # Strip the extension suffix if the caller included it
    if name.lower().endswith(f".{ext_lower}"):
        name = name[: -(len(ext_lower) + 1)]

    # Remove characters illegal on Windows / POSIX filesystems
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)

    # Collapse consecutive whitespace / underscores
    name = re.sub(r'[\s_]+', "_", name)

    # Strip leading/trailing dots, underscores, spaces
    name = name.strip("._- ")

    if not name:
        name = "output"

    return f"{name}.{ext_lower}"


def sanitize_stem(name: str) -> str:
    """
    Sanitize a filename stem (no extension) — remove illegal chars and collapse whitespace.
    Used when we want to name files inside ZIPs or images without an extension suffix.

    Args:
        name: Raw stem string (e.g. "My Document" or "report.pdf")

    Returns:
        A clean stem string, e.g. "My_Document" or "report"
    """
    # Strip common extensions like .pdf, .png etc. if accidentally included
    name = re.sub(r'\.[a-zA-Z0-9]{2,5}$', '', name)
    # Remove characters illegal on Windows / POSIX
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name)
    # Collapse consecutive whitespace / underscores
    name = re.sub(r'[\s_]+', '_', name)
    # Strip leading/trailing dots, underscores, spaces
    name = name.strip('._- ')
    return name or 'output'
