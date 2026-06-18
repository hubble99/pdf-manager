"""
Merge PDF router — POST /api/v1/merge/
Accepts multiple PDF uploads, merges them in order, returns the merged PDF.
"""
import logging
from pathlib import Path
from typing import List

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from core.pdf_merge import MergeError, merge_pdfs
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload

logger = logging.getLogger("pdf_manager.router.merge")
router = APIRouter(prefix="/merge", tags=["merge"])


@router.post("/")
async def merge_pdfs_endpoint(
    files: List[UploadFile] = File(...),
    output_filename: str = Form(default="merged_output.pdf"),
):
    """
    Merge multiple PDF files into one.

    - **files**: 2+ PDF files (multipart/form-data)
    - **output_filename**: Desired filename for the result (optional)

    Returns the merged PDF as a downloadable file.
    """
    temp_paths: list[Path] = []

    try:
        # ── Validate: need at least 2 files ───────────────────────────────────
        if len(files) < 2:
            raise HTTPException(status_code=400, detail="At least 2 PDF files are required.")

        # ── Validate file types + save uploads ────────────────────────────────
        for upload in files:
            if not upload.filename or not upload.filename.lower().endswith(".pdf"):
                raise HTTPException(
                    status_code=400,
                    detail=f"'{upload.filename}' is not a PDF file.",
                )
            path = await save_upload(upload, subdir="merge")
            temp_paths.append(path)

        # ── Core logic ────────────────────────────────────────────────────────
        try:
            out_path, total_pages, size_bytes = merge_pdfs(temp_paths, output_filename)
        except MergeError as e:
            raise HTTPException(status_code=422, detail=str(e))

        # ── Return PDF directly ───────────────────────────────────────────────
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
        logger.error(f"merge error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Merge failed due to an unexpected error.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        for p in temp_paths:
            cleanup_temp_file(p)
