"""Page-level orientation transforms used when assembling an organized document.

PyMuPDF exposes quarter-turn rotation as a page property but has no page-level
mirror, so horizontal mirroring is applied to the page content stream as a
reflection matrix.

The reflection must translate by the horizontal bounds of the *cropbox*
(``cropbox.x0 + cropbox.x1``), not by ``rect.width``. For a page whose cropbox
does not start at zero the two differ, and using the width silently shifts the
page content instead of mirroring it in place. This was established by the
F3 spike and is covered by ``tests/test_pdf_page_transform.py``.
"""
from __future__ import annotations

import fitz

REFLECTION_PREFIX = b"q -1 0 0 1 %g 0 cm\n"


def mirror_page(document: fitz.Document, page: fitz.Page) -> None:
    """Reflect a page's content horizontally about its visible page area.

    The reflection is applied in page space, so the page keeps its size, its
    cropbox, and its box origin. Text and vector content stay vector: nothing is
    rasterized.

    A page's content is usually split into several streams (PyMuPDF writes one
    per drawing operation), and a page renders as the concatenation of all of
    them. The reflection therefore has to open before the first stream and close
    after the last one; transforming only the first stream would silently mirror
    part of the page and leave the rest untouched.
    """
    page.wrap_contents()
    xrefs = page.get_contents()
    if not xrefs:
        return

    cropbox = page.cropbox
    prefix = REFLECTION_PREFIX % (cropbox.x0 + cropbox.x1)

    # Read every distinct stream before writing any of them, because the same
    # stream can legitimately appear more than once in the content list.
    bodies = {xref: document.xref_stream(xref) for xref in dict.fromkeys(xrefs)}
    first, last = xrefs[0], xrefs[-1]

    if first == last:
        document.update_stream(first, prefix + bodies[first] + b"\nQ")
        return

    document.update_stream(first, prefix + bodies[first])
    document.update_stream(last, bodies[last] + b"\nQ")


def apply_orientation(
    document: fitz.Document,
    page: fitz.Page,
    rotation: int = 0,
    flip: bool = False,
) -> None:
    """Apply one grid entry's orientation to an already-placed page.

    The composition order is fixed and must match the workspace grid, which
    renders ``rotate(<rotation>) scaleX(-1)``: the reflection is applied first in
    page space, then the quarter turns are added to the page's own rotation.
    """
    if flip:
        mirror_page(document, page)

    quarter_turns = rotation % 360
    if quarter_turns:
        page.set_rotation((page.rotation + quarter_turns) % 360)
