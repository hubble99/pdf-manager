"""Organize workspace: document handles and bounded thumbnail batches."""
from pathlib import Path
import io

import fitz
import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from config import settings
from features.organize.documents import (
    MAX_DOCUMENTS,
    DocumentError,
    DocumentRegistry,
)


def make_pdf(path: Path, pages: int, colour=(200, 40, 40)) -> Path:
    with fitz.open() as doc:
        for index in range(pages):
            page = doc.new_page(width=200, height=300)
            shade = tuple(channel / 255 for channel in colour)
            page.draw_rect(page.rect, color=shade, fill=shade)
            page.insert_text((20, 40), f"PAGE {index + 1}", fontsize=16, color=(1, 1, 1))
        doc.save(path)
    return path


def make_image(path: Path, size=(240, 160), colour=(40, 120, 200)) -> Path:
    Image.new("RGB", size, colour).save(path)
    return path


@pytest.fixture(autouse=True)
def isolated_dirs(tmp_path, monkeypatch):
    output = tmp_path / "output"
    temp = tmp_path / "temp"
    output.mkdir()
    temp.mkdir()
    monkeypatch.setattr(settings, "OUTPUT_DIR", output)
    monkeypatch.setattr(settings, "TEMP_DIR", temp)


@pytest.fixture
def client():
    from main import app

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture(autouse=True)
def clean_registry():
    from features.organize.documents import registry

    registry.release_all()
    yield
    registry.release_all()


# ── handle registration ───────────────────────────────────────────────────────

def test_registry_reports_kind_and_page_count(tmp_path):
    registry = DocumentRegistry()
    pdf = make_pdf(tmp_path / "report.pdf", 4)
    image = make_image(tmp_path / "photo.png")

    pdf_handle = registry.register(pdf, "report.pdf")
    image_handle = registry.register(image, "photo.png")

    assert (pdf_handle.kind, pdf_handle.page_count) == ("pdf", 4)
    assert (image_handle.kind, image_handle.page_count) == ("image", 1)
    registry.release_all()


def test_registry_rejects_unsupported_and_broken_files(tmp_path):
    registry = DocumentRegistry()
    unsupported = tmp_path / "notes.txt"
    unsupported.write_text("hello", encoding="utf-8")
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"not a pdf")

    with pytest.raises(DocumentError):
        registry.register(unsupported, "notes.txt")
    with pytest.raises(DocumentError):
        registry.register(broken, "broken.pdf")


def test_release_removes_the_uploaded_content(tmp_path):
    registry = DocumentRegistry()
    path = make_pdf(tmp_path / "doc.pdf", 2)
    handle = registry.register(path, "doc.pdf")
    assert path.exists()

    assert registry.release(handle.document_id) is True
    assert not path.exists(), "released content must be deleted from disk"
    assert registry.release(handle.document_id) is False


def test_registry_evicts_the_oldest_document_when_full(tmp_path):
    registry = DocumentRegistry()
    handles = []
    for index in range(MAX_DOCUMENTS + 2):
        path = make_pdf(tmp_path / f"doc-{index}.pdf", 1)
        handles.append((registry.register(path, f"doc-{index}.pdf"), path))

    assert registry.count() == MAX_DOCUMENTS
    oldest_handle, oldest_path = handles[0]
    assert not oldest_path.exists(), "the evicted document's content must be deleted"
    with pytest.raises(DocumentError):
        registry.get(oldest_handle.document_id)
    registry.release_all()


def test_expired_handle_is_refused(tmp_path, monkeypatch):
    import time

    import features.organize.documents as documents_module

    registry = DocumentRegistry()
    path = make_pdf(tmp_path / "doc.pdf", 1)
    handle = registry.register(path, "doc.pdf")

    # Age the handle directly rather than depending on the clock resolution of
    # two consecutive time.time() calls.
    monkeypatch.setattr(documents_module, "DOCUMENT_TTL_SECONDS", 60)
    handle.last_used = time.time() - 600

    with pytest.raises(DocumentError):
        registry.get(handle.document_id)
    assert not path.exists(), "expired content must be deleted"


