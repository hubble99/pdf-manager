import pytest
from pathlib import Path
from io import BytesIO
from fastapi import UploadFile
from config import settings
from utils.file_utils import get_file_info, cleanup_temp_file, save_upload

def test_get_file_info(tmp_path):
    # Test get_file_info() with dummy file
    dummy_file = tmp_path / "dummy.pdf"
    dummy_file.write_bytes(b"Hello PDF Content")
    
    info = get_file_info(dummy_file)
    assert info["filename"] == "dummy.pdf"
    assert info["size_bytes"] == len(b"Hello PDF Content")
    assert info["path"] == str(dummy_file)

@pytest.mark.asyncio
async def test_save_upload(tmp_path, monkeypatch):
    # Mock settings.TEMP_DIR to point to our test tmp_path
    monkeypatch.setattr(settings, "TEMP_DIR", tmp_path)
    
    # Create a dummy UploadFile
    content = b"Mock PDF Data"
    upload = UploadFile(file=BytesIO(content), filename="upload_test.pdf")
    
    saved_path = await save_upload(upload)
    
    assert saved_path.exists()
    assert saved_path.parent == tmp_path / "uploads"
    assert saved_path.name.endswith("upload_test.pdf")
    assert saved_path.read_bytes() == content

def test_cleanup_temp_file_existing(tmp_path):
    dummy_file = tmp_path / "cleanup_test.pdf"
    dummy_file.write_bytes(b"data")
    assert dummy_file.exists()
    
    cleanup_temp_file(dummy_file)
    assert not dummy_file.exists()

def test_cleanup_temp_file_nonexistent():
    # Should not raise any error
    non_existent = Path("non_existent_file_xyz.pdf")
    cleanup_temp_file(non_existent)
