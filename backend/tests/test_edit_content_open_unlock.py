from __future__ import annotations

import fitz
import pytest
from httpx import ASGITransport, AsyncClient

from features.edit_content.open_unlock import unlock_permission_only
from main import app
from routers import edit_content


def _pdf(path, *, user_password="", owner_password=None):
    # Built with PyMuPDF so the tests need nothing beyond the app's own dependencies.
    with fitz.open() as doc:
        doc.new_page(width=100, height=100)
        if owner_password is None:
            doc.save(str(path))
        else:
            doc.save(
                str(path),
                encryption=fitz.PDF_ENCRYPT_AES_128,
                owner_pw=owner_password,
                user_pw=user_password,
            )
    return path


def _is_encrypted(path):
    # An owner-only PDF opens with the empty password, so is_encrypted alone is False.
    with fitz.open(str(path)) as doc:
        return bool(doc.is_encrypted or doc.metadata.get("encryption"))


def test_owner_only_pdf_becomes_an_unprotected_copy(tmp_path):
    source = _pdf(tmp_path / "restricted.pdf", owner_password="owner")
    assert _is_encrypted(source)
    assert unlock_permission_only(source) is True
    with fitz.open(str(source)) as unlocked:
        assert not _is_encrypted(source) and unlocked.page_count == 1
    assert list(tmp_path.iterdir()) == [source]


def test_unprotected_pdf_is_left_alone(tmp_path):
    source = _pdf(tmp_path / "plain.pdf")
    before = source.read_bytes()
    assert unlock_permission_only(source) is False
    assert source.read_bytes() == before


def test_pdf_that_needs_a_password_stays_protected(tmp_path):
    source = _pdf(tmp_path / "secret.pdf", user_password="secret", owner_password="owner")
    before = source.read_bytes()
    assert unlock_permission_only(source) is False
    assert source.read_bytes() == before


def test_unreadable_file_is_left_for_the_normal_rejection(tmp_path):
    source = tmp_path / "broken.pdf"
    source.write_bytes(b"%PDF-1.7\nnot really a pdf")
    assert unlock_permission_only(source) is False


@pytest.mark.asyncio
async def test_open_hands_the_engine_an_unprotected_copy_and_says_so(monkeypatch, tmp_path):
    seen = {}

    class FakeRegistry:
        def open(self, source):
            seen["encrypted"] = _is_encrypted(source)
            raise RuntimeError("stop after the check")

    monkeypatch.setattr(edit_content, "get_content_registry", lambda: FakeRegistry())
    restricted = _pdf(tmp_path / "restricted.pdf", owner_password="owner")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post(
            "/api/v1/edit-content/sessions",
            data={"schemaVersion": "edit-content-request/v1", "requestId": "open1", "command": "open"},
            files={"file": ("restricted.pdf", restricted.read_bytes(), "application/pdf")},
        )
    assert seen == {"encrypted": False}
