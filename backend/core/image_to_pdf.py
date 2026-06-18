"""
Image to PDF Core Logic — backend/core/image_to_pdf.py

Converts a list of images into a single PDF document.
Supports fitting images to standard page sizes or matching the image size.
"""
import io
import logging
import uuid
from pathlib import Path
from typing import List

import fitz  # PyMuPDF
from PIL import Image, ImageOps

from config import settings

logger = logging.getLogger("pdf_manager.core.image_to_pdf")

class ImageToPdfError(Exception):
    """Raised when Image to PDF conversion fails."""

PAGE_SIZES = {
    "a4": (595.0, 842.0),
    "a3": (842.0, 1191.0),
    "letter": (612.0, 792.0),
    "legal": (612.0, 1008.0),
}


def images_to_pdf(
    image_paths: List[Path],
    page_size: str = "a4",
    output_filename: str = "output.pdf",
    rotations: List[int] = None,
    flips_h: List[bool] = None,
) -> tuple[Path, int, int]:
    """
    Convert a list of images to a single PDF.

    Args:
        image_paths: List of paths to the source images.
        page_size: One of 'a4', 'a3', 'letter', 'legal', or 'match_image'.
        output_filename: Name of the output PDF.

    Returns:
        Tuple of (output_path, total_pages, file_size_bytes).

    Raises:
        ImageToPdfError: On validation or processing failure.
    """
    if not image_paths:
        raise ImageToPdfError("No valid images provided.")
        
    page_size = page_size.lower()
    if page_size != "match_image" and page_size not in PAGE_SIZES:
        raise ImageToPdfError(f"Unsupported page size: {page_size}")

    if not output_filename.lower().endswith(".pdf"):
        output_filename += ".pdf"
        
    out_path = _make_output_path(output_filename)
    
    doc = fitz.open()
    total_pages = 0
    
    try:
        for i, img_path in enumerate(image_paths):
            try:
                pil_img = Image.open(img_path)
                # Ensure we handle orientation from EXIF (important for photos)
                pil_img = ImageOps.exif_transpose(pil_img)
                
                if flips_h and i < len(flips_h) and flips_h[i]:
                    pil_img = ImageOps.mirror(pil_img)
                    
                if rotations and i < len(rotations) and rotations[i]:
                    pil_img = pil_img.rotate(360 - (rotations[i] % 360), expand=True)
                
                # Convert to RGB if needed
                if pil_img.mode in ("RGBA", "P"):
                    bg = Image.new("RGB", pil_img.size, (255, 255, 255))
                    if pil_img.mode == "RGBA":
                        bg.paste(pil_img, mask=pil_img.split()[3])
                    else:
                        bg.paste(pil_img.convert("RGBA"), mask=pil_img.convert("RGBA").split()[3])
                    pil_img = bg
                elif pil_img.mode != "RGB":
                    pil_img = pil_img.convert("RGB")
                    
                img_w, img_h = pil_img.size
                
                # Get image bytes (JPEG for PDF insertion)
                buf = io.BytesIO()
                pil_img.save(buf, format="JPEG", quality=95, optimize=True)
                img_bytes = buf.getvalue()
                
                if page_size == "match_image":
                    # Convert pixels to points (assuming 72 DPI, 1 px = 1 pt)
                    page_w, page_h = float(img_w), float(img_h)
                    rect = fitz.Rect(0, 0, page_w, page_h)
                else:
                    page_w, page_h = PAGE_SIZES[page_size]
                    # Letterbox (fit) to preserve aspect ratio
                    scale = min(page_w / img_w, page_h / img_h)
                    
                    new_w = img_w * scale
                    new_h = img_h * scale
                    
                    # Center the image
                    x0 = (page_w - new_w) / 2
                    y0 = (page_h - new_h) / 2
                    
                    rect = fitz.Rect(x0, y0, x0 + new_w, y0 + new_h)
                
                page = doc.new_page(width=page_w, height=page_h)
                page.insert_image(rect, stream=img_bytes)
                total_pages += 1
                
            except Exception as e:
                logger.warning(f"Skipping {img_path.name}: {e}")
                
        if total_pages == 0:
            raise ImageToPdfError("None of the provided images could be processed.")
            
        doc.save(str(out_path), garbage=4, deflate=True)
        
    except Exception as e:
        raise ImageToPdfError(f"Failed to create PDF: {e}")
    finally:
        doc.close()
        
    size_bytes = out_path.stat().st_size
    logger.info(f"Image to PDF: created {out_path.name} ({total_pages} pages)")
    
    return out_path, total_pages, size_bytes


def _make_output_path(filename: str) -> Path:
    path = settings.OUTPUT_DIR / filename
    if path.exists():
        stem = path.stem
        suffix = path.suffix
        path = settings.OUTPUT_DIR / f"{stem}_{uuid.uuid4().hex[:8]}{suffix}"
    return path
