"""Colour-managed page rendering.

MuPDF converts CMYK, gray and ICC-tagged colours with a plain formula unless ICC
handling is switched on, which makes rendered pages look duller or shifted next to
Acrobat, Edge or Chrome. Importing this module turns ICC handling on once for the
whole process, so every preview, thumbnail and image export uses the same colours
the original PDF shows in a viewer.
"""

import fitz

fitz.TOOLS.set_icc(True)

# Hard ceiling for one rendered page, so a large sheet at high DPI cannot exhaust memory.
MAX_RENDER_PIXELS = 60_000_000


def safe_dpi(page: "fitz.Page", dpi: int) -> int:
    """Lower ``dpi`` until the page fits within MAX_RENDER_PIXELS."""
    area = max(page.rect.width * page.rect.height, 1.0) / (72 * 72)  # square inches
    allowed = int((MAX_RENDER_PIXELS / area) ** 0.5)
    return max(36, min(dpi, allowed))
