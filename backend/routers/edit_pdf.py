"""
Edit PDF router — POST /api/v1/edit-pdf/save
Accepts JSON payload with base64 PNG pages and output filename, saves them to a new PDF.
"""
import base64
import logging
from pathlib import Path
from typing import List

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

import fitz
from config import settings
from models.common import ErrorResponse
from utils.file_utils import sanitize_filename

logger = logging.getLogger("pdf_manager.router.edit_pdf")
router = APIRouter(prefix="/edit-pdf", tags=["edit-pdf"])


class EditSaveRequest(BaseModel):
    pages: List[str]  # Base64 encoded PNG strings
    output_filename: str


@router.post("/save")
async def save_edited_pdf_endpoint(request: EditSaveRequest):
    """
    Save edited PDF pages (base64 PNGs) into a single PDF file.
    
    - **pages**: List of base64 PNG strings representing the edited pages
    - **output_filename**: Desired output PDF filename
    
    Returns the generated PDF.
    """
    if not request.pages:
        raise HTTPException(status_code=400, detail="At least one page is required to save.")

    doc = fitz.open()
    try:
        for idx, page_b64 in enumerate(request.pages):
            # Clean base64 string if it contains prefix like "data:image/png;base64,"
            if "," in page_b64:
                page_b64 = page_b64.split(",", 1)[1]
            
            try:
                img_bytes = base64.b64decode(page_b64)
            except Exception as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"Invalid base64 encoding on page index {idx}: {e}"
                )

            # Open image as document and convert to PDF bytes
            try:
                img_doc = fitz.open("png", img_bytes)
                pdf_bytes = img_doc.convert_to_pdf()
                img_doc.close()
            except Exception as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"Could not convert page index {idx} to image: {e}"
                )

            # Insert the generated PDF page into our main document
            try:
                page_doc = fitz.open("pdf", pdf_bytes)
                doc.insert_pdf(page_doc)
                page_doc.close()
            except Exception as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"Could not insert page index {idx}: {e}"
                )

        # Ensure output directory exists
        settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        
        safe_name = sanitize_filename(request.output_filename, "pdf")
        out_path = settings.OUTPUT_DIR / safe_name
        
        # Save document
        doc.save(str(out_path), garbage=4, deflate=True)
        total_pages = doc.page_count
        size_bytes = out_path.stat().st_size
        
        return FileResponse(
            path=str(out_path),
            media_type="application/pdf",
            filename=safe_name,
            headers={
                "X-Total-Pages": str(total_pages),
                "X-File-Size": str(size_bytes),
                "X-Output-File": safe_name,
                "Content-Disposition": f'attachment; filename="{safe_name}"',
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"save_edited_pdf error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Saving edited PDF failed due to an unexpected error.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        doc.close()
