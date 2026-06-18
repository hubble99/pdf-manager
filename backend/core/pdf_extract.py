"""
PDF Extract Core Logic — backend/core/pdf_extract.py

Extracts pages from a PDF and returns either:
- A single PDF (combine mode)
- A ZIP archive of multiple PDFs (separate_page / separate_range / split_all modes)
"""
import io
import logging
import re
import uuid
import zipfile
from pathlib import Path

import fitz  # PyMuPDF

from config import settings

logger = logging.getLogger("pdf_manager.core.extract")

OUTPUT_MODES = {"combine", "separate_page", "separate_range", "split_all"}


class ExtractError(Exception):
    """Raised when extraction cannot be completed."""


def parse_page_ranges(page_str: str, total_pages: int) -> list[list[int]]:
    """
    Parse a page range string into a list of ranges (groups).

    Each comma-separated token becomes one group:
      "1-3,5,7-9"  → [[1,2,3], [5], [7,8,9]]

    Page numbers are 1-indexed in the input and validated against total_pages.
    Returns 0-indexed page lists internally.

    Raises:
        ExtractError: On invalid syntax or out-of-range pages.
    """
    if not page_str.strip():
        raise ExtractError("Page range string is empty.")

    ranges: list[list[int]] = []
    tokens = [t.strip() for t in page_str.split(",") if t.strip()]

    for token in tokens:
        if re.match(r"^\d+$", token):
            page = int(token)
            if page < 1 or page > total_pages:
                raise ExtractError(f"Page {page} is out of range (document has {total_pages} pages).")
            ranges.append([page - 1])  # convert to 0-indexed
        elif re.match(r"^\d+-\d+$", token):
            start_str, end_str = token.split("-")
            start, end = int(start_str), int(end_str)
            if start < 1 or end > total_pages:
                raise ExtractError(
                    f"Range '{token}' is out of range (document has {total_pages} pages)."
                )
            if start > end:
                raise ExtractError(f"Range '{token}' is invalid: start must be ≤ end.")
            ranges.append(list(range(start - 1, end)))  # 0-indexed
        else:
            raise ExtractError(
                f"'{token}' is not a valid page or range. Use format: 1-3, 5, 7-9"
            )

    return ranges


def extract_pages(
    input_path: Path,
    page_str: str,
    output_mode: str,
    out_name: str,
    clean_name: str = "",
) -> tuple[Path, int]:
    """
    Extract pages from a PDF.

    Args:
        input_path: Path to the source PDF.
        page_str: Page range string, e.g. "1-3,5,7-9". Ignored for split_all.
        output_mode: One of 'combine', 'separate_page', 'separate_range', 'split_all'.
        out_name: Exact output filename (including extension).

    Returns:
        Tuple of (output_path, page_count_extracted).
        output_path is a .pdf for combine, or a .zip for multi-file modes.

    Raises:
        ExtractError: On validation or processing failure.
    """
    if output_mode not in OUTPUT_MODES:
        raise ExtractError(f"Invalid output_mode '{output_mode}'. Choose from: {OUTPUT_MODES}")

    try:
        src = fitz.open(str(input_path))
    except Exception as e:
        raise ExtractError(f"Cannot open PDF: {e}")

    if src.is_encrypted:
        src.close()
        raise ExtractError("PDF is encrypted and cannot be processed.")

    total_pages = src.page_count

    try:
        if output_mode == "split_all":
            # Split every page into its own file
            ranges = [[i] for i in range(total_pages)]
        else:
            ranges = parse_page_ranges(page_str, total_pages)

        total_extracted = sum(len(r) for r in ranges)

        out_path = settings.OUTPUT_DIR / out_name
        
        if output_mode == "combine":
            _extract_combine(src, ranges, out_path)
        else:
            _extract_zip(src, ranges, out_path, output_mode, clean_name or out_path.stem)

    finally:
        src.close()

    return out_path, total_extracted


# ── Private helpers ────────────────────────────────────────────────────────────

# Removed _make_output_path


def _extract_combine(src: fitz.Document, ranges: list[list[int]], out_path: Path) -> Path:
    """Combine all selected pages into one PDF."""
    out_doc = fitz.open()
    for page_group in ranges:
        for page_idx in page_group:
            out_doc.insert_pdf(src, from_page=page_idx, to_page=page_idx)
    out_doc.save(str(out_path), garbage=4, deflate=True)
    out_doc.close()
    logger.info(f"Combine extract → {out_path.name}")
    return out_path


def _extract_zip(
    src: fitz.Document,
    ranges: list[list[int]],
    zip_path: Path,
    mode: str,
    base_name: str,
) -> Path:
    """Package extracted PDFs into a ZIP archive."""
    with zipfile.ZipFile(str(zip_path), "w", zipfile.ZIP_DEFLATED) as zf:
        if mode == "separate_page":
            # Each individual page → its own PDF
            page_set = sorted({p for group in ranges for p in group})
            for idx, page_idx in enumerate(page_set):
                pdf_bytes = _pages_to_bytes(src, [page_idx])
                zf.writestr(f"{base_name}_page{page_idx + 1:04d}.pdf", pdf_bytes)
        elif mode in ("separate_range", "split_all"):
            # Each range group → its own PDF
            for idx, group in enumerate(ranges):
                if not group:
                    continue
                label = f"p{group[0] + 1}" if len(group) == 1 else f"p{group[0] + 1}-{group[-1] + 1}"
                pdf_bytes = _pages_to_bytes(src, group)
                zf.writestr(f"{base_name}_{label}.pdf", pdf_bytes)

    logger.info(f"ZIP extract ({mode}) → {zip_path.name}")
    return zip_path


def _pages_to_bytes(src: fitz.Document, page_indices: list[int]) -> bytes:
    """Extract given page indices from src into an in-memory PDF bytes."""
    tmp = fitz.open()
    for idx in page_indices:
        tmp.insert_pdf(src, from_page=idx, to_page=idx)
    buf = io.BytesIO()
    tmp.save(buf, garbage=4, deflate=True)
    tmp.close()
    return buf.getvalue()
