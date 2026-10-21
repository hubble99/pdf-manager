import base64
import io
import json
import math

import fitz
import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from core.edit_canvas import EditCanvasStampError, save_edited_pdf
from core.edit_canvas_images import CanvasImageError, image_corners, prepare_image_stream
from main import app

RED = (255, 0, 0)
BLUE = (0, 0, 255)
WHITE = (255, 255, 255)


def _quadrant_image(fmt="PNG", size=(200, 100), exif_orientation=None):
    """Red top-left quadrant, blue bottom-right quadrant, white elsewhere."""
    width, height = size
    image = Image.new("RGB", size, WHITE)
    image.paste(RED, (0, 0, width // 2, height // 2))
    image.paste(BLUE, (width // 2, height // 2, width, height))
    output = io.BytesIO()
    if exif_orientation is not None:
        exif = Image.Exif()
        exif[0x0112] = exif_orientation
        image.save(output, format=fmt, exif=exif.tobytes())
    else:
        image.save(output, format=fmt)
    return output.getvalue()


def _data_url(raw, mime="image/png"):
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def _corners(x, y, width, height, angle):
    """Corners as Fabric reports them for an object whose origin is its top-left corner."""
    radians = math.radians(angle)
    cos_a, sin_a = math.cos(radians), math.sin(radians)
    return [
        [x + px * cos_a - py * sin_a, y + px * sin_a + py * cos_a]
        for px, py in [(0, 0), (width, 0), (width, height), (0, height)]
    ]


def _blank_pdf(tmp_path, width=400, height=400, rotation=0):
    path = tmp_path / "input.pdf"
    document = fitz.open()
    page = document.new_page(width=width, height=height)
    if rotation:
        page.set_rotation(rotation)
    document.save(str(path))
    document.close()
    return path


def _image_object(x, y, width, height, angle=0, opacity=1, asset_id="img1", with_corners=True):
    item = {
        "id": "obj1",
        "type": "image",
        "assetId": asset_id,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "angle": angle,
        "opacity": opacity,
    }
    if with_corners:
        item["vectorCorners"] = _corners(x, y, width, height, angle)
    return item


def _render(tmp_path, annotations, **pdf_options):
    source = _blank_pdf(tmp_path, **pdf_options)
    output = tmp_path / "output.pdf"
    save_edited_pdf(source, annotations, output)
    document = fitz.open(str(output))
    pixmap = document[0].get_pixmap(dpi=72)
    images = document[0].get_images(full=True)
    document.close()
    return pixmap, images


def _near(color, expected, tolerance=40):
    return all(abs(channel - target) <= tolerance for channel, target in zip(color, expected))


def _page(item, asset=None, canvas_width=400, canvas_height=400):
    return {
        "image_b64": "",
        "canvas_width": canvas_width,
        "canvas_height": canvas_height,
        "native_objects": [item],
        "image_assets": {"img1": asset or _data_url(_quadrant_image())},
    }


def test_image_is_placed_at_its_position_and_size(tmp_path):
    pixmap, images = _render(tmp_path, [_page(_image_object(100, 50, 200, 100))])
    assert len(images) == 1
    assert _near(pixmap.pixel(150, 75), RED)
    assert _near(pixmap.pixel(250, 125), BLUE)
    assert _near(pixmap.pixel(250, 75), WHITE)
    # Outside the object the page stays blank.
    assert _near(pixmap.pixel(90, 75), WHITE)
    assert _near(pixmap.pixel(310, 125), WHITE)


def test_image_scales_from_canvas_units_to_page_units(tmp_path):
    # Canvas is twice as large as the page, so every coordinate halves.
    pixmap, _ = _render(tmp_path, [_page(_image_object(200, 100, 400, 200), canvas_width=800, canvas_height=800)])
    assert _near(pixmap.pixel(150, 75), RED)
    assert _near(pixmap.pixel(250, 125), BLUE)


def test_image_can_be_stretched(tmp_path):
    pixmap, _ = _render(tmp_path, [_page(_image_object(50, 50, 100, 300))])
    assert _near(pixmap.pixel(70, 100), RED)
    assert _near(pixmap.pixel(130, 300), BLUE)
    assert _near(pixmap.pixel(130, 100), WHITE)


@pytest.mark.parametrize("with_corners", [True, False])
def test_image_rotates_clockwise_like_the_editor(tmp_path, with_corners):
    # A quarter turn clockwise around the top-left corner at (300, 100):
    # the red quadrant ends up right of x=250 and above y=200.
    item = _image_object(300, 100, 200, 100, angle=90, with_corners=with_corners)
    pixmap, _ = _render(tmp_path, [_page(item)])
    assert _near(pixmap.pixel(275, 150), RED)
    assert _near(pixmap.pixel(225, 250), BLUE)
    assert _near(pixmap.pixel(225, 150), WHITE)


def test_image_supports_any_rotation_angle(tmp_path):
    item = _image_object(150, 100, 200, 100, angle=30)
    corners = _corners(150, 100, 200, 100, 30)
    pixmap, _ = _render(tmp_path, [_page(item)])

    def inside(u, v):
        top_left, top_right, _, bottom_left = corners
        return (
            top_left[0] + (top_right[0] - top_left[0]) * u + (bottom_left[0] - top_left[0]) * v,
            top_left[1] + (top_right[1] - top_left[1]) * u + (bottom_left[1] - top_left[1]) * v,
        )

    red_x, red_y = inside(0.25, 0.25)
    blue_x, blue_y = inside(0.75, 0.75)
    assert _near(pixmap.pixel(round(red_x), round(red_y)), RED)
    assert _near(pixmap.pixel(round(blue_x), round(blue_y)), BLUE)


def test_image_opacity_blends_with_the_page(tmp_path):
    pixmap, _ = _render(tmp_path, [_page(_image_object(100, 50, 200, 100, opacity=0.5))])
    red, green, blue = pixmap.pixel(150, 75)
    assert red > 230
    assert 100 < green < 160
    assert 100 < blue < 160


def test_image_on_rotated_page_keeps_editor_position(tmp_path):
    # The editor shows rotated pages upright; the saved page must match that view.
    pixmap, _ = _render(tmp_path, [_page(_image_object(100, 50, 200, 100), canvas_width=400, canvas_height=300)], width=300, height=400, rotation=90)
    # After remove_rotation the page is 400 wide and 300 high, like the editor.
    assert pixmap.width == 400
    assert _near(pixmap.pixel(150, 75), RED)
    assert _near(pixmap.pixel(250, 125), BLUE)


def test_webp_and_jpeg_images_are_embedded(tmp_path):
    webp = _data_url(_quadrant_image("WEBP"), "image/webp")
    pixmap, images = _render(tmp_path, [_page(_image_object(100, 50, 200, 100), asset=webp)])
    assert len(images) == 1
    assert _near(pixmap.pixel(150, 75), RED)

    jpeg_raw = _quadrant_image("JPEG")
    assert prepare_image_stream(jpeg_raw) == jpeg_raw
    pixmap, _ = _render(tmp_path, [_page(_image_object(100, 50, 200, 100), asset=_data_url(jpeg_raw, "image/jpeg"))])
    assert _near(pixmap.pixel(150, 75), RED)


def test_jpeg_exif_orientation_matches_the_browser_view(tmp_path):
    # Orientation 6 means "rotate 90 degrees clockwise to display". Browsers apply it,
    # so the editor shows a 100x200 image with the red quadrant at the top right.
    raw = _quadrant_image("JPEG", exif_orientation=6)
    prepared = Image.open(io.BytesIO(prepare_image_stream(raw)))
    assert prepared.size == (100, 200)

    pixmap, _ = _render(tmp_path, [_page(_image_object(100, 100, 100, 200), asset=_data_url(raw, "image/jpeg"))])
    assert _near(pixmap.pixel(175, 150), RED)
    assert _near(pixmap.pixel(125, 250), BLUE)


def test_same_image_used_twice_is_stored_once(tmp_path):
    first = _image_object(20, 20, 100, 50)
    second = {**_image_object(200, 200, 150, 75), "id": "obj2"}
    page = _page(first)
    page["native_objects"].append(second)
    source = _blank_pdf(tmp_path)
    output = tmp_path / "output.pdf"
    save_edited_pdf(source, [page], output)
    document = fitz.open(str(output))
    try:
        xrefs = {image[0] for image in document[0].get_images(full=True)}
        assert len(xrefs) == 1
    finally:
        document.close()


def test_missing_or_broken_image_data_reports_the_page(tmp_path):
    source = _blank_pdf(tmp_path)
    broken = _page(_image_object(10, 10, 50, 50), asset="data:image/png;base64,bm90IGFuIGltYWdl")
    with pytest.raises(EditCanvasStampError, match="page index 0"):
        save_edited_pdf(source, [broken], tmp_path / "broken.pdf")

    missing = _page(_image_object(10, 10, 50, 50, asset_id="unknown"))
    with pytest.raises(EditCanvasStampError, match="no image data"):
        save_edited_pdf(source, [missing], tmp_path / "missing.pdf")


def test_prepare_image_stream_rejects_non_images():
    with pytest.raises(CanvasImageError):
        prepare_image_stream(b"not an image")


def test_image_corners_fallback_matches_editor_rotation():
    corners = image_corners({"x": 10, "y": 20, "width": 30, "height": 40, "angle": 90}, 1, 1)
    assert [(round(point.x, 6), round(point.y, 6)) for point in corners] == [(10, 20), (10, 50), (-30, 50), (-30, 20)]


@pytest.mark.asyncio
async def test_save_endpoint_embeds_image_objects():
    document = fitz.open()
    document.new_page(width=400, height=400)
    pdf_bytes = document.write()
    document.close()

    annotations = [_page(_image_object(100, 50, 200, 100))]
    files = {
        "file": ("test.pdf", pdf_bytes, "application/pdf"),
        "annotations": ("annotations.json", json.dumps(annotations).encode("utf-8"), "application/json"),
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/v1/edit-canvas/save", files=files, data={"output_filename": "canvas_image_test"})

    assert response.status_code == 200
    result = fitz.open(stream=response.content, filetype="pdf")
    try:
        assert len(result[0].get_images(full=True)) == 1
        assert _near(result[0].get_pixmap(dpi=72).pixel(150, 75), RED)
    finally:
        result.close()
