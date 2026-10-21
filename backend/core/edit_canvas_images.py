"""Image objects for Canvas PDF.

An image object is placed with the four corners the editor reports for it
(top-left, top-right, bottom-right, bottom-left in canvas units). The image is
drawn into a one-page PDF with the object's displayed size, and that page is
shown on the target page inside the corners' bounding box, rotated by the
object's angle. This keeps any rotation exact, not only quarter turns.
"""

import base64
import binascii
import io
import math

import fitz
from PIL import Image, ImageOps, UnidentifiedImageError

# Formats MuPDF embeds as they are. Anything else is re-encoded as PNG.
_PASSTHROUGH_FORMATS = {"JPEG", "PNG"}
_EXIF_ORIENTATION = 0x0112


class CanvasImageError(ValueError):
    pass


def decode_image_data(encoded: str) -> bytes:
    if not encoded or not isinstance(encoded, str):
        raise CanvasImageError("Image object has no image data.")
    payload = encoded.split(",", 1)[1] if encoded.startswith("data:") and "," in encoded else encoded
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CanvasImageError("Image data is not valid base64.") from exc


def prepare_image_stream(raw: bytes, opacity: float = 1.0) -> bytes:
    """Return image bytes MuPDF can embed, with EXIF orientation and opacity applied.

    JPEG and PNG files without orientation or opacity changes are embedded
    unchanged, so the PDF keeps the original image quality and size.
    """
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise CanvasImageError("Image data could not be decoded.") from exc

    image_format = (image.format or "").upper()
    orientation = image.getexif().get(_EXIF_ORIENTATION, 1)
    opacity = max(0.0, min(1.0, float(opacity)))
    if image_format in _PASSTHROUGH_FORMATS and orientation in (0, 1) and opacity >= 1.0:
        return raw

    image = ImageOps.exif_transpose(image)
    if opacity < 1.0:
        image = image.convert("RGBA")
        alpha = image.getchannel("A").point(lambda value: round(value * opacity))
        image.putalpha(alpha)
    elif image.mode not in ("RGB", "RGBA", "L", "LA", "P"):
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=False)
    return output.getvalue()


def image_corners(item: dict, scale_x: float, scale_y: float) -> list[fitz.Point]:
    """Corners in PDF units, ordered top-left, top-right, bottom-right, bottom-left."""
    corners = item.get("vectorCorners")
    if corners and len(corners) == 4:
        return [fitz.Point(float(point[0]) * scale_x, float(point[1]) * scale_y) for point in corners]

    x = float(item.get("x", 0))
    y = float(item.get("y", 0))
    width = float(item.get("width", 0))
    height = float(item.get("height", 0))
    angle = math.radians(float(item.get("angle", 0) or 0))
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    local = [(0.0, 0.0), (width, 0.0), (width, height), (0.0, height)]
    return [
        fitz.Point((x + px * cos_a - py * sin_a) * scale_x, (y + px * sin_a + py * cos_a) * scale_y)
        for px, py in local
    ]


def draw_native_image(page, item: dict, scale_x: float, scale_y: float, image_assets: dict | None) -> None:
    asset_id = item.get("assetId")
    encoded = (image_assets or {}).get(asset_id) if asset_id else None
    if encoded is None:
        encoded = item.get("src")
    if not encoded:
        raise CanvasImageError(f"Image object {item.get('id', '')} has no image data.")

    corners = image_corners(item, scale_x, scale_y)
    top_left, top_right, _bottom_right, bottom_left = corners
    width = math.dist((top_left.x, top_left.y), (top_right.x, top_right.y))
    height = math.dist((top_left.x, top_left.y), (bottom_left.x, bottom_left.y))
    if width < 0.01 or height < 0.01:
        return

    opacity = item.get("opacity", 1)
    stream = prepare_image_stream(decode_image_data(encoded), 1.0 if opacity is None else float(opacity))

    # Angle of the top edge, clockwise on screen, as the editor reports it.
    angle = math.degrees(math.atan2(top_right.y - top_left.y, top_right.x - top_left.x))
    xs = [point.x for point in corners]
    ys = [point.y for point in corners]
    bbox = fitz.Rect(min(xs), min(ys), max(xs), max(ys))

    source = fitz.open()
    try:
        source_page = source.new_page(width=width, height=height)
        source_page.insert_image(source_page.rect, stream=stream, keep_proportion=False)
        # show_pdf_page turns counter-clockwise for positive angles.
        page.show_pdf_page(bbox, source, 0, keep_proportion=True, rotate=-angle)
    finally:
        source.close()
