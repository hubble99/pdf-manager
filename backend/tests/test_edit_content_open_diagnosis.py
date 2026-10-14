from __future__ import annotations

from pypdf import PdfWriter

from features.edit_content.open_diagnosis import (
    ENCRYPTED, OPEN_FAILURE_MESSAGES, UNREADABLE, UNSUPPORTED, diagnose_rejected_source,
)


def _write(path, *, encrypt=False):
    writer = PdfWriter()
    writer.add_blank_page(100, 100)
    if encrypt:
        writer.encrypt("", owner_password="owner", algorithm="RC4-128")
    with path.open("wb") as handle:
        writer.write(handle)
    return path


def test_permission_protected_pdf_is_reported_as_encrypted(tmp_path):
    assert diagnose_rejected_source(_write(tmp_path / "locked.pdf", encrypt=True)) == ENCRYPTED


def test_damaged_or_missing_input_is_reported_as_unreadable(tmp_path):
    damaged = tmp_path / "damaged.pdf"
    damaged.write_bytes(b"%PDF-1.7\nnot really a pdf")
    assert diagnose_rejected_source(damaged) == UNREADABLE
    assert diagnose_rejected_source(tmp_path / "missing.pdf") == UNREADABLE


def test_well_formed_pdf_the_engine_rejected_keeps_the_structural_reason(tmp_path):
    assert diagnose_rejected_source(_write(tmp_path / "plain.pdf")) == UNSUPPORTED


def test_every_diagnosis_has_a_user_message_without_paths():
    for code in (ENCRYPTED, UNREADABLE, UNSUPPORTED, "ENGINE_START_FAILED", "OPEN_TIMEOUT", "INSPECT_TIMEOUT"):
        assert OPEN_FAILURE_MESSAGES[code] and "/" not in OPEN_FAILURE_MESSAGES[code].replace("Protect PDF > Remove Password", "")
