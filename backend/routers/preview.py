"""Preview router — POST /api/v1/preview/."""
import logging
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

from core.pdf_preview import PreviewEncryptedError, PreviewOpenError, PreviewPageError, render_pdf_preview
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload

logger = logging.getLogger("pdf_manager.preview")
router = APIRouter(prefix="/preview", tags=["preview"])


@router.post("/")
async def get_pdf_preview(file: UploadFile = File(...), page: int = Form(default=1), dpi: int = Form(default=72), quality_hint: str = Form(default="auto")):
    temp_path: Path | None = None
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF.")
        temp_path = await save_upload(file, subdir="preview")
        try:
            image_bytes = render_pdf_preview(temp_path, page_number=page, dpi=dpi, quality_hint=quality_hint)
        except PreviewOpenError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except PreviewEncryptedError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except PreviewPageError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return Response(content=image_bytes, media_type="image/png")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("pdf_preview error: %s", exc, exc_info=True)
        return JSONResponse(status_code=500, content=ErrorResponse(message="Failed to generate PDF preview.", detail=str(exc)).model_dump())
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)