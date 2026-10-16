"""Generated-file checks for the unified converter's existing engine contracts."""
import io
import json
import zipfile
from pathlib import Path

import fitz
import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image, ImageDraw, ImageOps

from config import settings
from core.image_to_pdf import ImageToPdfError, images_to_pdf
from core.pdf_to_image import PdfToImageError, pdf_to_image


@pytest.fixture(autouse=True)
def isolated_output(tmp_path, monkeypatch):
    output = tmp_path / "output"
    temp = tmp_path / "uploads"
    output.mkdir()
    temp.mkdir()
    monkeypatch.setattr(settings, "OUTPUT_DIR", output)
    monkeypatch.setattr(settings, "TEMP_DIR", temp)


@pytest.fixture
def asymmetric_image(tmp_path):
    image = Image.new("RGB", (120, 80), "white")
    draw = ImageDraw.Draw(image)
    for rectangle, color in [
        ((0, 0, 59, 39), "red"), ((60, 0, 119, 39), "lime"),
        ((0, 40, 59, 79), "blue"), ((60, 40, 119, 79), "yellow"),
    ]:
        draw.rectangle(rectangle, fill=color)
    path = tmp_path / "quadrants.png"
    image.save(path)
    return path


@pytest.fixture
def colored_pdf(tmp_path):
    path = tmp_path / "source.pdf"
    with fitz.open() as document:
        for color in [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0)]:
            page = document.new_page(width=72, height=144)
            page.draw_rect(page.rect, color=color, fill=color)
        document.save(path)
    return path


def render_page(page):
    pixmap = page.get_pixmap(dpi=72, alpha=False)
    return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)


def assert_sample_colors(actual, expected):
    for x, y in [(0.2, 0.2), (0.8, 0.2), (0.2, 0.8), (0.8, 0.8)]:
        actual_color = actual.getpixel((int(actual.width * x), int(actual.height * y)))
        expected_color = expected.getpixel((int(expected.width * x), int(expected.height * y)))
        assert actual_color == pytest.approx(expected_color, abs=12)


@pytest.mark.parametrize("page_size, dimensions", [
    ("a4", (595, 842)), ("a3", (842, 1191)),
    ("letter", (612, 792)), ("legal", (612, 1008)),
    ("a5", (148 * 72 / 25.4, 210 * 72 / 25.4)),
    ("f4", (210 * 72 / 25.4, 330 * 72 / 25.4)),
])
def test_paper_size_applies_to_entire_batch(tmp_path, asymmetric_image, page_size, dimensions):
    second = tmp_path / "portrait.jpg"
    Image.new("RGB", (80, 140), "cyan").save(second)
    original = asymmetric_image.read_bytes()
    result, count, size = images_to_pdf([asymmetric_image, second], page_size=page_size)
    assert count == 2
    assert size == result.stat().st_size
    with fitz.open(result) as document:
        assert document.page_count == 2
        for page, source_size in zip(document, [(120, 80), (80, 140)]):
            # Portrait images sit on the portrait page, landscape images on the same size turned sideways.
            expected = dimensions if source_size[0] <= source_size[1] else dimensions[::-1]
            assert (page.rect.width, page.rect.height) == pytest.approx(expected, abs=0.01)
            bounds = fitz.Rect(page.get_image_info()[0]["bbox"])
            assert bounds.width / bounds.height == pytest.approx(source_size[0] / source_size[1], abs=0.001)
            assert bounds.x0 == pytest.approx((page.rect.width - bounds.width) / 2, abs=0.01)
            assert bounds.y0 == pytest.approx((page.rect.height - bounds.height) / 2, abs=0.01)
            assert bounds.x0 >= -0.01 and bounds.y0 >= -0.01
            assert bounds.x1 <= page.rect.width + 0.01 and bounds.y1 <= page.rect.height + 0.01
    assert asymmetric_image.read_bytes() == original


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("mirror", [False, True])
def test_original_size_and_transforms_match_rendered_output(asymmetric_image, rotation, mirror):
    original = asymmetric_image.read_bytes()
    result, count, _ = images_to_pdf(
        [asymmetric_image], page_size="match_image", rotations=[rotation], flips_h=[mirror],
    )
    with Image.open(asymmetric_image) as source:
        expected = ImageOps.mirror(source) if mirror else source.copy()
        expected = expected.rotate(-rotation, expand=True)
    with fitz.open(result) as document:
        assert count == document.page_count == 1
        assert (document[0].rect.width, document[0].rect.height) == expected.size
        actual = render_page(document[0])
        assert actual.size == expected.size
        assert_sample_colors(actual, expected)
    assert asymmetric_image.read_bytes() == original


def test_reordered_images_keep_their_transforms(tmp_path, asymmetric_image):
    second = tmp_path / "second.png"
    Image.new("RGB", (80, 140), "cyan").save(second)
    result, _, _ = images_to_pdf(
        [second, asymmetric_image], page_size="match_image", rotations=[90, 0], flips_h=[False, True],
    )
    with fitz.open(result) as document:
        assert (document[0].rect.width, document[0].rect.height) == (140, 80)
        assert render_page(document[0]).getpixel((20, 20)) == pytest.approx((0, 255, 255), abs=12)
        with Image.open(asymmetric_image) as source:
            assert_sample_colors(render_page(document[1]), ImageOps.mirror(source))


