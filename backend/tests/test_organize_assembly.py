"""Organize workspace: list-based assembly of the final page order."""
from pathlib import Path

import fitz
import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from config import settings
from core.organize_assembly import OrganizeAssemblyError, assemble_pages
from features.organize.documents import DocumentRegistry

PAGE_COLOURS = [
    (200, 40, 40), (40, 180, 80), (40, 90, 220), (230, 200, 40), (190, 60, 180),
]


def make_pdf(path: Path, page_count: int) -> Path:
    with fitz.open() as doc:
        for index in range(page_count):
            page = doc.new_page(width=200, height=300)
            colour = tuple(channel / 255 for channel in PAGE_COLOURS[index % len(PAGE_COLOURS)])
            page.draw_rect(page.rect, color=colour, fill=colour)
            page.insert_text((20, 40), f"SRC {index + 1}", fontsize=16, color=(1, 1, 1))
        doc.save(path)
    return path


def make_marker_pdf(path: Path) -> Path:
    """A page with an off-centre marker so rotation and mirror are detectable."""
    with fitz.open() as doc:
        page = doc.new_page(width=200, height=300)
        red = (220 / 255, 30 / 255, 30 / 255)
        page.draw_rect(fitz.Rect(20, 40, 60, 80), color=red, fill=red)
        page.insert_text((20, 200), "MARKER", fontsize=14, color=(0, 0, 0))
        doc.save(path)
    return path


def make_image(path: Path, size=(240, 160), colour=(30, 150, 150)) -> Path:
    Image.new("RGB", size, colour).save(path)
    return path


