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

# ── Organize PDF 2.0 workspace ────────────────────────────────────────────────
# The workspace uploads each document once, renders thumbnails against that
# handle in bounded batches, and assembles the final page list on save. The
# original POST /organize/ endpoint above stays available unchanged.
#
# The two body-only endpoints take a real JSON body rather than a stringified
# JSON form field, so the page list is validated by the schema as well as by the
# assembler.

from typing import List

from pydantic import BaseModel, StrictBool, StrictInt, StrictStr

from core.organize_assembly import OrganizeAssemblyError, assemble_pages
from core.organize_thumbnails import DEFAULT_BATCH, DEFAULT_TARGET_WIDTH, ThumbnailError, render_batch
from features.organize.documents import DocumentError, registry
from models.common import SuccessResponse


class AssemblePage(BaseModel):
    source: StrictStr
    page: StrictInt = 1
    rotation: StrictInt = 0
    flip: StrictBool = False


class AssembleRequest(BaseModel):
    pages: List[AssemblePage]
    output_filename: str = "organized.pdf"


def _handle_or_404(document_id: str):
    try:
        return registry.get(document_id)
    except DocumentError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/documents/")
async def upload_document(file: UploadFile = File(...)):
    """Upload one PDF or image once and return the handle used by later calls."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="A file is required.")

    temp_path: Path | None = None
    try:
        temp_path = await save_upload(file, subdir="organize_documents")
        handle = registry.register(temp_path, file.filename)
    except DocumentError as e:
        if temp_path:
            cleanup_temp_file(temp_path)
        raise HTTPException(status_code=422, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        if temp_path:
            cleanup_temp_file(temp_path)
        logger.error(f"organize document upload error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="The document could not be added.")

    return SuccessResponse(
        data={
            "document_id": handle.document_id,
            "name": handle.name,
            "kind": handle.kind,
            "page_count": handle.page_count,
        },
        message="Document added.",
    )


@router.post("/documents/{document_id}/thumbnails/")
async def document_thumbnails(
    document_id: str,
    start: int = 1,
    count: int = DEFAULT_BATCH,
    target_width: int = DEFAULT_TARGET_WIDTH,
):
    """Render one bounded batch of page thumbnails for an uploaded document.

    The batch is described by query parameters, so this route takes no request
    body; the limits themselves are enforced in one place, by the renderer.
    """
    handle = _handle_or_404(document_id)
    try:
        batch = render_batch(
            handle.path,
            handle.kind,
            start=start,
            count=count,
            target_width=target_width,
        )
    except ThumbnailError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"thumbnail batch error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="The thumbnails could not be rendered.")

    batch["document_id"] = document_id
    batch["kind"] = handle.kind
    return SuccessResponse(data=batch, message="Thumbnails rendered.")


@router.delete("/documents/{document_id}")
async def release_document(document_id: str):
    """Release a document handle and delete its uploaded content."""
    if not registry.release(document_id):
        raise HTTPException(status_code=404, detail="That document is no longer available.")
    return SuccessResponse(data={"document_id": document_id}, message="Document released.")


@router.post("/assemble/")
async def assemble_document(request: AssembleRequest):
    """Assemble one PDF from the final ordered page list."""
    entries = [page.model_dump() for page in request.pages]

    documents = {}
    for entry in entries:
        source_id = entry["source"]
        if source_id not in documents:
            try:
                documents[source_id] = registry.get(source_id)
            except DocumentError:
                documents[source_id] = None

    try:
        out_path, total_pages, size_bytes = assemble_pages(entries, documents, request.output_filename)
    except OrganizeAssemblyError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"organize assemble error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Organize failed due to an unexpected error.",
                detail=str(e),
            ).model_dump(),
        )

    safe_name = out_path.name
    return FileResponse(
        path=str(out_path),
        media_type="application/pdf",
        filename=safe_name,
        headers={
            "X-Total-Pages": str(total_pages),
            "X-File-Size": str(size_bytes),
            "X-Output-File": safe_name,
        },
    )
