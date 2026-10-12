"""F3 spike outcome: page mirroring and the orientation composition.

Expectations are derived from the workspace grid's own semantics
(``rotate(<rotation>) scaleX(-1)``) by transforming an untouched render of the
source page, then compared against a render of the transformed PDF page. This
keeps the check independent of how the transform is implemented.
"""
from pathlib import Path

import fitz
import pytest
from PIL import Image

from core.pdf_page_transform import apply_orientation, mirror_page

WIDTH, HEIGHT = 400.0, 300.0
DPI = 72
CENTROID_TOLERANCE = 6.0

RED = (220, 30, 30)
BLUE = (30, 60, 220)


def build_fixture(path: Path, offset: tuple[float, float] = (0.0, 0.0)) -> None:
    """An asymmetric page: two differently coloured markers plus text."""
    ox, oy = offset
    with fitz.open() as doc:
        page = doc.new_page(width=WIDTH, height=HEIGHT)
        if offset != (0.0, 0.0):
            page.set_mediabox(fitz.Rect(ox, oy, ox + WIDTH, oy + HEIGHT))
            page = doc.reload_page(page)
        page.draw_rect(fitz.Rect(ox + 20, oy + 40, ox + 70, oy + 90), color=_f(RED), fill=_f(RED))
        page.draw_rect(fitz.Rect(ox + 330, oy + 210, ox + 380, oy + 260), color=_f(BLUE), fill=_f(BLUE))
        page.insert_text((ox + 30, oy + 150), "MIRROR-ME", fontsize=18, color=(0, 0, 0))
        doc.save(path)


def _f(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    return tuple(channel / 255 for channel in rgb)  # type: ignore[return-value]


def render(page: fitz.Page, dpi: int = DPI) -> Image.Image:
    pixmap = page.get_pixmap(dpi=dpi, alpha=False)
    return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)


def centroid(image: Image.Image, rgb: tuple[int, int, int]) -> tuple[float, float] | None:
    """Centre of mass of the pixels matching one marker colour."""
    pixels = image.convert("RGB")
    total_x = total_y = count = 0
    for y in range(pixels.height):
        for x in range(pixels.width):
            r, g, b = pixels.getpixel((x, y))
            if abs(r - rgb[0]) < 60 and abs(g - rgb[1]) < 60 and abs(b - rgb[2]) < 60:
                total_x += x
                total_y += y
                count += 1
    if count == 0:
        return None
    return (total_x / count, total_y / count)


def expected_render(source: Image.Image, rotation: int, flip: bool) -> Image.Image:
    """Apply the grid's transform to an untouched render of the source page.

    The grid renders ``rotate(<rotation>) scaleX(-1)``, which CSS applies
    right-to-left: mirror first, then rotate clockwise. PIL rotates
    counter-clockwise for a positive angle, hence the negated rotation.
    """
    result = source.transpose(Image.FLIP_LEFT_RIGHT) if flip else source
    if rotation % 360:
        result = result.rotate(-(rotation % 360), expand=True)
    return result


def assert_matches(actual: Image.Image, expected: Image.Image, label: str) -> None:
    assert actual.size == expected.size, f"{label}: size {actual.size} != {expected.size}"
    for name, colour in (("red", RED), ("blue", BLUE)):
        actual_centre = centroid(actual, colour)
        expected_centre = centroid(expected, colour)
        assert actual_centre is not None, f"{label}: {name} marker missing from output"
        assert expected_centre is not None, f"{label}: {name} marker missing from expectation"
        dx = abs(actual_centre[0] - expected_centre[0])
        dy = abs(actual_centre[1] - expected_centre[1])
        assert dx <= CENTROID_TOLERANCE and dy <= CENTROID_TOLERANCE, (
            f"{label}: {name} marker at {actual_centre} but expected {expected_centre}"
        )


@pytest.fixture
def plain_pdf(tmp_path: Path) -> Path:
    path = tmp_path / "plain.pdf"
    build_fixture(path)
    return path


@pytest.fixture
def offset_pdf(tmp_path: Path) -> Path:
    path = tmp_path / "offset.pdf"
    build_fixture(path, offset=(50.0, 30.0))
    return path


def test_mirror_moves_content_across_the_page(plain_pdf: Path) -> None:
    with fitz.open(plain_pdf) as doc:
        before = render(doc[0])
        mirror_page(doc, doc[0])
        after = render(doc[0])

    red_before = centroid(before, RED)
    red_after = centroid(after, RED)
    assert red_before and red_after

    # The red marker starts near the left edge and must end near the mirrored x.
    assert red_before[0] < before.width * 0.25
    assert abs(red_after[0] - (before.width - red_before[0])) <= CENTROID_TOLERANCE
    assert abs(red_after[1] - red_before[1]) <= CENTROID_TOLERANCE, "mirroring must not move content vertically"


