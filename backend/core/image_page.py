"""Prepare an image as a single PDF page.

The workspace inserts an image at its own size, with no fitting to a standard
page, so a rotated image's page follows the rotated image's dimensions. That
matches the existing "original image size" behaviour of the image-to-PDF
converter, and keeps one pixel equal to one PDF point.

``core/insert/image_inserter.py`` has a similar preparation step inside a larger
routine that fits the image onto a reference page; this module deliberately does
not reuse that logic because the sizing rule differs. The duplication is scoped
to this one function and is recorded in the change design.
"""
from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageOps


class ImagePageError(Exception):
    """Raised when an image cannot be prepared as a page."""


def prepare_image_page(
    path: Path,
    rotation: int = 0,
    flip: bool = False,
) -> tuple[bytes, float, float]:
    """Return ``(jpeg_bytes, width, height)`` for one image page.

    The transform order matches the workspace grid: mirror first, then the
    quarter turns. ``expand`` is used for rotation so nothing is cropped, and the
    returned dimensions are the transformed image's dimensions.
    """
    try:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source)
            image.load()
    except Exception as exc:  # pragma: no cover - reported to the caller
        raise ImagePageError(f"Cannot read image: {exc}") from exc

    try:
        if flip:
            image = ImageOps.mirror(image)
        if rotation % 360:
            image = image.rotate(360 - (rotation % 360), expand=True)

        if image.mode in ("RGBA", "P"):
            background = Image.new("RGB", image.size, (255, 255, 255))
            if image.mode == "RGBA":
                background.paste(image, mask=image.split()[3])
            else:
                converted = image.convert("RGBA")
                background.paste(converted, mask=converted.split()[3])
            image = background
        elif image.mode != "RGB":
            image = image.convert("RGB")

        width, height = float(image.size[0]), float(image.size[1])
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=95, optimize=True)
    except Exception as exc:  # pragma: no cover - reported to the caller
        raise ImagePageError(f"Cannot prepare image page: {exc}") from exc

    return buffer.getvalue(), width, height
