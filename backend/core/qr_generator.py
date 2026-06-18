"""
QR Generator Core Logic — backend/core/qr_generator.py
"""
import io
import qrcode
import qrcode.image.svg
from typing import Tuple

class QRGeneratorError(Exception):
    """Raised when QR generation fails."""

ERROR_CORRECTION_MAP = {
    "L": qrcode.constants.ERROR_CORRECT_L,
    "M": qrcode.constants.ERROR_CORRECT_M,
    "Q": qrcode.constants.ERROR_CORRECT_Q,
    "H": qrcode.constants.ERROR_CORRECT_H,
}

def generate_qr(
    content: str,
    size: int = 10,
    error_correction: str = "M",
    format: str = "png",
    border: int = 4,
) -> Tuple[bytes, str]:
    """
    Generate a QR code.

    Args:
        content: Data to encode.
        size: Box size (1-20).
        error_correction: 'L', 'M', 'Q', or 'H'.
        format: 'png' or 'svg'.
        border: Quiet zone border size.

    Returns:
        Tuple of (image_bytes, mime_type).
    """
    if not content.strip():
        raise QRGeneratorError("Content cannot be empty.")

    ec_level = ERROR_CORRECTION_MAP.get(error_correction.upper(), qrcode.constants.ERROR_CORRECT_M)
    format = format.lower()
    if format not in ("png", "svg"):
        raise QRGeneratorError(f"Unsupported format: {format}")

    qr = qrcode.QRCode(
        version=None,
        error_correction=ec_level,
        box_size=size,
        border=border,
    )
    qr.add_data(content)
    qr.make(fit=True)

    buf = io.BytesIO()

    if format == "svg":
        # Generate SVG
        factory = qrcode.image.svg.SvgImage
        img = qr.make_image(image_factory=factory)
        img.save(buf)
        mime_type = "image/svg+xml"
    else:
        # Generate PNG
        img = qr.make_image(fill_color="black", back_color="white")
        img.save(buf, format="PNG")
        mime_type = "image/png"

    return buf.getvalue(), mime_type
