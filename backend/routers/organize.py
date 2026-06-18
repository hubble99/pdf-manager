"""Organize PDF router — POST /api/v1/organize/"""
import json
import logging
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from core.pdf_organize import organize_pdf, OrganizeError
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload

logger = logging.getLogger("pdf_manager.router.organize")
router = APIRouter(prefix="/organize", tags=["organize"])

@router.post("/")
async def organize_pdf_endpoint(
    file: UploadFile = File(...),
    pages_config: str = Form(...),
    output_filename: str = Form(default="organized.pdf"),
):
    """
    Organize a PDF by reordering, rotating, duplicating, or deleting pages.
    - pages_config: JSON string of list of dicts. [{"page": 1, "rotation": 90}]
    """
    temp_path: Path | None = None
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF.")

        try:
            config = json.loads(pages_config)
            if not isinstance(config, list):
                raise ValueError("pages_config must be a list.")
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid pages_config JSON.")

        temp_path = await save_upload(file, subdir="organize")

        try:
            out_path, total_pages, size_bytes = organize_pdf(
                input_path=temp_path,
                pages_config=config,
                output_filename=output_filename,
            )
        except OrganizeError as e:
            raise HTTPException(status_code=422, detail=str(e))

        safe_name = out_path.name
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
        logger.error(f"organize error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Organize failed due to an unexpected error.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)
