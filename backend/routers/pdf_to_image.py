"""PDF to Image router — POST /api/v1/pdf-to-image/"""
import logging
import base64
from typing import Optional
from pathlib import Path
import fitz

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


@router.post("/pages")
async def pdf_to_image_pages_endpoint(
    file: UploadFile = File(...),
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
        
        # Render each page to PNG at DPI 200
        dpi = 200
        for i in range(total_pages):
            page = doc[i]
            # Render to pixmap with white background
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            
            # Get PNG bytes
            img_bytes = pix.tobytes("png")
            
            # Encode to base64 string
            base64_data = base64.b64encode(img_bytes).decode("utf-8")
            
            pages_data.append({
                "index": i,
                "width": pix.width,
                "height": pix.height,
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