# ── HTTP surface ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_upload_returns_a_handle_and_release_removes_it(tmp_path):
    pdf = make_pdf(tmp_path / "report.pdf", 3)
    async with AsyncClient(transport=ASGITransport(app=__import__("main").app), base_url="http://test") as client:
        response = await client.post(
            "/api/v1/organize/documents/",
            files={"file": ("report.pdf", pdf.read_bytes(), "application/pdf")},
        )
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["kind"] == "pdf"
        assert data["page_count"] == 3

        from features.organize.documents import registry

        stored = registry.get(data["document_id"]).path
        assert stored.exists()

        released = await client.delete(f"/api/v1/organize/documents/{data['document_id']}")
        assert released.status_code == 200
        assert not stored.exists()

        missing = await client.delete(f"/api/v1/organize/documents/{data['document_id']}")
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_upload_rejects_an_unsupported_file(tmp_path):
    junk = tmp_path / "notes.txt"
    junk.write_text("hello", encoding="utf-8")
    async with AsyncClient(transport=ASGITransport(app=__import__("main").app), base_url="http://test") as client:
        response = await client.post(
            "/api/v1/organize/documents/",
            files={"file": ("notes.txt", junk.read_bytes(), "text/plain")},
        )
    assert response.status_code == 422
    assert "PDF" in response.json()["message"]


@pytest.mark.asyncio
async def test_thumbnails_are_page_indexed_and_bounded(tmp_path):
    pdf = make_pdf(tmp_path / "report.pdf", 30)
    async with AsyncClient(transport=ASGITransport(app=__import__("main").app), base_url="http://test") as client:
        upload = await client.post(
            "/api/v1/organize/documents/",
            files={"file": ("report.pdf", pdf.read_bytes(), "application/pdf")},
        )
        document_id = upload.json()["data"]["document_id"]

        batch = await client.post(
            f"/api/v1/organize/documents/{document_id}/thumbnails/",
            params={"start": 5, "count": 4, "target_width": 120},
        )
        assert batch.status_code == 200, batch.text
        data = batch.json()["data"]
        assert data["total"] == 30
        assert [entry["page"] for entry in data["pages"]] == [5, 6, 7, 8]

        first = data["pages"][0]
        with Image.open(io.BytesIO(__import__("base64").b64decode(first["data"]))) as thumb:
            assert thumb.width == 120, "thumbnails must honour the requested width"
            assert thumb.height > 0

        # A batch is bounded, so a large document cannot become one huge response.
        too_many = await client.post(
            f"/api/v1/organize/documents/{document_id}/thumbnails/",
            params={"start": 1, "count": 500},
        )
        assert too_many.status_code == 422

        out_of_range = await client.post(
            f"/api/v1/organize/documents/{document_id}/thumbnails/",
            params={"start": 99, "count": 4},
        )
        assert out_of_range.status_code == 422
        assert "out of range" in out_of_range.json()["message"].lower()


@pytest.mark.asyncio
async def test_thumbnails_reject_an_unknown_handle(tmp_path):
    async with AsyncClient(transport=ASGITransport(app=__import__("main").app), base_url="http://test") as client:
        response = await client.post(
            "/api/v1/organize/documents/does-not-exist/thumbnails/",
            params={"start": 1, "count": 4},
        )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_image_thumbnail_is_a_single_page(tmp_path):
    image = make_image(tmp_path / "photo.png")
    async with AsyncClient(transport=ASGITransport(app=__import__("main").app), base_url="http://test") as client:
        upload = await client.post(
            "/api/v1/organize/documents/",
            files={"file": ("photo.png", image.read_bytes(), "image/png")},
        )
        document_id = upload.json()["data"]["document_id"]
        assert upload.json()["data"]["page_count"] == 1

        batch = await client.post(
            f"/api/v1/organize/documents/{document_id}/thumbnails/",
            params={"start": 1, "count": 10, "target_width": 150},
        )
    data = batch.json()["data"]
    assert data["total"] == 1
    assert [entry["page"] for entry in data["pages"]] == [1]
