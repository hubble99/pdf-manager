"""Protect PDF router — POST /api/v1/protect/ and /api/v1/protect/remove"""
import logging
from pathlib import Path

import fitz
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from core.pdf_protect import protect_pdf, ProtectError
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload, sanitize_filename
from config import settings

logger = logging.getLogger("pdf_manager.router.protect")
router = APIRouter(prefix="/protect", tags=["protect"])

@router.post("/")
async def protect_pdf_endpoint(
    file: UploadFile = File(...),
    user_pw: str = Form(...),
    owner_pw: str = Form(default=""),
    output_filename: str = Form(default="protected.pdf"),
    allow_print: bool = Form(default=True),
    allow_copy: bool = Form(default=True),
    allow_modify: bool = Form(default=True),
):
    """
    Protect a PDF file with a password.
    Returns 422 if the PDF is already encrypted (use /remove first).
    """
    temp_path: Path | None = None
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF.")

        temp_path = await save_upload(file, subdir="protect")

        # Pre-check: block double-encryption
        try:
            doc = fitz.open(str(temp_path))
            is_encrypted = doc.is_encrypted
            doc.close()
        except Exception:
            is_encrypted = False
        if is_encrypted:
            raise HTTPException(
                status_code=422,
                detail="This PDF is already encrypted. Remove the existing password first."
            )

        try:
            out_path, total_pages, size_bytes = protect_pdf(
                input_path=temp_path,
                user_pw=user_pw,
                owner_pw=owner_pw,
                output_filename=output_filename,
                allow_print=allow_print,
                allow_copy=allow_copy,
                allow_modify=allow_modify,
            )
        except ProtectError as e:
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
        logger.error(f"protect error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Protect failed due to an unexpected error.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)


@router.post("/remove")
async def remove_password_endpoint(
    file: UploadFile = File(...),
    user_pw: str = Form(...),
    output_filename: str = Form(default=""),
):
    """
    Remove password protection from an encrypted PDF.
    The user_pw must match the document's user (open) password.
    """
    temp_path: Path | None = None
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF.")

        temp_path = await save_upload(file, subdir="protect")

        try:
            doc = fitz.open(str(temp_path))
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Cannot open PDF: {e}")

        if not doc.is_encrypted:
            doc.close()
            raise HTTPException(status_code=422, detail="This PDF is not encrypted — no password to remove.")

        # Authenticate
        auth_result = doc.authenticate(user_pw)
        if auth_result == 0:
            doc.close()
            raise HTTPException(status_code=422, detail="Incorrect password. Please provide the correct user password.")

        # Save without encryption
        stem = Path(output_filename).stem if output_filename else Path(file.filename).stem
        out_name = sanitize_filename(f"{stem}_unlocked", "pdf")
        out_path = settings.OUTPUT_DIR / out_name

        try:
            doc.save(
                str(out_path),
                garbage=4,
                deflate=True,
                encryption=fitz.PDF_ENCRYPT_NONE,
            )
            total_pages = doc.page_count
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to save unlocked PDF: {e}")
        finally:
            doc.close()

        size_bytes = out_path.stat().st_size
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
        logger.error(f"remove-password error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Password removal failed due to an unexpected error.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)
