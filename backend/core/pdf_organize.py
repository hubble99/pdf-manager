import logging
from pathlib import Path
from typing import List, Dict

import fitz  # PyMuPDF

from config import settings
from utils.file_utils import sanitize_filename

logger = logging.getLogger("pdf_manager.core.organize")

class OrganizeError(Exception):
    pass


def organize_pdf(
    input_path: Path,
    pages_config: List[Dict[str, int]],
    output_filename: str = "organized.pdf"
) -> tuple[Path, int, int]:
    """
    Organize a PDF by reordering, duplicating, deleting, or rotating pages.
    
    Args:
        input_path: Path to the source PDF.
        pages_config: List of dicts, e.g., [{"page": 1, "rotation": 90}, ...]. 
                      'page' is 1-indexed source page.
        output_filename: Desired output name.
        
    Returns:
        tuple (output_path, total_pages, file_size_bytes)
    """
    if not pages_config:
        raise OrganizeError("No pages specified in configuration.")

    try:
        doc = fitz.open(str(input_path))
    except Exception as e:
        raise OrganizeError(f"Cannot open PDF: {e}")

    if doc.is_encrypted:
        doc.close()
        raise OrganizeError("PDF is encrypted.")

    try:
        # Build 0-indexed sequence for doc.select()
        seq = []
        for cfg in pages_config:
            p = cfg.get("page", 1)
            if p < 1 or p > doc.page_count:
                raise OrganizeError(f"Page number {p} out of bounds.")
            seq.append(p - 1)

        # Reorder/duplicate/delete in one shot
        doc.select(seq)

        # Apply rotations to the NEW page sequence
        for i, cfg in enumerate(pages_config):
            rot = cfg.get("rotation", 0)
            if rot:
                page = doc[i]
                # PyMuPDF rotation is absolute. Add to existing.
                current = page.rotation
                page.set_rotation((current + rot) % 360)

        out_name = sanitize_filename(output_filename or input_path.stem, "pdf")
        out_path = settings.OUTPUT_DIR / out_name

        doc.save(str(out_path), garbage=4, deflate=True)
        total_pages = doc.page_count
    except OrganizeError:
        raise
    except Exception as e:
        raise OrganizeError(f"Failed to organize PDF: {e}")
    finally:
        doc.close()

    size_bytes = out_path.stat().st_size
    logger.info(f"Organized PDF saved to {out_name} ({total_pages} pages)")

    return out_path, total_pages, size_bytes
