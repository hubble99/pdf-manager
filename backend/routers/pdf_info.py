"""
PDF Info router — GET /api/v1/pdf-info/
Returns metadata about an uploaded PDF: total pages, file size, filename.
"""
import logging
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from models.common import ErrorResponse, SuccessResponse
from utils.file_utils import cleanup_temp_file, save_upload

logger = logging.getLogger("pdf_manager.pdf_info")
router = APIRouter(prefix="/pdf-info", tags=["pdf-info"])


@router.post("/", response_model=SuccessResponse)
async def get_pdf_info(file: UploadFile = File(...)):
    """Return metadata (page count, size, filename) for an uploaded PDF."""
    temp_path: Path | None = None
    try:
        # Validate content type
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF (.pdf extension required).")

        temp_path = await save_upload(file, subdir="info")

        import fitz  # PyMuPDF

        try:
            doc = fitz.open(str(temp_path))
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Cannot open PDF: {e}")

        total_pages = doc.page_count
        metadata = doc.metadata
        doc.close()

        size_bytes = temp_path.stat().st_size

        return SuccessResponse(
            status="success",
            data={
                "filename": file.filename,
                "total_pages": total_pages,
                "file_size_bytes": size_bytes,
                "metadata": metadata,
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"pdf_info error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(status="error", message="Failed to read PDF info.", detail=str(e)).model_dump(),
        )
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)

