"""PDF to Image router — POST /api/v1/pdf-to-image/"""
import logging
from typing import Optional
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from core.pdf_to_image import pdf_to_image, PdfToImageError
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload, sanitize_filename, sanitize_stem

logger = logging.getLogger("pdf_manager.router.pdf_to_image")
router = APIRouter(prefix="/pdf-to-image", tags=["pdf-to-image"])


@router.post("/")
async def pdf_to_image_endpoint(
    file: UploadFile = File(...),
    page_ranges: str = Form(default=""),
    format: str = Form(default="png"),
    dpi: int = Form(default=150),
    output_filename: str = Form(default=""),
):
    """
    Convert PDF pages to images.
    
    - **file**: PDF file
    - **page_ranges**: e.g., "1-3,5" (empty for all pages)
    - **format**: "png", "jpeg", or "webp"
    - **dpi**: Resolution (72, 96, 150, 300)
    
    Returns a single image file if 1 page, or a ZIP archive if multiple pages.
    """
    temp_path: Optional[Path] = None

    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Uploaded file must be a PDF.")

        temp_path = await save_upload(file, subdir="pdf_to_image")
        
        # Derive clean base name from original filename or provided output_filename
        if output_filename:
            clean_name = sanitize_stem(output_filename)
        else:
            clean_name = sanitize_stem(file.filename or "document")

        try:
            out_path, pages_exported, is_zip = pdf_to_image(
                input_path=temp_path,
                page_str=page_ranges,
                format=format,
                dpi=dpi,
                clean_name=clean_name,
            )
        except PdfToImageError as e:
            raise HTTPException(status_code=422, detail=str(e))

        mime_type = "application/zip" if is_zip else f"image/{format.lower()}"
        
        # Calculate final download filename — pass extension WITHOUT dot as second arg
        if is_zip:
            final_filename = sanitize_filename(f"{clean_name}_images", "zip")
        else:
            final_filename = sanitize_filename(clean_name, format.lower())

        return FileResponse(
            path=str(out_path),
            media_type=mime_type,
            filename=final_filename,
            headers={
                "X-Pages-Exported": str(pages_exported),
                "X-Format": format.upper(),
                "X-DPI": str(dpi),
                "X-Output-File": final_filename,
                "Content-Disposition": f'attachment; filename="{final_filename}"',
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"pdf_to_image error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="PDF to Image conversion failed due to an unexpected error.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)
