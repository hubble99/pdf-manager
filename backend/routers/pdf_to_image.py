"""Page images for the Edit Canvas editor: /api/v1/pdf-to-image/pages and /page"""
import logging
import base64
from typing import Optional
from pathlib import Path
import fitz

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse

from core.render_color import safe_dpi
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload

logger = logging.getLogger("pdf_manager.router.pdf_to_image")
router = APIRouter(prefix="/pdf-to-image", tags=["pdf-to-image"])


@router.post("/pages")
async def pdf_to_image_pages_endpoint(
    file: UploadFile = File(...),
    dpi: int = Form(default=200),
):
    """
    Convert all pages of a PDF to base64 PNG images for the editor canvas.
    
    - **file**: PDF file
    
    Returns a JSON array of base64 encoded PNG images with page dimensions.
    """
    temp_path: Optional[Path] = None
    doc: Optional[fitz.Document] = None
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Uploaded file must be a PDF.")

        temp_path = await save_upload(file, subdir="pdf_to_image_pages")
        
        try:
            doc = fitz.open(str(temp_path))
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Cannot open PDF: {e}")

        if doc.is_encrypted:
            raise HTTPException(status_code=422, detail="PDF is encrypted and cannot be processed.")

        pages_data = []
        total_pages = doc.page_count
        
        dpi = max(72, min(500, dpi))
        for i in range(total_pages):
            page = doc[i]
            # Render to pixmap with white background
            page_dpi = safe_dpi(page, dpi)
            pix = page.get_pixmap(dpi=page_dpi, alpha=False)
            
            # Get PNG bytes
            img_bytes = pix.tobytes("png")
            
            # Encode to base64 string
            base64_data = base64.b64encode(img_bytes).decode("utf-8")
            
            pages_data.append({
                "index": i,
                "width": pix.width,
                "height": pix.height,
                "dpi": page_dpi,
                "data": base64_data,
            })
            
        return {
            "pages": pages_data,
            "total": total_pages
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"pdf_to_image_pages error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="PDF page conversion failed.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        if doc:
            doc.close()
        if temp_path:
            cleanup_temp_file(temp_path)


@router.post("/page")
async def pdf_to_image_page_endpoint(
    file: UploadFile = File(...),
    page_index: int = Form(...),
    dpi: int = Form(default=200),
):
    """Render one editor page at a requested DPI for zoom-aware previews."""
    temp_path: Optional[Path] = None
    doc: Optional[fitz.Document] = None
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Uploaded file must be a PDF.")
        temp_path = await save_upload(file, subdir="pdf_to_image_page")
        doc = fitz.open(str(temp_path))
        if not 0 <= page_index < doc.page_count:
            raise HTTPException(status_code=400, detail="Page index is out of range.")
        dpi = safe_dpi(doc[page_index], max(72, min(500, dpi)))
        pix = doc[page_index].get_pixmap(dpi=dpi, alpha=False)
        return {
            "index": page_index,
            "width": pix.width,
            "height": pix.height,
            "dpi": dpi,
            "data": base64.b64encode(pix.tobytes("png")).decode("utf-8"),
        }
    finally:
        if doc:
            doc.close()
        if temp_path:
            cleanup_temp_file(temp_path)
