"""
PDF to Image Core Logic — backend/core/pdf_to_image.py

Converts PDF pages into images (PNG, JPEG, WEBP) using PyMuPDF and Pillow.
Returns a single image if 1 page is selected, or a ZIP archive for multiple pages.
"""
import io
import logging
import uuid
import zipfile
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image

from config import settings
from core.pdf_extract import parse_page_ranges, ExtractError

logger = logging.getLogger("pdf_manager.core.pdf_to_image")

class PdfToImageError(Exception):
    """Raised when PDF to image conversion fails."""


def pdf_to_image(
    input_path: Path,
    page_str: str,
    format: str = "png",
    dpi: int = 150,
    clean_name: str = "",
) -> tuple[Path, int, bool]:
    """
    Convert PDF pages to images.

    Args:
        input_path: Path to the source PDF.
        page_str: Page ranges (e.g. "1-3,5"). Empty means all pages.
        format: Output image format ("png", "jpeg", "webp").
        dpi: Dots per inch for rendering.

    Returns:
        Tuple of (output_path, pages_exported, is_zip).
        is_zip is True if multiple pages were exported (returns a .zip),
        False if 1 page was exported (returns a single image).

    Raises:
        PdfToImageError: On validation or processing failure.
    """
    format = format.lower()
    if format not in ("png", "jpeg", "webp"):
        raise PdfToImageError(f"Unsupported format: {format}")

    # For Pillow, format must be uppercase (JPEG, PNG, WEBP)
    pil_format = format.upper()
    if pil_format == "JPG":
        pil_format = "JPEG"

    try:
        doc = fitz.open(str(input_path))
    except Exception as e:
        raise PdfToImageError(f"Cannot open PDF: {e}")

    if doc.is_encrypted:
        doc.close()
        raise PdfToImageError("PDF is encrypted and cannot be processed.")

    total_pages = doc.page_count

    try:
        if not page_str.strip():
            # All pages
            ranges = [[i] for i in range(total_pages)]
        else:
            try:
                ranges = parse_page_ranges(page_str, total_pages)
            except ExtractError as e:
                raise PdfToImageError(str(e))

        # Flatten ranges into a unique, sorted list of page indices
        page_indices = sorted({p for group in ranges for p in group})
        pages_exported = len(page_indices)

        if pages_exported == 0:
            raise PdfToImageError("No valid pages selected for export.")

        base_name = clean_name or input_path.stem

        if pages_exported == 1:
            # Single page export
            page_idx = page_indices[0]
            out_path = _make_output_path(f"{base_name}_page{page_idx + 1:04d}.{format}")
            
            img_bytes = _render_page_to_bytes(doc, page_idx, dpi, pil_format)
            
            with out_path.open("wb") as f:
                f.write(img_bytes)
            
            is_zip = False
        else:
            # Multi-page export to ZIP
            out_path = _make_output_path(f"{base_name}_images.zip")
            
            with zipfile.ZipFile(str(out_path), "w", zipfile.ZIP_DEFLATED) as zf:
                for page_idx in page_indices:
                    img_bytes = _render_page_to_bytes(doc, page_idx, dpi, pil_format)
                    zf.writestr(f"{base_name}_page{page_idx + 1:04d}.{format}", img_bytes)
            
            is_zip = True

    finally:
        doc.close()

    logger.info(f"PDF to Image: {pages_exported} pages exported to {out_path.name}")
    return out_path, pages_exported, is_zip


def _make_output_path(filename: str) -> Path:
    path = settings.OUTPUT_DIR / filename
    if path.exists():
        stem = path.stem
        suffix = path.suffix
        path = settings.OUTPUT_DIR / f"{stem}_{uuid.uuid4().hex[:8]}{suffix}"
    return path


def _render_page_to_bytes(doc: fitz.Document, page_idx: int, dpi: int, format: str) -> bytes:
    """Render a single page to image bytes."""
    page = doc[page_idx]
    
    # Render to pixmap
    # Disable alpha channel to ensure white background instead of transparent
    alpha = False
    pix = page.get_pixmap(dpi=dpi, alpha=alpha)
    
    # Convert PyMuPDF pixmap to Pillow Image
    mode = "RGBA" if pix.alpha else "RGB"
    img = Image.frombytes(mode, [pix.width, pix.height], pix.samples)
    
    # Save to BytesIO
    buf = io.BytesIO()
    # Optimize output
    kwargs = {"format": format}
    if format == "JPEG":
        kwargs["quality"] = 90
        kwargs["optimize"] = True
    elif format == "PNG":
        kwargs["optimize"] = True
    elif format == "WEBP":
        kwargs["quality"] = 90
        
    img.save(buf, **kwargs)
    return buf.getvalue()
