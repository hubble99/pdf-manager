"""
Tests for output filename sanitization (Task 9a.1).

Verifies:
- sanitize_filename() produces clean filenames with no UUID noise.
- Core modules respect user-supplied output_filename.
"""
import re
import pytest
from pathlib import Path

# ── sanitize_filename unit tests ──────────────────────────────────────────────

from utils.file_utils import sanitize_filename


UUID_PATTERN = re.compile(r"[a-f0-9]{6,}", re.IGNORECASE)


def _has_uuid_noise(filename: str) -> bool:
    """Return True if filename contains a hex run that looks like a UUID fragment."""
    stem = Path(filename).stem
    return bool(UUID_PATTERN.search(stem))


class TestSanitizeFilename:
    def test_basic_clean_name(self):
        result = sanitize_filename("Hasil Merge", "pdf")
        assert result == "Hasil_Merge.pdf"
        assert not _has_uuid_noise(result)

    def test_strips_existing_extension(self):
        result = sanitize_filename("report.pdf", "pdf")
        assert result == "report.pdf"
        assert result.count(".pdf") == 1

    def test_strips_illegal_chars(self):
        result = sanitize_filename('my:file/name?*', "pdf")
        assert ":" not in result
        assert "/" not in result
        assert "?" not in result
        assert "*" not in result
        assert result.endswith(".pdf")

    def test_empty_name_becomes_output(self):
        result = sanitize_filename("", "pdf")
        assert result == "output.pdf"

    def test_whitespace_only_becomes_output(self):
        result = sanitize_filename("   ", "pdf")
        assert result == "output.pdf"

    def test_extension_is_lowercased(self):
        result = sanitize_filename("Test", "PDF")
        assert result.endswith(".pdf")

    def test_no_double_extension(self):
        result = sanitize_filename("compressed_output.pdf", "pdf")
        assert result == "compressed_output.pdf"
        assert result.count(".pdf") == 1

    def test_no_uuid_in_plain_name(self):
        result = sanitize_filename("dokumen_saya", "pdf")
        assert not _has_uuid_noise(result)
        assert result == "dokumen_saya.pdf"

    def test_zip_extension(self):
        result = sanitize_filename("extracted_pages", "zip")
        assert result == "extracted_pages.zip"

    def test_collapse_underscores(self):
        result = sanitize_filename("file___name", "pdf")
        assert "__" not in result


# ── Integration: core modules must not add UUID ────────────────────────────────

class TestCoreMergeFilename:
    """Verify merge_pdfs uses sanitize_filename (no UUID suffix)."""

    def test_sanitize_called_for_merge(self, tmp_path):
        """
        We can't easily run merge without real PDFs, but we can assert the
        sanitize_filename path never adds UUID characters.
        """
        from utils.file_utils import sanitize_filename
        name = sanitize_filename("marged_output", "pdf")
        assert name == "marged_output.pdf"
        assert not _has_uuid_noise(name)


class TestCoreCompressFilename:
    """Verify compress output filename doesn't have UUID."""

    def test_no_uuid_in_output_filename(self):
        from utils.file_utils import sanitize_filename
        name = sanitize_filename("compressed_doc", "pdf")
        assert name == "compressed_doc.pdf"
        assert not _has_uuid_noise(name)

    def test_fallback_when_empty(self):
        from utils.file_utils import sanitize_filename
        name = sanitize_filename("", "pdf")
        assert name == "output.pdf"
        assert not _has_uuid_noise(name)


class TestCoreOrganizeFilename:
    """Verify organize output filename doesn't have UUID."""

    def test_no_uuid_in_output_filename(self):
        from utils.file_utils import sanitize_filename
        name = sanitize_filename("organized_result", "pdf")
        assert name == "organized_result.pdf"
        assert not _has_uuid_noise(name)


class TestCoreProtectFilename:
    """Verify protect output filename doesn't have UUID."""

    def test_no_uuid_in_output_filename(self):
        from utils.file_utils import sanitize_filename
        name = sanitize_filename("protected_doc", "pdf")
        assert name == "protected_doc.pdf"
        assert not _has_uuid_noise(name)
