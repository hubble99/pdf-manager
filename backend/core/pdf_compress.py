"""
PDF Compress Core Logic — backend/core/pdf_compress.py

Compresses a PDF by re-encoding embedded images at lower JPEG quality.
Uses PyMuPDF to iterate pages and replace image streams, Pillow for JPEG encode.
Returns the compressed PDF path plus before/after metadata.
"""
import io
import logging
from pathlib import Path
from typing import Generator

import fitz  # PyMuPDF
from PIL import Image

from config import settings
from utils.file_utils import sanitize_filename

logger = logging.getLogger("pdf_manager.core.compress")


class CompressError(Exception):
    """Raised when compression cannot be completed."""


def compress_pdf(input_path: Path, quality: int = 70, output_filename: str = "") -> dict:
    """
    Compress a PDF by re-encoding all embedded raster images at the given JPEG quality.

    Strategy:
    1. Open source PDF.
    2. For each page, get all image xrefs.
    3. Extract each image, re-encode with Pillow at `quality` (JPEG), replace xref stream.
    4. Save to new output path.

    Args:
        input_path: Path to the source PDF.
        quality: JPEG quality (10–95). Lower = smaller file.
        output_filename: Desired output filename (without path). Falls back to input stem.

    Returns:
        dict with keys:
          output_path, size_before, size_after, reduction_pct, pages_processed, images_processed

    Raises:
        CompressError: On validation or processing failure.
    """
    if not (10 <= quality <= 95):
        raise CompressError(f"Quality must be between 10 and 95 (got {quality}).")

    size_before = input_path.stat().st_size

    try:
        doc = fitz.open(str(input_path))
    except Exception as e:
        raise CompressError(f"Cannot open PDF: {e}")

    if doc.is_encrypted:
        doc.close()
        raise CompressError("PDF is encrypted and cannot be compressed.")

    images_processed = 0
    processed_xrefs = set()

    try:
        for page_num in range(doc.page_count):
            page = doc[page_num]
            image_list = page.get_images(full=True)

            for img_info in image_list:
                xref = img_info[0]  # xref of the image
                if xref in processed_xrefs:
                    continue
                processed_xrefs.add(xref)
                
                try:
                    images_processed += _recompress_image(page, xref, quality)
                except Exception as e:
                    # Non-fatal: skip images that can't be re-encoded (e.g. masks, non-JPEG)
                    logger.debug(f"Skipped xref {xref} on page {page_num + 1}: {e}")

        # Build output path — use user's filename or derive from input stem
        if output_filename:
            out_name = sanitize_filename(output_filename, "pdf")
        else:
            out_name = sanitize_filename(f"{input_path.stem}_compressed", "pdf")
        out_path = settings.OUTPUT_DIR / out_name

        doc.save(
            str(out_path),
            garbage=4,
            deflate=True,
            clean=True,
        )

    finally:
        doc.close()

    size_after = out_path.stat().st_size
    if size_after >= size_before:
        import shutil
        shutil.copy2(input_path, out_path)
        size_after = size_before
        reduction_pct = 0.0
    else:
        reduction_pct = round((1 - size_after / size_before) * 100, 1) if size_before > 0 else 0.0

    logger.info(
        f"Compress: {size_before:,} → {size_after:,} bytes "
        f"({reduction_pct}% reduction, {images_processed} images re-encoded)"
    )

    return {
        "output_path": out_path,
        "size_before": size_before,
        "size_after": size_after,
        "reduction_pct": reduction_pct,
        "pages_processed": doc.page_count if not doc.is_closed else 0,
        "images_processed": images_processed,
    }


def compress_pdf_with_progress(
    input_path: str,
    output_path: str,
    quality: int
) -> Generator[dict, None, dict]:
    if not (10 <= quality <= 95):
        raise CompressError(f"Quality must be between 10 and 95 (got {quality}).")

    in_path = Path(input_path)
    size_before = in_path.stat().st_size

    try:
        doc = fitz.open(str(in_path))
    except Exception as e:
        raise CompressError(f"Cannot open PDF: {e}")

    if doc.is_encrypted:
        doc.close()
        raise CompressError("PDF is encrypted and cannot be compressed.")

    images_processed = 0
    processed_xrefs = set()
    total_pages = doc.page_count

    try:
        for page_num in range(total_pages):
            page = doc[page_num]
            image_list = page.get_images(full=True)
            images_on_page = 0

            for img_info in image_list:
                xref = img_info[0]
                if xref in processed_xrefs:
                    continue
                processed_xrefs.add(xref)
                
                try:
                    processed = _recompress_image(page, xref, quality)
                    images_processed += processed
                    images_on_page += processed
                except Exception as e:
                    logger.debug(f"Skipped xref {xref} on page {page_num + 1}: {e}")

            percent = round(((page_num + 1) / total_pages) * 100, 1)
            yield {
                "page": page_num + 1,
                "total": total_pages,
                "percent": percent,
                "images_on_page": images_on_page,
            }

        doc.save(
            output_path,
            garbage=4,
            deflate=True,
            clean=True,
        )

    finally:
        doc.close()

    out_path = Path(output_path)
    size_after = out_path.stat().st_size
    if size_after >= size_before:
        import shutil
        shutil.copy2(in_path, out_path)
        size_after = size_before
        reduction_pct = 0.0
    else:
        reduction_pct = round((1 - size_after / size_before) * 100, 1) if size_before > 0 else 0.0

    return {
        "size_before": size_before,
        "size_after": size_after,
        "reduction_pct": reduction_pct,
        "images_processed": images_processed,
    }


def _recompress_image(page: fitz.Page, xref: int, quality: int) -> int:
    """
    Re-encode a single image xref at the given JPEG quality.
    Returns 1 if the image was re-encoded, 0 if skipped.
    """
    doc = page.parent
    
    # Extract raw image data
    img_dict = doc.extract_image(xref)
    if img_dict is None:
        return 0

    img_bytes = img_dict.get("image")
    colorspace = img_dict.get("colorspace", 3)  # 3 = RGB, 1 = Gray
    width = img_dict.get("width", 0)
    height = img_dict.get("height", 0)

    if not img_bytes or width == 0 or height == 0:
        return 0

    # Open with Pillow
    try:
        pil_img = Image.open(io.BytesIO(img_bytes))
    except Exception:
        return 0

    # Convert to a JPEG-compatible mode
    # JPEG supports: RGB, L (grayscale). CMYK technically allowed but causes issues with PyMuPDF.
    if pil_img.mode == "RGBA":
        pil_img = pil_img.convert("RGB")
    elif pil_img.mode == "P":
        pil_img = pil_img.convert("RGB")
    elif pil_img.mode == "CMYK":
        pil_img = pil_img.convert("RGB")  # Fix: CMYK → RGB before JPEG encode
    elif pil_img.mode not in ("RGB", "L"):
        return 0

    # Re-encode to JPEG
    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=quality, optimize=True)
    new_bytes = buf.getvalue()

    # Only replace if the new encoding is actually smaller
    if len(new_bytes) >= len(img_bytes):
        return 0

    # Replace the image cleanly using page.replace_image, 
    # which securely updates Filter, ColorSpace and BBox dictionaries.
    page.replace_image(xref, stream=new_bytes)

    return 1
