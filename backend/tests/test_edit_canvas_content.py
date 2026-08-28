"""Stable-scope tests: Edit Canvas excludes native/selectable text editing."""

import json

import fitz
from httpx import ASGITransport, AsyncClient

from main import app


def _make_source_pdf() -> bytes:
    document = fitz.open()
    page = document.new_page(width=200, height=200)
    page.insert_text((20, 40), "Original selectable text", fontsize=12)
    pdf_bytes = document.write()
    document.close()
    return pdf_bytes


async def test_text_structure_endpoint_is_not_exposed_in_stable_editor():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/v1/edit-canvas/text-structure",
            files={"file": ("source.pdf", _make_source_pdf(), "application/pdf")},
        )

    assert response.status_code == 404


async def test_save_rejects_legacy_content_edit_payload():
    annotations = [{
        "canvas_width": 200,
        "canvas_height": 200,
        "native_objects": [{
            "id": "legacy-native-text",
            "type": "content_edit",
            "rect": [18, 28, 150, 46],
            "text": "Replacement",
            "lines": [{"origin": [20, 40], "size": 12}],
            "style": {
                "fontFamily": "Arial",
                "fontSize": 12,
                "bold": False,
                "italic": False,
                "color": "#000000",
            },
        }],
    }]
    files = {
        "file": ("source.pdf", _make_source_pdf(), "application/pdf"),
        "annotations": (
            "annotations.json",
            json.dumps(annotations).encode("utf-8"),
            "application/json",
        ),
    }

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/v1/edit-canvas/save", files=files)

    assert response.status_code == 400
    assert "selectable text editing is unavailable" in response.json()["detail"].lower()
