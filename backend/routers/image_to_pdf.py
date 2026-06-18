"""Image to PDF router — POST /api/v1/image-to-pdf/"""
import json
import logging
from typing import List
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from core.image_to_pdf import images_to_pdf, ImageToPdfError
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload

logger = logging.getLogger("pdf_manager.router.image_to_pdf")
router = APIRouter(prefix="/image-to-pdf", tags=["image-to-pdf"])


@router.post("/")
async def image_to_pdf_endpoint(
    files: List[UploadFile] = File(...),
    page_size: str = Form(default="a4"),
    output_filename: str = Form(default="output.pdf"),
    rotations: str = Form(default="[]"),
    flips: str = Form(default="[]"),
):
    """
    Convert images to a PDF file.
    
    - **files**: List of images (JPG, PNG, WEBP, BMP, TIFF)
    - **page_size**: 'a4', 'a3', 'letter', 'legal', or 'match_image'
    - **output_filename**: Desired output PDF name
    
    Returns the created PDF file.
    """
    temp_paths: List[Path] = []

    try:
        if not files:
            raise HTTPException(status_code=400, detail="At least one image is required.")

        for upload in files:
            # Save all uploads
            path = await save_upload(upload, subdir="image_to_pdf")
            temp_paths.append(path)

        try:
            parsed_rotations = json.loads(rotations)
            if not isinstance(parsed_rotations, list):
                parsed_rotations = []
        except Exception:
            parsed_rotations = []
            
        try:
            parsed_flips = json.loads(flips)
            if not isinstance(parsed_flips, list):
                parsed_flips = []
        except Exception:
            parsed_flips = []

        try:
            out_path, total_pages, size_bytes = images_to_pdf(
                image_paths=temp_paths,
                page_size=page_size,
                output_filename=output_filename,
                rotations=parsed_rotations,
                flips_h=parsed_flips,
            )
        except ImageToPdfError as e:
            raise HTTPException(status_code=422, detail=str(e))

        return FileResponse(
            path=str(out_path),
            media_type="application/pdf",
            filename=out_path.name,
            headers={
                "X-Total-Pages": str(total_pages),
                "X-Page-Size": page_size.upper(),
                "X-Output-File": out_path.name,
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"image_to_pdf error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Image to PDF conversion failed due to an unexpected error.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        for p in temp_paths:
            cleanup_temp_file(p)
