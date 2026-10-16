import fitz

from core.edit_canvas_shapes import draw_native_text


def _ink(page: fitz.Page) -> int:
    pixmap = page.get_pixmap(dpi=96, alpha=False)
    samples = pixmap.samples
    return sum(1 for i in range(0, len(samples), 3) if samples[i] < 128)


def _page_with(**overrides):
    document = fitz.open()
    page = document.new_page(width=300, height=120)
    item = {
        "x": 20, "y": 30, "text": "Weight Hamburg", "lines": ["Weight Hamburg"],
        "fontFamily": "Arial", "fontSize": 32, "fontWeight": 400, "width": 260,
        **overrides,
    }
    draw_native_text(page, item, 1, 1, (0, 0, 0))
    return document, page


def test_synthetic_weights_get_progressively_heavier():
    inks = []
    for weight, em in ((400, 0), (450, 0.01), (500, 0.02), (550, 0.03)):
        document, page = _page_with(fontWeight=weight, fontFaceWeight=400, syntheticStrokeEm=em)
        inks.append(_ink(page))
        document.close()
    assert inks == sorted(inks)
    assert len(set(inks)) == len(inks)


def test_synthetic_weight_stays_real_selectable_text():
    document, page = _page_with(fontWeight=500, fontFaceWeight=400, syntheticStrokeEm=0.02)
    assert page.get_text().strip() == "Weight Hamburg"
    document.close()


def test_synthetic_weight_follows_rotation_like_regular_text():
    plain_doc, plain = _page_with(angle=90, transformMatrix=[0, 1, -1, 0, 0, 0])
    thick_doc, thick = _page_with(
        angle=90, transformMatrix=[0, 1, -1, 0, 0, 0],
        fontWeight=500, fontFaceWeight=400, syntheticStrokeEm=0.02,
    )
    plain_box = plain.get_pixmap(dpi=72).irect
    plain_words = plain.get_text("words")
    thick_words = thick.get_text("words")
    assert plain_box == thick.get_pixmap(dpi=72).irect
    assert plain_words and thick_words
    for before, after in zip(plain_words, thick_words):
        assert all(abs(a - b) < 1.5 for a, b in zip(before[:4], after[:4]))
    plain_doc.close()
    thick_doc.close()


def test_missing_synthetic_fields_keep_the_old_behaviour():
    document, page = _page_with(fontWeight=400)
    assert page.get_text().strip() == "Weight Hamburg"
    document.close()


def test_embedded_font_is_used_for_synthetic_weight(monkeypatch, tmp_path):
    import pytest

    path = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
    if not __import__("os").path.exists(path):
        pytest.skip("no sample TrueType font on this machine")
    monkeypatch.setattr("core.edit_canvas_shapes.load_font", lambda *args: fitz.Font(fontfile=path))
    document, page = _page_with(fontWeight=500, fontFaceWeight=400, syntheticStrokeEm=0.02)
    out = tmp_path / "out.pdf"
    document.save(out)
    document.close()
    with fitz.open(out) as saved:
        assert saved[0].get_text().strip() == "Weight Hamburg"
        assert any("Liberation" in font[3] for font in saved[0].get_fonts())
