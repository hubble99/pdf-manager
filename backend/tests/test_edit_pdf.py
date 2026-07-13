import base64
import io
import pytest
from httpx import AsyncClient, ASGITransport
from main import app
import fitz

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
async def test_edit_pdf_save():
    # 1x1 black pixel PNG base64
    dummy_png_base64 = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8"
        "AAAAASUVORK5CYII="
    )
    
    payload = {
        "pages": [dummy_png_base64],
        "output_filename": "test_edited_pdf"
    }
    
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/v1/edit-pdf/save", json=payload)
        
    assert resp.status_code == 200
    assert resp.headers.get("content-type") == "application/pdf"
    assert resp.headers.get("X-Total-Pages") == "1"
    assert "test_edited_pdf.pdf" in resp.headers.get("Content-Disposition")