def test_landscape_image_gets_landscape_paper(asymmetric_image):
    result, _, _ = images_to_pdf([asymmetric_image], page_size="a4")
    with fitz.open(result) as document:
        page = document[0]
        assert (page.rect.width, page.rect.height) == pytest.approx((842, 595), abs=0.01)
        bounds = fitz.Rect(page.get_image_info()[0]["bbox"])
        assert bounds.width == pytest.approx(page.rect.width, abs=0.5) or bounds.height == pytest.approx(page.rect.height, abs=0.5)


def test_square_image_stays_on_portrait_paper(tmp_path):
    path = tmp_path / "square.png"
    Image.new("RGB", (100, 100), "white").save(path)
    result, _, _ = images_to_pdf([path], page_size="a4")
    with fitz.open(result) as document:
        assert (document[0].rect.width, document[0].rect.height) == pytest.approx((595, 842), abs=0.01)


def test_image_rotation_does_not_rotate_fixed_paper(asymmetric_image):
    result, _, _ = images_to_pdf([asymmetric_image], page_size="f4", rotations=[90])
    with fitz.open(result) as document:
        assert (document[0].rect.width, document[0].rect.height) == pytest.approx(
            (210 * 72 / 25.4, 330 * 72 / 25.4), abs=0.01,
        )


def test_exif_orientation_is_applied_before_image_adjustments(tmp_path, asymmetric_image):
    path = tmp_path / "camera.jpg"
    with Image.open(asymmetric_image) as image:
        exif = image.getexif()
        exif[274] = 6
        image.save(path, exif=exif, quality=95)
    result, _, _ = images_to_pdf([path], page_size="match_image")
    with fitz.open(result) as document:
        assert (document[0].rect.width, document[0].rect.height) == (80, 120)
        with Image.open(path) as source:
            assert_sample_colors(render_page(document[0]), ImageOps.exif_transpose(source))


def test_unsupported_paper_size_still_fails(asymmetric_image):
    with pytest.raises(ImageToPdfError, match="Unsupported page size"):
        images_to_pdf([asymmetric_image], page_size="unknown")


@pytest.mark.parametrize("format, decoded_format", [("png", "PNG"), ("jpeg", "JPEG"), ("webp", "WEBP")])
@pytest.mark.parametrize("dpi", [72, 96, 150, 300])
def test_single_pdf_page_exports_direct_image(colored_pdf, format, decoded_format, dpi):
    original = colored_pdf.read_bytes()
    result, count, is_zip = pdf_to_image(colored_pdf, "2", format=format, dpi=dpi, clean_name="chosen")
    assert count == 1 and not is_zip
    assert result.name == f"chosen_page0002.{format}"
    with Image.open(result) as image:
        assert image.format == decoded_format
        assert image.size == (dpi, dpi * 2)
        assert image.convert("RGB").getpixel((10, 10)) == pytest.approx((0, 255, 0), abs=12)
    assert colored_pdf.read_bytes() == original


@pytest.mark.parametrize("selection, pages", [
    ("", [1, 2, 3, 4]), ("2-3", [2, 3]), ("4,1-2,2", [1, 2, 4]),
])
def test_pdf_zip_contains_only_unique_selected_pages_in_order(colored_pdf, selection, pages):
    result, count, is_zip = pdf_to_image(colored_pdf, selection, dpi=72, clean_name="chosen")
    assert count == len(pages) and is_zip
    colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
    with zipfile.ZipFile(result) as archive:
        assert archive.namelist() == [f"chosen_page{page:04d}.png" for page in pages]
        for page, name in zip(pages, archive.namelist()):
            with Image.open(io.BytesIO(archive.read(name))) as image:
                assert image.convert("RGB").getpixel((10, 10)) == colors[page - 1]


def test_all_pages_of_one_page_pdf_produces_image(tmp_path):
    source = tmp_path / "single.pdf"
    with fitz.open() as document:
        document.new_page()
        document.save(source)
    result, count, is_zip = pdf_to_image(source, "", dpi=72)
    assert count == 1 and not is_zip
    with Image.open(result) as image:
        assert image.format == "PNG"


@pytest.mark.parametrize("selection", ["0", "5", "2-1", "1,wrong"])
def test_invalid_pdf_range_still_fails(colored_pdf, selection):
    with pytest.raises(PdfToImageError):
        pdf_to_image(colored_pdf, selection)


@pytest.mark.asyncio
@pytest.mark.parametrize("page_size, status", [("a5", 200), ("f4", 200), ("unknown", 422)])
async def test_page_size_endpoint_contract(asymmetric_image, page_size, status):
    from main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/v1/image-to-pdf/",
            files=[("files", ("image.png", asymmetric_image.read_bytes(), "image/png"))],
            data={"page_size": page_size, "rotations": json.dumps([90]), "flips": json.dumps([True])},
        )
    assert response.status_code == status
    if status == 200:
        assert response.headers["x-total-pages"] == "1"
        assert response.headers["x-page-size"] == page_size.upper()
        with fitz.open(stream=response.content, filetype="pdf") as document:
            assert document.page_count == 1
    else:
        assert response.json()["status"] == "error"
