"""Compress keeps transparency instead of filling it in with black."""
import io
import random

import fitz
import pytest
from PIL import Image, ImageDraw

from config import settings
from core.pdf_compress import CompressError, compress_pdf


@pytest.fixture(autouse=True)
def isolated_output(tmp_path, monkeypatch):
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.setattr(settings, "OUTPUT_DIR", output)


def noisy_rgb(size=(320, 320)):
    rng = random.Random(7)
    return Image.frombytes("RGB", size, bytes(rng.randrange(256) for _ in range(size[0] * size[1] * 3)))


def render(path, dpi=72):
    with fitz.open(path) as document:
        pixmap = document[0].get_pixmap(dpi=dpi, alpha=False)
        return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)


def pdf_with_image(tmp_path, image, name="source.pdf"):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    path = tmp_path / name
    with fitz.open() as document:
        page = document.new_page(width=300, height=300)
        page.insert_image(fitz.Rect(10, 10, 290, 290), stream=buffer.getvalue())
        document.save(path)
    return path


def test_transparent_corners_stay_transparent(tmp_path):
    # Black sits under the fully transparent corners, exactly the case that
    # used to turn into solid black boxes after the re-encode.
    picture = noisy_rgb().convert("RGBA")
    alpha = Image.new("L", picture.size, 0)
    ImageDraw.Draw(alpha).ellipse((20, 20, 300, 300), fill=255)
    picture.putalpha(alpha)
    black = Image.new("RGBA", picture.size, (0, 0, 0, 0))
    picture = Image.composite(picture, black, alpha)
    source = pdf_with_image(tmp_path, picture)

    before = render(source)
    result = compress_pdf(source, quality=30, output_filename="out.pdf")
    after = render(result["output_path"])

    assert result["images_processed"] == 1
    assert result["size_after"] < result["size_before"]
    corner = (14, 14)
    assert before.getpixel(corner) == (255, 255, 255)
    assert after.getpixel(corner) == (255, 255, 255)
    centre = (150, 150)
    assert sum(abs(a - b) for a, b in zip(before.getpixel(centre), after.getpixel(centre))) < 160


def test_opaque_photo_is_smaller_and_still_similar(tmp_path):
    source = pdf_with_image(tmp_path, noisy_rgb())
    result = compress_pdf(source, quality=40, output_filename="out.pdf")
    assert result["images_processed"] == 1
    assert result["size_after"] < result["size_before"]
    with fitz.open(result["output_path"]) as document:
        assert document.page_count == 1


def test_stencil_masks_are_left_alone(tmp_path):
    stencil = Image.new("1", (64, 64), 1)
    ImageDraw.Draw(stencil).rectangle((8, 8, 40, 40), fill=0)
    source = tmp_path / "stencil.pdf"
    with fitz.open() as document:
        page = document.new_page(width=100, height=100)
        xref = page.insert_image(fitz.Rect(0, 0, 100, 100), stream=_png(stencil))
        document.xref_set_key(xref, "ImageMask", "true")
        document.save(source)
    result = compress_pdf(source, quality=30, output_filename="out.pdf")
    assert result["images_processed"] == 0


def _png(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.mark.parametrize("quality", [9, 96])
def test_quality_is_validated(tmp_path, quality):
    source = pdf_with_image(tmp_path, noisy_rgb((32, 32)))
    with pytest.raises(CompressError):
        compress_pdf(source, quality=quality)
