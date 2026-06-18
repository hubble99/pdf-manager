"""Metadata router — POST /api/v1/metadata/"""
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from config import settings
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload, sanitize_filename

logger = logging.getLogger("pdf_manager.router.metadata")
router = APIRouter(prefix="/metadata", tags=["metadata"])

@router.post("/")
async def update_pdf_metadata(
    file: UploadFile = File(...),
    title: str = Form(default=""),
    author: str = Form(default=""),
    subject: str = Form(default=""),
    keywords: str = Form(default=""),
):
    """
    Update PDF metadata.
    """
    temp_path: Path | None = None
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF.")

        temp_path = await save_upload(file, subdir="metadata")

        import fitz  # PyMuPDF
        
        try:
            doc = fitz.open(str(temp_path))
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Cannot open PDF: {e}")

        if doc.is_encrypted:
            doc.close()
            raise HTTPException(status_code=403, detail="PDF is encrypted.")

        meta = doc.metadata
        if title is not None: meta["title"] = title
        if author is not None: meta["author"] = author
        if subject is not None: meta["subject"] = subject
        if keywords is not None: meta["keywords"] = keywords

        doc.set_metadata(meta)

        title_str = title.strip()
        if title_str:
            safe_name = sanitize_filename(title_str, "pdf")
        else:
            original_name = file.filename or "output.pdf"
            safe_name = sanitize_filename(
                original_name.replace(".pdf", ""), "pdf"
            )

        out_name = f"{safe_name}_{uuid.uuid4().hex[:8]}.pdf"
        out_path = settings.OUTPUT_DIR / out_name

        doc.save(str(out_path), garbage=4, deflate=True)
        doc.close()

        return FileResponse(
            path=str(out_path),
            media_type="application/pdf",
            filename=safe_name,
            headers={
                "Content-Disposition": f'attachment; filename="{safe_name}"',
                "X-Output-File": safe_name,
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"metadata error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Metadata update failed.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)
