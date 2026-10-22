"""
Page range parsing — backend/core/page_ranges.py

Used by the PDF to image converter. (Split PDF has its own parser in the
native core.)
"""
import re


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