def test_mirror_handles_a_non_zero_cropbox_origin(offset_pdf: Path) -> None:
    """A cropbox that does not start at zero must not shift the mirrored page."""
    with fitz.open(offset_pdf) as doc:
        page = doc[0]
        cropbox_before = fitz.Rect(page.cropbox)
        before = render(page)
        mirror_page(doc, page)
        after = render(page)
        cropbox_after = fitz.Rect(doc[0].cropbox)

    assert cropbox_after == cropbox_before
    assert_matches(after, before.transpose(Image.FLIP_LEFT_RIGHT), "offset-origin mirror")


def test_mirror_preserves_text_and_vector_content(plain_pdf: Path) -> None:
    with fitz.open(plain_pdf) as doc:
        before_text = doc[0].get_text().strip()
        images_before = len(doc[0].get_images())
        mirror_page(doc, doc[0])
        after_text = doc[0].get_text().strip()
        images_after = len(doc[0].get_images())
        drawings_after = len(doc[0].get_drawings())

    assert before_text == "MIRROR-ME"
    assert after_text == before_text, "mirrored text must remain real, extractable text"
    assert images_before == images_after == 0, "mirroring must not rasterize the page"
    assert drawings_after > 0, "vector content must survive mirroring"


def test_mirroring_twice_restores_the_original(plain_pdf: Path) -> None:
    with fitz.open(plain_pdf) as doc:
        before = render(doc[0])
        mirror_page(doc, doc[0])
        mirror_page(doc, doc[0])
        after = render(doc[0])

    assert_matches(after, before, "double mirror")


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_rotation_matches_the_grid(plain_pdf: Path, rotation: int) -> None:
    with fitz.open(plain_pdf) as doc:
        source = render(doc[0])
        apply_orientation(doc, doc[0], rotation=rotation)
        actual = render(doc[0])

    assert_matches(actual, expected_render(source, rotation, flip=False), f"rotation {rotation}")


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_mirror_combined_with_rotation_matches_the_grid(plain_pdf: Path, rotation: int) -> None:
    """The saved page must agree with the grid for a rotated *and* mirrored page."""
    with fitz.open(plain_pdf) as doc:
        source = render(doc[0])
        apply_orientation(doc, doc[0], rotation=rotation, flip=True)
        actual = render(doc[0])

    assert_matches(
        actual,
        expected_render(source, rotation, flip=True),
        f"mirror + rotation {rotation}",
    )


def test_orientation_does_not_change_page_size_or_cropbox(plain_pdf: Path) -> None:
    with fitz.open(plain_pdf) as doc:
        original = fitz.Rect(doc[0].cropbox)
        apply_orientation(doc, doc[0], rotation=90, flip=True)
        # `cropbox` is the stored page box and must not change; `rect` reports the
        # rotated view, so quarter turns legitimately swap its width and height.
        assert fitz.Rect(doc[0].cropbox) == original
        assert doc[0].rect.width == pytest.approx(HEIGHT)
        assert doc[0].rect.height == pytest.approx(WIDTH)


def test_mirror_reflects_every_content_stream(plain_pdf: Path) -> None:
    """A page split into several content streams must be mirrored in full.

    PyMuPDF writes one stream per drawing operation, and a page renders as the
    concatenation of all of them. Mirroring only the first stream would move the
    first element and leave the rest behind.
    """
    with fitz.open(plain_pdf) as doc:
        assert len(doc[0].get_contents()) > 1, "fixture must have several content streams"
        before = render(doc[0])
        red_before = centroid(before, RED)
        blue_before = centroid(before, BLUE)
        mirror_page(doc, doc[0])
        after = render(doc[0])

    red_after = centroid(after, RED)
    blue_after = centroid(after, BLUE)
    assert red_before and red_after and blue_before and blue_after
    # Both markers must cross the page, not just the first drawn one.
    assert abs(red_after[0] - (before.width - red_before[0])) <= CENTROID_TOLERANCE
    assert abs(blue_after[0] - (before.width - blue_before[0])) <= CENTROID_TOLERANCE
    assert red_before[0] < before.width / 2 < blue_before[0]
    assert blue_after[0] < after.width / 2 < red_after[0]


def test_mirror_is_a_no_op_for_a_page_without_content(tmp_path: Path) -> None:
    path = tmp_path / "empty.pdf"
    with fitz.open() as doc:
        doc.new_page(width=WIDTH, height=HEIGHT)
        doc.save(path)

    with fitz.open(path) as doc:
        mirror_page(doc, doc[0])  # must not raise
        assert doc[0].rect.width == pytest.approx(WIDTH)