def centre_colour(page: fitz.Page) -> tuple[int, int, int]:
    pixmap = page.get_pixmap(dpi=36, alpha=False)
    image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    return image.getpixel((image.width // 2, image.height // 2))


def marker_x(page: fitz.Page) -> float:
    pixmap = page.get_pixmap(dpi=72, alpha=False)
    image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    total = count = 0
    for y in range(image.height):
        for x in range(image.width):
            r, g, b = image.getpixel((x, y))
            if r > 150 and g < 100 and b < 100:
                total += x
                count += 1
    assert count, "marker missing"
    return total / count


@pytest.fixture(autouse=True)
def isolated_dirs(tmp_path, monkeypatch):
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.setattr(settings, "OUTPUT_DIR", output)


@pytest.fixture
def sources(tmp_path):
    """A two-document registry: a five-page PDF and one image."""
    registry = DocumentRegistry()
    pdf = registry.register(make_pdf(tmp_path / "source.pdf", 5), "source.pdf")
    image = registry.register(make_image(tmp_path / "photo.png"), "photo.png")
    documents = {pdf.document_id: pdf, image.document_id: image}
    yield documents, pdf, image
    registry.release_all()


def ref(source, page=1, rotation=0, flip=False):
    return {"source": source, "page": page, "rotation": rotation, "flip": flip}


# ── ordering and identity ─────────────────────────────────────────────────────

def test_output_follows_the_list_order_and_identity(sources):
    documents, pdf, _ = sources
    entries = [ref(pdf.document_id, 3), ref(pdf.document_id, 1), ref(pdf.document_id, 5)]

    path, total, size = assemble_pages(entries, documents, "ordered.pdf")
    assert total == 3
    assert size == path.stat().st_size

    with fitz.open(path) as doc:
        assert doc.page_count == 3
        assert [centre_colour(doc[i]) for i in range(3)] == [
            PAGE_COLOURS[2], PAGE_COLOURS[0], PAGE_COLOURS[4],
        ]


def test_duplicates_appear_once_per_list_entry(sources):
    documents, pdf, _ = sources
    entries = [ref(pdf.document_id, 2), ref(pdf.document_id, 2), ref(pdf.document_id, 2)]

    path, total, _ = assemble_pages(entries, documents, "dupes.pdf")
    with fitz.open(path) as doc:
        assert total == doc.page_count == 3
        assert [centre_colour(doc[i]) for i in range(3)] == [PAGE_COLOURS[1]] * 3


def test_deletion_is_expressed_by_omitting_pages(sources):
    documents, pdf, _ = sources
    # Keep pages 1 and 4 only; 2, 3 and 5 are deleted.
    entries = [ref(pdf.document_id, 1), ref(pdf.document_id, 4)]

    path, _, _ = assemble_pages(entries, documents, "trimmed.pdf")
    with fitz.open(path) as doc:
        assert [centre_colour(doc[i]) for i in range(2)] == [PAGE_COLOURS[0], PAGE_COLOURS[3]]


def test_pages_from_several_sources_are_interleaved(tmp_path):
    registry = DocumentRegistry()
    first = registry.register(make_pdf(tmp_path / "a.pdf", 2), "a.pdf")
    second = registry.register(make_pdf(tmp_path / "b.pdf", 2), "b.pdf")
    documents = {first.document_id: first, second.document_id: second}
    entries = [
        ref(first.document_id, 1), ref(second.document_id, 2),
        ref(first.document_id, 2), ref(second.document_id, 1),
    ]

    path, total, _ = assemble_pages(entries, documents, "mixed.pdf")
    with fitz.open(path) as doc:
        assert total == doc.page_count == 4
        assert [centre_colour(doc[i]) for i in range(4)] == [
            PAGE_COLOURS[0], PAGE_COLOURS[1], PAGE_COLOURS[1], PAGE_COLOURS[0],
        ]
    registry.release_all()


# ── orientation ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_rotation_matches_the_requested_turn(tmp_path, rotation):
    registry = DocumentRegistry()
    handle = registry.register(make_marker_pdf(tmp_path / "marker.pdf"), "marker.pdf")
    documents = {handle.document_id: handle}

    upright, _, _ = assemble_pages([ref(handle.document_id)], documents, "upright.pdf")
    rotated, _, _ = assemble_pages([ref(handle.document_id, rotation=rotation)], documents, f"rot{rotation}.pdf")

    with fitz.open(upright) as plain, fitz.open(rotated) as turned:
        base = marker_x(plain[0])
        actual = marker_x(turned[0])
        expected = {
            0: base,
            90: 300 - 60,      # marker near the top becomes near the right
            180: 200 - base,
            270: 60,
        }[rotation]
        assert abs(actual - expected) < 12, f"rotation {rotation}: marker at {actual}, expected near {expected}"
    registry.release_all()


def test_mirroring_is_preserved_in_the_saved_output(tmp_path):
    registry = DocumentRegistry()
    handle = registry.register(make_marker_pdf(tmp_path / "marker.pdf"), "marker.pdf")
    documents = {handle.document_id: handle}

    plain, _, _ = assemble_pages([ref(handle.document_id)], documents, "plain.pdf")
    flipped, _, _ = assemble_pages([ref(handle.document_id, flip=True)], documents, "flipped.pdf")

    with fitz.open(plain) as before, fitz.open(flipped) as after:
        width = before[0].rect.width
        assert abs(marker_x(after[0]) - (width - marker_x(before[0]))) < 8
        # Mirroring must keep the page's text selectable, not rasterize it.
        assert "MARKER" in after[0].get_text()
        assert not after[0].get_images(), "a mirrored text page must not become an image"
    registry.release_all()


def test_mirror_and_rotation_compose_consistently(tmp_path):
    registry = DocumentRegistry()
    handle = registry.register(make_marker_pdf(tmp_path / "marker.pdf"), "marker.pdf")
    documents = {handle.document_id: handle}

    plain, _, _ = assemble_pages([ref(handle.document_id)], documents, "p.pdf")
    with fitz.open(plain) as source:
        upright_marker = marker_x(source[0])

    combined, _, _ = assemble_pages(
        [ref(handle.document_id, rotation=180, flip=True)], documents, "combo.pdf"
    )
    with fitz.open(combined) as doc:
        # 180 then mirror returns the marker to its upright horizontal position.
        assert abs(marker_x(doc[0]) - upright_marker) < 12
    registry.release_all()


# ── inserted images ───────────────────────────────────────────────────────────

def test_inserted_image_keeps_its_original_size(sources):
    documents, _, image = sources
    entries = [ref(image.document_id, 1)]

    path, _, _ = assemble_pages(entries, documents, "image.pdf")
    with fitz.open(path) as doc:
        # One pixel is one point, and nothing is fitted to a standard page.
        assert (doc[0].rect.width, doc[0].rect.height) == pytest.approx((240.0, 160.0))


def test_rotated_image_page_follows_the_transformed_size(sources):
    documents, _, image = sources
    path, _, _ = assemble_pages([ref(image.document_id, rotation=90)], documents, "image-rot.pdf")
    with fitz.open(path) as doc:
        assert (doc[0].rect.width, doc[0].rect.height) == pytest.approx((160.0, 240.0))


def test_large_image_page_is_not_scaled_down(tmp_path):
    registry = DocumentRegistry()
    handle = registry.register(make_image(tmp_path / "big.png", size=(1200, 900)), "big.png")
    documents = {handle.document_id: handle}

    path, _, _ = assemble_pages([ref(handle.document_id)], documents, "big.pdf")
    with fitz.open(path) as doc:
        assert (doc[0].rect.width, doc[0].rect.height) == pytest.approx((1200.0, 900.0))
    registry.release_all()


def test_pdf_and_image_pages_can_be_mixed(sources):
    documents, pdf, image = sources
    entries = [ref(pdf.document_id, 2), ref(image.document_id, 1), ref(pdf.document_id, 1)]

    path, total, _ = assemble_pages(entries, documents, "mixed-sources.pdf")
    with fitz.open(path) as doc:
        assert total == doc.page_count == 3
        assert centre_colour(doc[0]) == PAGE_COLOURS[1]
        assert (doc[1].rect.width, doc[1].rect.height) == pytest.approx((240.0, 160.0))
        assert centre_colour(doc[2]) == PAGE_COLOURS[0]


# ── validation ────────────────────────────────────────────────────────────────

def test_empty_list_is_rejected(sources):
    documents, _, _ = sources
    with pytest.raises(OrganizeAssemblyError, match="no pages"):
        assemble_pages([], documents)


def test_missing_source_is_rejected(sources):
    documents, _, _ = sources
    with pytest.raises(OrganizeAssemblyError, match="no longer available"):
        assemble_pages([ref("does-not-exist")], documents)


def test_out_of_range_page_is_rejected(sources):
    documents, pdf, _ = sources
    with pytest.raises(OrganizeAssemblyError, match="refers to page 9"):
        assemble_pages([ref(pdf.document_id, 9)], documents)


def test_image_page_other_than_one_is_rejected(sources):
    """An image source has a single page, so any other page number is out of range."""
    documents, _, image = sources
    with pytest.raises(OrganizeAssemblyError, match="refers to page 2"):
        assemble_pages([ref(image.document_id, 2)], documents)


@pytest.mark.parametrize("rotation", [45, 360, -90, 450])
def test_unsupported_rotation_is_rejected(sources, rotation):
    documents, pdf, _ = sources
    with pytest.raises(OrganizeAssemblyError, match="unsupported rotation"):
        assemble_pages([ref(pdf.document_id, 1, rotation=rotation)], documents)


def test_invalid_flip_flag_is_rejected(sources):
    documents, pdf, _ = sources
    entry = {"source": pdf.document_id, "page": 1, "rotation": 0, "flip": "yes"}
    with pytest.raises(OrganizeAssemblyError, match="invalid flip"):
        assemble_pages([entry], documents)


def test_failure_leaves_the_source_documents_untouched(sources):
    documents, pdf, _ = sources
    before = pdf.path.read_bytes()
    with pytest.raises(OrganizeAssemblyError):
        assemble_pages([ref(pdf.document_id, 99)], documents)
    assert pdf.path.read_bytes() == before, "a failed assembly must not modify its sources"


# ── HTTP surface ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_assemble_endpoint_returns_the_pdf(tmp_path):
    from main import app

    pdf_path = make_pdf(tmp_path / "source.pdf", 4)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        upload = await client.post(
            "/api/v1/organize/documents/",
            files={"file": ("source.pdf", pdf_path.read_bytes(), "application/pdf")},
        )
        document_id = upload.json()["data"]["document_id"]

        pages = [
            {"source": document_id, "page": 4, "rotation": 0, "flip": False},
            {"source": document_id, "page": 2, "rotation": 90, "flip": True},
        ]
        response = await client.post(
            "/api/v1/organize/assemble/",
            json={"pages": pages, "output_filename": "from-api.pdf"},
        )

    assert response.status_code == 200, response.text
    assert response.headers["x-total-pages"] == "2"
    assert response.headers["x-output-file"] == "from-api.pdf"
    with fitz.open(stream=response.content, filetype="pdf") as doc:
        assert doc.page_count == 2
        assert centre_colour(doc[0]) == PAGE_COLOURS[3]


@pytest.mark.asyncio
async def test_assemble_endpoint_reports_a_bad_page_list(tmp_path):
    from main import app

    pdf_path = make_pdf(tmp_path / "source.pdf", 2)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        upload = await client.post(
            "/api/v1/organize/documents/",
            files={"file": ("source.pdf", pdf_path.read_bytes(), "application/pdf")},
        )
        document_id = upload.json()["data"]["document_id"]

        bad_pages = [{"source": document_id, "page": 77, "rotation": 0, "flip": False}]
        response = await client.post(
            "/api/v1/organize/assemble/",
            json={"pages": bad_pages},
        )
        assert response.status_code == 422
        assert "refers to page 77" in response.json()["message"]

        # A malformed body is rejected by the request schema, which is the same
        # validation response shape the rest of the API uses.
        malformed = await client.post(
            "/api/v1/organize/assemble/",
            json={"pages": "not a list"},
        )
        assert malformed.status_code == 422

        unknown = await client.post(
            "/api/v1/organize/assemble/",
            json={"pages": [{"source": "gone", "page": 1}]},
        )
        assert unknown.status_code == 422
