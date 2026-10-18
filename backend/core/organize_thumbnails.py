"""Render low-resolution page thumbnails for the Organize workspace.

Thumbnails exist only so a page can be recognised, so they are rendered small and
served in bounded batches. A single request for every page of a large document
would be an oversized response, and one request per page would be thousands of
round trips; a bounded batch keeps both under control and lets the workspace fill
the grid progressively.
"""
from __future__ import annotations

import base64
import io
import logging
from pathlib import Path

import fitz

from core import render_color  # noqa: F401  (switches on ICC colour management)
from PIL import Image, ImageOps

logger = logging.getLogger("pdf_manager.core.organize_thumbnails")

DEFAULT_TARGET_WIDTH = 150
DEFAULT_BATCH = 24
MAX_BATCH = 48
MIN_TARGET_WIDTH = 48
MAX_TARGET_WIDTH = 400


class ThumbnailError(Exception):
    """Raised when a thumbnail batch cannot be rendered."""


def _clamp_target_width(target_width: int) -> int:
    if not isinstance(target_width, int) or isinstance(target_width, bool):
        raise ThumbnailError("The thumbnail width must be a whole number.")
    return max(MIN_TARGET_WIDTH, min(MAX_TARGET_WIDTH, target_width))


def _png_data(image: Image.Image) -> tuple[str, int, int]:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii"), image.width, image.height


def render_pdf_batch(
    path: Path,
    start: int,
    count: int,
    target_width: int,
) -> dict:
    with fitz.open(str(path)) as document:
        total = document.page_count
        if start < 1 or start > total:
            raise ThumbnailError(f"Page {start} is out of range (the document has {total} pages).")
        last = min(total, start + count - 1)

        pages = []
        for page_number in range(start, last + 1):
            page = document[page_number - 1]
            page_width = page.rect.width or target_width
            zoom = target_width / page_width
            pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            pages.append({
                "page": page_number,
                "data": base64.b64encode(pixmap.tobytes("png")).decode("ascii"),
                "width": pixmap.width,
                "height": pixmap.height,
            })

    return {"start": start, "count": len(pages), "total": total, "pages": pages}


def render_image_batch(
    path: Path,
    start: int,
    count: int,
    target_width: int,
) -> dict:
    if start != 1:
        raise ThumbnailError("An image has a single page.")

    try:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source)
            image.load()
    except Exception as exc:
        raise ThumbnailError(f"Cannot read image: {exc}") from exc

    ratio = target_width / (image.width or target_width)
    preview = image.resize(
        (max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
        Image.LANCZOS,
    )
    data, width, height = _png_data(preview)
    return {
        "start": 1,
        "count": 1,
        "total": 1,
        "pages": [{"page": 1, "data": data, "width": width, "height": height}],
    }


def render_batch(
    path: Path,
    kind: str,
    start: int = 1,
    count: int = DEFAULT_BATCH,
    target_width: int = DEFAULT_TARGET_WIDTH,
) -> dict:
    """Render up to ``count`` thumbnails starting at one-based page ``start``."""
    if not isinstance(start, int) or isinstance(start, bool) or start < 1:
        raise ThumbnailError("The starting page must be a whole number of at least 1.")
    if not isinstance(count, int) or isinstance(count, bool):
        raise ThumbnailError("The batch size must be a whole number.")
    if count < 1:
        raise ThumbnailError("The batch size must be at least 1.")
    if count > MAX_BATCH:
        raise ThumbnailError(f"A thumbnail batch can request at most {MAX_BATCH} pages.")

    width = _clamp_target_width(target_width)
    if kind == "image":
        return render_image_batch(path, start, count, width)
    return render_pdf_batch(path, start, count, width)
