"""Colour-managed rendering and the pixel ceiling for page previews."""

import fitz

from core import render_color


def _cmyk_pdf(path):
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((10, 10), ".")
    doc.update_stream(page.get_contents()[0], b"q 0 0.8 0.9 0 k 50 50 200 200 re f Q")
    doc.save(str(path))
    doc.close()


def test_icc_is_on_after_import_and_cmyk_matches_the_managed_conversion(tmp_path):
    pdf = tmp_path / "cmyk.pdf"
    _cmyk_pdf(pdf)
    doc = fitz.open(str(pdf))
    managed = doc[0].get_pixmap(dpi=72, alpha=False).pixel(100, 700)[:3]
    fitz.TOOLS.set_icc(False)
    try:
        plain = doc[0].get_pixmap(dpi=72, alpha=False).pixel(100, 700)[:3]
    finally:
        fitz.TOOLS.set_icc(True)
    doc.close()
    assert managed != plain
    assert managed[1] > plain[1]  # the managed red is less saturated, like Acrobat/Chrome


def test_safe_dpi_caps_large_sheets_and_leaves_normal_pages_alone():
    doc = fitz.open()
    a4 = doc.new_page(width=595, height=842)
    assert render_color.safe_dpi(a4, 500) == 500
    poster = doc.new_page(width=3370, height=4768)  # A0
    capped = render_color.safe_dpi(poster, 500)
    assert capped < 500
    area_in = (3370 / 72) * (4768 / 72)
    assert area_in * capped * capped <= render_color.MAX_RENDER_PIXELS * 1.02
