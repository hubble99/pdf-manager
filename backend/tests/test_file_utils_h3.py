"""
Test suite untuk H-3: Path Traversal pada Upload

User meminta pengujian lima edge case:
1. Filename kosong / None
2. Path traversal dengan forward slash (../)
3. Path traversal dengan backslash (..\\)
4. Path absolut Windows (C:\\evil.pdf)
5. Unicode (dokumen_日本語.pdf)
"""
import pytest
from pathlib import Path
from fastapi import UploadFile
from io import BytesIO

from utils.file_utils import save_upload
from config import settings


@pytest.fixture(autouse=True)
def restore_temp_dir():
    """Keep tests isolated from the process-wide settings singleton."""
    original_temp_dir = settings.TEMP_DIR
    yield
    settings.TEMP_DIR = original_temp_dir


@pytest.fixture
def mock_upload_file():
    """Factory untuk membuat UploadFile mock dengan filename custom."""
    def _create(filename: str, content: bytes = b"test content"):
        return UploadFile(
            filename=filename,
            file=BytesIO(content)
        )
    return _create


@pytest.mark.asyncio
async def test_save_upload_empty_filename(mock_upload_file, tmp_path):
    """Edge case 1: filename kosong harus fallback ke 'upload'."""
    settings.TEMP_DIR = tmp_path

    upload = mock_upload_file("")
    result_path = await save_upload(upload, subdir="test")

    assert result_path.exists()
    assert result_path.parent == tmp_path / "test"
    # Format: <uuid>_upload
    assert result_path.name.endswith("_upload")
    assert len(result_path.name) == 32 + 1 + 6  # 32 hex + underscore + "upload"


@pytest.mark.asyncio
async def test_save_upload_none_filename(mock_upload_file, tmp_path):
    """Edge case 1b: filename None harus fallback ke 'upload'."""
    settings.TEMP_DIR = tmp_path

    # Simulasi UploadFile dengan filename=None
    upload = UploadFile(filename=None, file=BytesIO(b"test"))
    result_path = await save_upload(upload, subdir="test")

    assert result_path.exists()
    assert result_path.name.endswith("_upload")


@pytest.mark.asyncio
async def test_save_upload_path_traversal_forward_slash(mock_upload_file, tmp_path):
    """Edge case 2: ../ harus dihilangkan, hanya basename yang diambil."""
    settings.TEMP_DIR = tmp_path

    upload = mock_upload_file("../../evil.pdf")
    result_path = await save_upload(upload, subdir="test")

    assert result_path.exists()
    assert result_path.parent == tmp_path / "test"
    # Harus jadi <uuid>_evil.pdf, BUKAN <uuid>_../../evil.pdf
    assert result_path.name.endswith("_evil.pdf")
    assert ".." not in result_path.name
    assert "/" not in result_path.name


@pytest.mark.asyncio
async def test_save_upload_path_traversal_backslash_windows(mock_upload_file, tmp_path):
    """Edge case 3: ..\\ (Windows) harus dihilangkan."""
    settings.TEMP_DIR = tmp_path

    upload = mock_upload_file("..\\..\\evil.pdf")
    result_path = await save_upload(upload, subdir="test")

    assert result_path.exists()
    assert result_path.parent == tmp_path / "test"
    assert result_path.name.endswith("_evil.pdf")
    assert ".." not in result_path.name
    assert "\\" not in result_path.name


@pytest.mark.asyncio
async def test_save_upload_absolute_path_windows(mock_upload_file, tmp_path):
    """Edge case 4: Path absolut Windows (C:\\evil.pdf) hanya basename yang diambil."""
    settings.TEMP_DIR = tmp_path

    upload = mock_upload_file("C:\\Windows\\evil.pdf")
    result_path = await save_upload(upload, subdir="test")

    assert result_path.exists()
    assert result_path.parent == tmp_path / "test"
    assert result_path.name.endswith("_evil.pdf")
    assert "Windows" not in result_path.name
    assert "\\" not in result_path.name


@pytest.mark.asyncio
async def test_save_upload_unicode_filename(mock_upload_file, tmp_path):
    """Edge case 5: Unicode harus dipertahankan apa adanya."""
    settings.TEMP_DIR = tmp_path

    upload = mock_upload_file("dokumen_日本語.pdf")
    result_path = await save_upload(upload, subdir="test")

    assert result_path.exists()
    assert result_path.parent == tmp_path / "test"
    # Unicode harus utuh
    assert "日本語" in result_path.name
    assert result_path.name.endswith(".pdf")


@pytest.mark.asyncio
async def test_save_upload_uuid_uniqueness(mock_upload_file, tmp_path):
    """Verifikasi UUID prefix mencegah collision."""
    settings.TEMP_DIR = tmp_path

    upload1 = mock_upload_file("test.pdf", b"content 1")
    upload2 = mock_upload_file("test.pdf", b"content 2")

    result1 = await save_upload(upload1, subdir="test")
    result2 = await save_upload(upload2, subdir="test")

    # Kedua file harus exist dan berbeda
    assert result1.exists()
    assert result2.exists()
    assert result1 != result2
    assert result1.name != result2.name


@pytest.mark.asyncio
async def test_save_upload_content_integrity(mock_upload_file, tmp_path):
    """Verifikasi konten file tidak rusak setelah traversal dihilangkan."""
    settings.TEMP_DIR = tmp_path
    test_content = b"important data 12345"

    upload = mock_upload_file("../../evil.pdf", test_content)
    result_path = await save_upload(upload, subdir="test")

    assert result_path.read_bytes() == test_content
