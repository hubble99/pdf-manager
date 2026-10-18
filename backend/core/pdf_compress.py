"""
PDF Compress Core Logic — backend/core/pdf_compress.py

Compresses a PDF by re-encoding embedded images at lower JPEG quality.
Uses PyMuPDF to iterate pages and replace image streams, Pillow for JPEG encode.
Returns the compressed PDF path plus before/after metadata.
"""
import io
import logging
import re
from pathlib import Path
from typing import Generator

import fitz  # PyMuPDF
from PIL import Image


logger = logging.getLogger("pdf_manager.core.compress")


class CompressError(Exception):
    """Raised when compression cannot be completed."""


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


# Anything in an image dictionary that the JPEG re-encode below cannot carry over
# faithfully. Such images are left exactly as they are: they are rare in practice
# and a wrong re-encode shows up as black or inverted objects.
_UNSAFE_IMAGE_KEYS = re.compile(
    r"/(?:ImageMask|Mask|Decode|Indexed|Separation|DeviceN|DeviceCMYK|Lab"
    r"|JBIG2Decode|CCITTFaxDecode)(?![A-Za-z0-9])"
)
# ImageMask: stencil shapes. Mask: colour-key or stencil mask. Decode: inverted or
# remapped samples. Indexed/Separation/DeviceN/DeviceCMYK/Lab: colour spaces that
# need a real conversion. JBIG2/CCITT: 1-bit scans. "/SMask" (the soft mask) is a
# different key and is handled separately.


def _is_safe_to_recompress(doc: fitz.Document, xref: int) -> bool:
    """True when the image is an ordinary 8-bit RGB or grey picture."""
    try:
        description = doc.xref_object(xref, compressed=False)
    except Exception:
        return False
    if _UNSAFE_IMAGE_KEYS.search(description):
        return False
    bits = doc.xref_get_key(xref, "BitsPerComponent")
    return bits[0] == "int" and bits[1] == "8"


def _soft_mask_xref(doc: fitz.Document, xref: int) -> int | None:
    """The xref of the image's soft mask (its transparency), if it has one."""
    kind, value = doc.xref_get_key(xref, "SMask")
    if kind != "xref":
        return None
    try:
        return int(value.split()[0])
    except (ValueError, IndexError):
        return None


def _recompress_image(page: fitz.Page, xref: int, quality: int) -> int:
    """
    Re-encode a single image xref at the given JPEG quality.
    Returns 1 if the image was re-encoded, 0 if it was left as it was.

    The picture itself is re-encoded; its transparency (soft mask) is kept and
    re-attached afterwards. `Page.replace_image` swaps in a brand new image
    object, so without that step a transparent logo or shadow would turn into
    an opaque box filled with whatever colour sat under the transparency.
    """
    doc = page.parent

    if not _is_safe_to_recompress(doc, xref):
        return 0
    soft_mask = _soft_mask_xref(doc, xref)

    img_dict = doc.extract_image(xref)
    if img_dict is None:
        return 0

    # Only plain grey (1) or RGB (3) samples; a 4-component image is CMYK.
    if img_dict.get("colorspace") not in (1, 3):
        return 0

    img_bytes = img_dict.get("image")
    width = img_dict.get("width", 0)
    height = img_dict.get("height", 0)

    if not img_bytes or width == 0 or height == 0:
        return 0

    try:
        pil_img = Image.open(io.BytesIO(img_bytes))
        pil_img.load()
    except Exception:
        return 0

    # JPEG holds RGB or grey only. Flatten anything else that reached this point;
    # the mask is carried separately, so no colour is lost to alpha here.
    if pil_img.mode in ("RGBA", "LA", "P"):
        pil_img = pil_img.convert("RGB")
    elif pil_img.mode not in ("RGB", "L"):
        return 0

    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=quality, optimize=True)
    new_bytes = buf.getvalue()

    # Only replace when the result is smaller than what the file stores today.
    try:
        stored_size = len(doc.xref_stream_raw(xref))
    except Exception:
        stored_size = len(img_bytes)
    if len(new_bytes) >= stored_size:
        return 0

    page.replace_image(xref, stream=new_bytes)
    if soft_mask is not None:
        doc.xref_set_key(xref, "SMask", f"{soft_mask} 0 R")

    return 1
