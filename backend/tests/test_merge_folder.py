"""Merge folder mode: the root registry, inspection, skipping, and the endpoints."""
from __future__ import annotations

import time
from pathlib import Path

import fitz
import pytest
from httpx import ASGITransport, AsyncClient

from config import settings
from core.pdf_merge import MergeError, inspect_documents, merge_documents, merge_pdfs
from features.merge.folders import FolderError, RootRegistry

PAGE_COLOURS = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0)]


def make_pdf(path: Path, pages: int = 1, encrypted: bool = False) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with fitz.open() as doc:
        for index in range(pages):
            page = doc.new_page(width=200, height=300)
            colour = PAGE_COLOURS[index % len(PAGE_COLOURS)]
            page.draw_rect(page.rect, color=colour, fill=colour)
        if encrypted:
            doc.save(str(path), encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user")
        else:
            doc.save(str(path))
    return path


def damaged(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"this is not a pdf")
    return path


@pytest.fixture(autouse=True)
def isolated_dirs(tmp_path, monkeypatch):
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.setattr(settings, "OUTPUT_DIR", output)
    from features.merge.folders import registry

    registry.release_all()
    yield
    registry.release_all()


@pytest.fixture
def folder(tmp_path: Path) -> Path:
    root = tmp_path / "Reports"
    make_pdf(root / "a.pdf", 2)
    make_pdf(root / "b.pdf", 1)
    make_pdf(root / "Q1" / "c.pdf", 3)
    make_pdf(root / "Q1" / "locked.pdf", encrypted=True)
    damaged(root / "broken.pdf")
    (root / "notes.txt").write_text("x", encoding="utf-8")
    return root


# ── registry ────────────────────────────────────────────────────────────────

def test_register_and_resolve(folder: Path):
    registry = RootRegistry()
    handle = registry.register(str(folder))
    assert registry.get(handle.root_id).path == str(folder.resolve())
    assert registry.get(handle.root_id).name == "Reports"


def test_registering_something_that_is_not_a_folder_is_refused(tmp_path: Path):
    registry = RootRegistry()
    with pytest.raises(FolderError):
        registry.register(str(tmp_path / "missing"))
    with pytest.raises(FolderError):
        registry.register(str(make_pdf(tmp_path / "file.pdf")))


def test_expiry_slides_on_use(folder: Path, monkeypatch):
    import features.merge.folders as module

    monkeypatch.setattr(module, "ROOT_TTL_SECONDS", 1)
    registry = RootRegistry()
    handle = registry.register(str(folder))

    # Two idle periods of 0.6 s exceed the 1 s TTL in total, but each use
    # refreshes the deadline, so an active session never lapses.
    time.sleep(0.6)
    assert registry.get(handle.root_id)
    time.sleep(0.6)
    assert registry.get(handle.root_id)


def test_an_idle_root_is_refused(folder: Path, monkeypatch):
    import features.merge.folders as module

    monkeypatch.setattr(module, "ROOT_TTL_SECONDS", 60)
    registry = RootRegistry()
    handle = registry.register(str(folder))
    handle.last_used = time.time() - 600

    with pytest.raises(FolderError, match="Choose folder again"):
        registry.get(handle.root_id)


def test_release_and_bound(folder: Path, tmp_path: Path, monkeypatch):
    import features.merge.folders as module

    registry = RootRegistry()
    handle = registry.register(str(folder))
    assert registry.release(handle.root_id) is True
    assert registry.release(handle.root_id) is False

    monkeypatch.setattr(module, "MAX_ROOTS", 2)
    first = registry.register(str(folder))
    registry.register(str(folder))
    registry.register(str(folder))
    assert registry.count() == 2
    with pytest.raises(FolderError):
        registry.get(first.root_id)


# ── inspection and skipping ─────────────────────────────────────────────────

def test_inspection_classifies_problems(folder: Path):
    paths = [folder / "a.pdf", folder / "Q1" / "locked.pdf", folder / "broken.pdf",
             folder / "gone.pdf", folder / "notes.txt"]
    usable, problems = inspect_documents(paths)
    assert [p.name for p in usable] == ["a.pdf"]
    reasons = {Path(p.path).name: p.reason for p in problems}
    assert reasons["locked.pdf"] == "encrypted"
    assert reasons["broken.pdf"] == "damaged or unreadable"
    assert reasons["gone.pdf"] == "file not found"
    assert reasons["notes.txt"] == "not a PDF file"


def test_strict_merge_still_fails_on_one_bad_file(folder: Path):
    with pytest.raises(MergeError, match="encrypted"):
        merge_pdfs([folder / "a.pdf", folder / "Q1" / "locked.pdf"], "strict.pdf")


def test_skip_merge_reports_what_it_skipped(folder: Path):
    outcome = merge_documents(
        [folder / "a.pdf", folder / "Q1" / "locked.pdf", folder / "b.pdf", folder / "broken.pdf"],
        "folder-merge.pdf",
        skip_invalid=True,
    )
    assert outcome.merged == 2
    assert outcome.total_pages == 3
    assert {Path(p.path).name for p in outcome.skipped} == {"locked.pdf", "broken.pdf"}
    with fitz.open(outcome.output_path) as doc:
        assert doc.page_count == 3


def test_skip_merge_refuses_when_too_few_survive(folder: Path):
    with pytest.raises(MergeError, match="Fewer than 2"):
        merge_documents(
            [folder / "a.pdf", folder / "Q1" / "locked.pdf"],
            "too-few.pdf",
            skip_invalid=True,
        )


def test_merge_order_follows_the_list(folder: Path):
    outcome = merge_documents([folder / "b.pdf", folder / "a.pdf"], "order.pdf", skip_invalid=True)
    assert outcome.total_pages == 3
    with fitz.open(outcome.output_path) as doc:
        # a.pdf has red then green; b.pdf is red. b first, so page 1 is red.
        assert doc[0].get_pixmap(dpi=20).pixel(5, 5)[:3] == (255, 0, 0)


# ── endpoints ───────────────────────────────────────────────────────────────

def client():
    from main import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_register_list_inspect_and_merge(folder: Path):
    async with client() as api:
        registered = await api.post("/api/v1/merge/folder/roots/", json={"path": str(folder)})
        assert registered.status_code == 200, registered.text
        root_id = registered.json()["data"]["root_id"]
        assert registered.json()["data"]["name"] == "Reports"

        listed = await api.post(f"/api/v1/merge/folder/roots/{root_id}/list/")
        data = listed.json()["data"]
        # Five PDF-named files exist, including the damaged one: listing reads
        # names only, so a file it cannot open is still counted.
        assert data["pdf_count"] == 5
        assert [child["name"] for child in data["root"]["folders"]] == ["Q1"]
        assert data["root"]["files"] == ["a.pdf", "b.pdf", "broken.pdf"]

        inspected = await api.post("/api/v1/merge/folder/inspect/", json={
            "root_id": root_id,
            "files": ["a.pdf", "Q1/locked.pdf", "broken.pdf"],
        })
        problems = inspected.json()["data"]["problems"]
        assert len(problems) == 2

        merged = await api.post("/api/v1/merge/folder/merge/", json={
            "root_id": root_id,
            "files": ["a.pdf", "Q1/locked.pdf", "b.pdf"],
            "output_filename": "from-folder.pdf",
            "skip_invalid": True,
        })
        assert merged.status_code == 200, merged.text
        assert merged.headers["x-total-pages"] == "3"
        assert merged.headers["x-merged-files"] == "2"
        assert merged.headers["x-skipped-files"] == "1"

        released = await api.delete(f"/api/v1/merge/folder/roots/{root_id}")
        assert released.status_code == 200


@pytest.mark.asyncio
async def test_endpoints_refuse_bad_inputs(folder: Path, tmp_path: Path):
    async with client() as api:
        bad = await api.post("/api/v1/merge/folder/roots/", json={"path": str(tmp_path / "nope")})
        assert bad.status_code == 422

        root_id = (await api.post("/api/v1/merge/folder/roots/", json={"path": str(folder)})).json()["data"]["root_id"]

        unknown = await api.post("/api/v1/merge/folder/roots/does-not-exist/list/")
        assert unknown.status_code == 404
        assert "Choose folder again" in unknown.json()["message"]

        escape = await api.post("/api/v1/merge/folder/merge/", json={
            "root_id": root_id, "files": ["../outside.pdf", "a.pdf"],
        })
        assert escape.status_code == 422

        absolute = await api.post("/api/v1/merge/folder/merge/", json={
            "root_id": root_id, "files": ["C:\\Windows\\win.ini.pdf", "a.pdf"],
        })
        assert absolute.status_code == 422

        too_few = await api.post("/api/v1/merge/folder/merge/", json={
            "root_id": root_id, "files": ["a.pdf"],
        })
        assert too_few.status_code == 400

        strict = await api.post("/api/v1/merge/folder/merge/", json={
            "root_id": root_id, "files": ["a.pdf", "broken.pdf"], "skip_invalid": False,
        })
        assert strict.status_code == 422
