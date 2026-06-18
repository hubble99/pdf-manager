"""
Preview router — POST /api/v1/preview/
Generates image previews for PDF pages with adaptive resolution to prevent OOM errors.
"""
import logging
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload

logger = logging.getLogger("pdf_manager.preview")
router = APIRouter(prefix="/preview", tags=["preview"])

@router.post("/")
async def get_pdf_preview(
    file: UploadFile = File(...),
    page: int = Form(default=1),
    dpi: int = Form(default=72),
    quality_hint: str = Form(default="auto")
):
    """
    Extract a single page from a PDF as a PNG image for preview.
    - page: 1-indexed page number
    - dpi: Resolution (default 72)
    - quality_hint: Quality mode. 'auto' caps maximum dimension to prevent OOM.
    """
    temp_path: Path | None = None
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF.")

        temp_path = await save_upload(file, subdir="preview")

        import fitz  # PyMuPDF

        try:
            doc = fitz.open(str(temp_path))
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Cannot open PDF: {e}")

        if doc.is_encrypted:
            doc.close()
            raise HTTPException(status_code=403, detail="PDF is encrypted.")

        if page < 1 or page > doc.page_count:
            doc.close()
            raise HTTPException(status_code=400, detail=f"Page number out of bounds. Document has {doc.page_count} pages.")

        page_obj = doc[page - 1]
        
        # Adaptive resolution logic
        rect = page_obj.rect
        w_pt, h_pt = rect.width, rect.height
        
        target_w_px = w_pt * (dpi / 72)
        target_h_px = h_pt * (dpi / 72)
        
        MAX_DIM = 2048
        if quality_hint == "low":
            MAX_DIM = 1024
        elif quality_hint == "high":
            MAX_DIM = 4096
            
        scale = 1.0
        if target_w_px > MAX_DIM or target_h_px > MAX_DIM:
            scale = min(MAX_DIM / target_w_px, MAX_DIM / target_h_px)
            
        actual_dpi = int(dpi * scale)
        actual_dpi = max(36, actual_dpi) # Ensure minimum DPI
        
        pix = page_obj.get_pixmap(dpi=actual_dpi)
        img_bytes = pix.tobytes("png")
        doc.close()

        return Response(content=img_bytes, media_type="image/png")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"pdf_preview error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(status="error", message="Failed to generate PDF preview.", detail=str(e)).model_dump(),
        )
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)
