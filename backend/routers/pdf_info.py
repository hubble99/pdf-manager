"""PDF info router — POST /api/v1/pdf-info/."""
import logging
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from core.pdf_info import PdfInfoOpenError, read_pdf_info
from models.common import ErrorResponse, SuccessResponse
from utils.file_utils import cleanup_temp_file, save_upload

logger = logging.getLogger("pdf_manager.pdf_info")
router = APIRouter(prefix="/pdf-info", tags=["pdf-info"])


@router.post("/", response_model=SuccessResponse)
async def get_pdf_info(file: UploadFile = File(...)):
    temp_path: Path | None = None
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF (.pdf extension required).")
        temp_path = await save_upload(file, subdir="info")
        try:
            info = read_pdf_info(temp_path, file.filename)
        except PdfInfoOpenError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return SuccessResponse(status="success", data=info)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("pdf_info error: %s", exc, exc_info=True)
        return JSONResponse(status_code=500, content=ErrorResponse(message="Failed to read PDF info.", detail=str(exc)).model_dump())
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)