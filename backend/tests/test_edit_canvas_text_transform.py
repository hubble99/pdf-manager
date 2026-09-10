"""Regression coverage for source PDF transforms leaking into text overlays."""

import fitz
import pytest
from PIL import Image

from core.edit_canvas import save_edited_pdf
from core.edit_canvas_shapes import draw_native_text


def _render(page):
    pixmap = page.get_pixmap(alpha=False)
    return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)


def _red_pixels(image):
    samples = image.tobytes()
    return {
        offset // 3
        for offset in range(0, len(samples), 3)
        if samples[offset] > 150
        and samples[offset + 1] < 100
        and samples[offset + 2] < 100
    }


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("flip_y", [False, True])
@pytest.mark.parametrize("letter_spacing", [0, 150])
def test_text_overlay_ignores_source_transform(
    tmp_path, monkeypatch, rotation, flip_y, letter_spacing
):
    # A fixed built-in font keeps the visual comparison independent of the
    # user's installed fonts and app font library.
    monkeypatch.setattr(
        "core.edit_canvas_shapes.load_font", lambda *args: fitz.Font("helv")
    )
    source_path = tmp_path / "source.pdf"
    output_path = tmp_path / "edited.pdf"
    item = {
        "type": "text",
        "text": "CANVASTEST",
        "x": 40,
        "y": 40,
        "width": 180,
        "fontSize": 18,
        "letterSpacing": letter_spacing,
        "color": "#ff0000",
        "angle": 0,
    }
    with fitz.open() as source:
        page = source.new_page(width=300, height=400)
        page.insert_text((20, 20), "Original source")
        page.draw_line((20, 100), (260, 160), color=(0, 0, 0))
        if flip_y:
            # Valid PDF content may leave a transform active at the end of
            # /Contents. This models the vertical flip used by PDF producers.
            xref = page.get_contents()[0]
            source.update_stream(
                xref, b"1 0 0 -1 0 400 cm\n" + source.xref_stream(xref)
            )
        page.set_rotation(rotation)
        source.save(source_path)
        before = _render(page)
        width, height = page.rect.width, page.rect.height

    # A clean page is the visual oracle for upright text at the requested
    # coordinates; extraction alone cannot detect vertically mirrored glyphs.
    # Include the rendered source so glyph edges blend against the same pixels.
    with fitz.open() as reference:
        page = reference.new_page(width=width, height=height)
        page.insert_image(page.rect, pixmap=fitz.Pixmap(
            fitz.csRGB, before.width, before.height, before.tobytes(), False
        ))
        draw_native_text(page, item, 1, 1, (1, 0, 0))
        expected_text = _red_pixels(_render(page))
    assert expected_text

    save_edited_pdf(source_path, [{
        "canvas_width": width,
        "canvas_height": height,
        "native_objects": [item],
    }], output_path)

    with fitz.open(output_path) as result:
        after = _render(result[0])
        assert after.size == before.size
        assert _red_pixels(after) == expected_text
        assert "CANVASTEST" in result[0].get_text().replace(" ", "")
        assert result[0].get_images(full=True) == []

    # The text region may change, but the source's rendered appearance outside
    # it must remain identical, including when page rotation is normalized.
    for image in (before, after):
        image.paste((255, 255, 255), (35, 35, 235, 80))
    assert after.tobytes() == before.tobytes()
