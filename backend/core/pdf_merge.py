"""
PDF Merge Core Logic — backend/core/pdf_merge.py

Merges a list of PDF files (by path) into a single output PDF using PyMuPDF.
All PDF processing lives here; routers call this module.
"""
import logging
from pathlib import Path

import fitz  # PyMuPDF

from config import settings
from utils.file_utils import sanitize_filename

logger = logging.getLogger("pdf_manager.core.merge")


class MergeError(Exception):
    """Raised when merge cannot be completed."""


def merge_pdfs(input_paths: list[Path], output_filename: str) -> tuple[Path, int, int]:
    """
    Merge multiple PDF files into one.

    Args:
        input_paths: Ordered list of Path objects to merge.
        output_filename: Desired filename for the output (without path).

    Returns:
        Tuple of (output_path, total_pages, file_size_bytes).

    Raises:
        MergeError: For validation or processing failures.
    """
    if len(input_paths) < 2:
        raise MergeError("At least 2 PDF files are required to merge.")

    # Sanitize and resolve output path — always overwrite; request is stateless
    safe_name = sanitize_filename(output_filename, "pdf")
    out_path = settings.OUTPUT_DIR / safe_name

    merged = fitz.open()  # create empty PDF

    try:
        for idx, pdf_path in enumerate(input_paths):
            if not pdf_path.exists():
                raise MergeError(f"File not found: {pdf_path.name}")

            try:
                src = fitz.open(str(pdf_path))
            except Exception as e:
                raise MergeError(f"Cannot open '{pdf_path.name}': {e}")

            if src.is_encrypted:
                src.close()
                raise MergeError(f"'{pdf_path.name}' is encrypted and cannot be merged.")

            merged.insert_pdf(src)
            src.close()
            logger.debug(f"Inserted PDF #{idx + 1}: {pdf_path.name}")

        total_pages = merged.page_count
        merged.save(str(out_path), garbage=4, deflate=True)
        logger.info(f"Merge complete → {out_path.name} ({total_pages} pages)")

    finally:
        merged.close()

    size_bytes = out_path.stat().st_size
    return out_path, total_pages, size_bytes
