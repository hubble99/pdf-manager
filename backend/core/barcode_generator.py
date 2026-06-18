"""
Barcode Generator Core Logic — backend/core/barcode_generator.py
"""
import io
import barcode
from barcode.writer import ImageWriter, SVGWriter
from typing import Tuple

class BarcodeGeneratorError(Exception):
    """Raised when Barcode generation fails."""

def generate_barcode(
    content: str,
    barcode_type: str = "code128",
    out_format: str = "png",
) -> Tuple[bytes, str]:
    """
    Generate a barcode.

    Args:
        content: Data to encode.
        barcode_type: 'code128', 'ean13', 'ean8', or 'code39'.
        out_format: 'png' or 'svg'.

    Returns:
        Tuple of (image_bytes, mime_type).
    """
    if not content.strip():
        raise BarcodeGeneratorError("Content cannot be empty.")

    barcode_type = barcode_type.lower()
    out_format = out_format.lower()

    if barcode_type not in ("code128", "ean13", "ean8", "code39"):
        raise BarcodeGeneratorError(f"Unsupported barcode type: {barcode_type}")

    if out_format not in ("png", "svg"):
        raise BarcodeGeneratorError(f"Unsupported format: {out_format}")

    # For EAN, barcode library requires specific digit count
    if barcode_type == "ean13":
        digits = content.strip()
        if not (12 <= len(digits) <= 13 and digits.isdigit()):
            raise BarcodeGeneratorError("EAN-13 requires exactly 12 or 13 numeric digits.")
    if barcode_type == "ean8":
        digits = content.strip()
        if not (7 <= len(digits) <= 8 and digits.isdigit()):
            raise BarcodeGeneratorError("EAN-8 requires exactly 7 or 8 numeric digits.")

    try:
        BarcodeClass = barcode.get_barcode_class(barcode_type)
        writer = SVGWriter() if out_format == "svg" else ImageWriter()
        
        # Instantiate barcode
        bc = BarcodeClass(content, writer=writer)
        
        buf = io.BytesIO()
        bc.write(buf)
        
        # IMPORTANT: seek to start before reading — ImageWriter leaves pos at EOF
        buf.seek(0)
        
        mime_type = "image/svg+xml" if out_format == "svg" else "image/png"
        return buf.read(), mime_type
    except BarcodeGeneratorError:
        raise
    except Exception as e:
        raise BarcodeGeneratorError(f"Failed to generate barcode: {e}")
