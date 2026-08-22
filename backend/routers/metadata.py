"""Metadata router — POST /api/v1/metadata/"""
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from config import settings
from core.pdf_metadata import MetadataEncryptedError, MetadataOpenError, update_pdf_metadata
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload
from utils.filename_utils import sanitize_filename

logger = logging.getLogger("pdf_manager.router.metadata")
router = APIRouter(prefix="/metadata", tags=["metadata"])


@router.post("/")
async def update_pdf_metadata_endpoint(
    file: UploadFile = File(...),
    title: str = Form(default=""),
    author: str = Form(default=""),
    subject: str = Form(default=""),
    keywords: str = Form(default=""),
):
    temp_path: Path | None = None
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF.")
        temp_path = await save_upload(file, subdir="metadata")
        title_str = title.strip()
        source_stem = Path(file.filename or "output.pdf").stem
        safe_name = sanitize_filename(title_str or f"{source_stem}_metadata", "pdf")
        out_name = f"{uuid.uuid4().hex[:8]}_{safe_name}"
        out_path = settings.OUTPUT_DIR / out_name
        try:
            update_pdf_metadata(temp_path, out_path, title=title, author=author, subject=subject, keywords=keywords)
        except MetadataOpenError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except MetadataEncryptedError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        return FileResponse(
            path=str(out_path), media_type="application/pdf", filename=safe_name,
            headers={"X-Output-File": safe_name},
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("metadata error: %s", exc, exc_info=True)
        return JSONResponse(status_code=500, content=ErrorResponse(message="Metadata update failed.", detail=str(exc)).model_dump())
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)
