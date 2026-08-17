import base64
import io
import json
import math

import pytest
from httpx import AsyncClient, ASGITransport
from main import app
import fitz


def _rotated_corners(x, y, width, height, angle):
    center_x = x + width / 2
    center_y = y + height / 2
    radians = angle * 3.141592653589793 / 180
    cosine = math.cos(radians)
    sine = math.sin(radians)

    def rotate(point_x, point_y):
        dx = point_x - center_x
        dy = point_y - center_y
        return [
            center_x + dx * cosine - dy * sine,
            center_y + dx * sine + dy * cosine,
        ]

    return [
        rotate(x, y),
        rotate(x + width, y),
        rotate(x + width, y + height),
        rotate(x, y + height),
    ]

@pytest.mark.asyncio
async def test_pdf_to_image_pages():
    # Create a dummy PDF with 1 page
    doc = fitz.open()
    doc.new_page(width=100, height=200)
    pdf_bytes = doc.write()
    doc.close()
    
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        files = {"file": ("test.pdf", pdf_bytes, "application/pdf")}
        resp = await client.post("/api/v1/pdf-to-image/pages", files=files)
        
    assert resp.status_code == 200
    data = resp.json()
    assert "pages" in data
    assert data["total"] == 1
    assert data["pages"][0]["index"] == 0
    assert "data" in data["pages"][0]
    assert data["pages"][0]["width"] > 0


@pytest.mark.asyncio
async def test_pdf_to_image_page_uses_requested_dpi():
    doc = fitz.open()
    doc.new_page(width=72, height=144)
    pdf_bytes = doc.write()
    doc.close()

    files = {"file": ("test.pdf", pdf_bytes, "application/pdf")}
    data = {"page_index": "0", "dpi": "300"}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/v1/pdf-to-image/page", data=data, files=files)

    assert resp.status_code == 200
    page = resp.json()
    assert page["index"] == 0
    assert page["dpi"] == 300
    assert page["width"] == 300
    assert page["height"] == 600

@pytest.mark.asyncio
async def test_edit_pdf_save():
    doc = fitz.open()
    doc.new_page(width=100, height=200)
    pdf_bytes = doc.write()
    doc.close()

    # 1x1 black pixel PNG base64
    dummy_png_base64 = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8"
        "AAAAASUVORK5CYII="
    )

    annotations_json = json.dumps([dummy_png_base64])

    data = {
        "output_filename": "test_edited_pdf"
    }

    files = {
        "file": ("test.pdf", pdf_bytes, "application/pdf"),
        "annotations": ("annotations.json", annotations_json.encode('utf-8'), "application/json")
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/v1/edit-pdf/save", data=data, files=files)

    assert resp.status_code == 200
    assert resp.headers.get("content-type") == "application/pdf"
    assert resp.headers.get("X-Total-Pages") == "1"
    assert "test_edited_pdf.pdf" in resp.headers.get("Content-Disposition")


@pytest.mark.asyncio
async def test_edit_pdf_exports_supported_objects_without_raster_overlay():
    doc = fitz.open()
    source_page = doc.new_page(width=200, height=200)
    source_page.insert_text((12, 16), "Original vector background", fontsize=8)
    source_page.draw_line((10, 24), (190, 24), color=(0, 0, 0), width=1)
    pdf_bytes = doc.write()
    doc.close()

    annotations = [{
        "image_b64": "",
        "canvas_width": 200,
        "canvas_height": 200,
        "native_objects": [
            {
                "type": "rect",
                "x": 20,
                "y": 20,
                "width": 60,
                "height": 30,
                "angle": 45,
                "strokeColor": "#102030",
                "strokeWidth": 2,
                "fillColor": "#d0e0f0",
                "fillOpacity": 50,
            },
            {
                "type": "circle",
                "x": 40,
                "y": 40,
                "width": 80,
                "height": 40,
                "angle": 30,
                "vectorCorners": _rotated_corners(40, 40, 80, 40, 30),
                "strokeColor": "#0000ff",
                "strokeWidth": 2,
                "fillColor": "#d0d0ff",
                "fillOpacity": 75,
            },
            {
                "type": "line",
                "points": [20, 100, 120, 100],
                "angle": 30,
                "strokeColor": "#ff0000",
                "strokeWidth": 3,
            },
            {
                "type": "pen",
                "x": 0,
                "y": 0,
                "vectorPath": [["M", 20, 130], ["Q", 50, 110, 80, 130], ["L", 110, 120]],
                "strokeColor": "#008000",
                "strokeWidth": 2,
                "opacity": 1,
            },
            {
                "type": "text",
                "x": 20,
                "y": 160,
                "width": 140,
                "text": "Native vector text",
                "lines": ["Native vector text"],
                "fontFamily": "Arial",
                "fontSize": 12,
                "lineHeight": 1.16,
                "color": "#000000",
                "bold": False,
                "italic": False,
                "opacity": 1,
            },
        ],
    }]

    files = {
        "file": ("test.pdf", pdf_bytes, "application/pdf"),
        "annotations": ("annotations.json", json.dumps(annotations).encode("utf-8"), "application/json"),
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/v1/edit-pdf/save", files=files)

    assert resp.status_code == 200
    result = fitz.open(stream=resp.content, filetype="pdf")
    try:
        page = result[0]
        extracted_text = page.get_text().replace("\u00a0", " ")
        assert "Original vector background" in extracted_text
        assert "Native vector text" in extracted_text
        drawings = page.get_drawings()
        assert len(drawings) >= 5
        assert page.get_images(full=True) == []
        ellipse_bounds = [drawing["rect"] for drawing in drawings if drawing["rect"].width > 70]
        assert any(rect.x0 < 40 and rect.x1 > 120 and rect.y0 < 40 and rect.y1 > 80 for rect in ellipse_bounds)
    finally:
        result.close()


@pytest.mark.asyncio
async def test_edit_pdf_rejects_malformed_annotations_json():
    doc = fitz.open()
    doc.new_page(width=100, height=200)
    pdf_bytes = doc.write()
    doc.close()

    files = {
        "file": ("test.pdf", pdf_bytes, "application/pdf"),
        "annotations": ("annotations.json", b"[{", "application/json"),
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/v1/edit-pdf/save", files=files)

    assert resp.status_code == 400
    assert "Invalid annotations JSON at line" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_edit_pdf_rejects_non_array_annotations():
    doc = fitz.open()
    doc.new_page(width=100, height=200)
    pdf_bytes = doc.write()
    doc.close()

    files = {
        "file": ("test.pdf", pdf_bytes, "application/pdf"),
        "annotations": ("annotations.json", b'{}', "application/json"),
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/v1/edit-pdf/save", files=files)

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Annotations JSON must be an array with one entry per PDF page."
