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


# ── Merge folder mode (F4) ────────────────────────────────────────────────────
# Folder mode works with files already on disk: the chosen folder is registered
# once, every later path is confined to it, and nothing is uploaded. The upload
# endpoint above is untouched and keeps its strict behaviour.

from pydantic import BaseModel, StrictBool, StrictStr
from typing import List

import os

from core.folder_scan import scan_folder
from core.path_safety import PathSafetyError, resolve_within_root
from core.pdf_merge import MergeProblem, describe_documents, inspect_documents, merge_documents
from features.merge.folders import FolderError, registry
from models.common import SuccessResponse


class RootRequest(BaseModel):
    path: StrictStr


class InspectRequest(BaseModel):
    root_id: StrictStr
    files: List[StrictStr]


class FolderMergeRequest(BaseModel):
    root_id: StrictStr
    files: List[StrictStr]
    output_filename: str = "merged_output.pdf"
    skip_invalid: StrictBool = True


def _root_or_422(root_id: str):
    try:
        return registry.get(root_id)
    except FolderError as e:
        # A lapsed registration is a normal workspace state, so the message is
        # already written for the user to act on.
        raise HTTPException(status_code=404, detail=str(e))


def _resolve_all(root_path: str, files: List[str]) -> list[Path]:
    resolved: list[Path] = []
    for relative in files:
        try:
            resolved.append(resolve_within_root(root_path, relative))
        except PathSafetyError as e:
            raise HTTPException(status_code=422, detail=str(e))
    return resolved


def _relative_lookup(root_path: str, files: List[str]) -> dict[str, str]:
    """Map each resolved path back to the relative path the caller sent.

    Problems are reported against the same path the interface queued, so the
    user can tell which row is affected and skipping can identify it.
    """
    lookup: dict[str, str] = {}
    for relative in files:
        try:
            resolved = resolve_within_root(root_path, relative)
        except PathSafetyError:
            continue
        lookup[os.path.normcase(str(resolved))] = relative
    return lookup


@router.post("/folder/roots/")
async def register_folder(request: RootRequest):
    """Register a folder chosen in the desktop dialog."""
    try:
        handle = registry.register(request.path)
    except FolderError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return SuccessResponse(
        data={"root_id": handle.root_id, "path": handle.path, "name": handle.name},
        message="Folder registered.",
    )


@router.post("/folder/roots/{root_id}/list/")
async def list_folder(root_id: str):
    """List the registered folder's PDFs in one eager walk."""
    handle = _root_or_422(root_id)
    result = scan_folder(handle.path)
    return SuccessResponse(data=result.to_dict(), message="Folder listed.")


@router.post("/folder/inspect/")
async def inspect_folder_files(request: InspectRequest):
    """Classify queued files so problems can be shown before merging."""
    handle = _root_or_422(request.root_id)
    resolved = _resolve_all(handle.path, request.files)
    usable, problems = inspect_documents(resolved)
    lookup = _relative_lookup(handle.path, request.files)
    return SuccessResponse(
        data={
            "usable": len(usable),
            "problems": [
                {"path": lookup.get(os.path.normcase(problem.path), problem.path), "reason": problem.reason}
                for problem in problems
            ],
        },
        message="Files inspected.",
    )


@router.post("/folder/info/")
async def describe_folder_files(request: InspectRequest):
    """Size and page count of queued files, shown beside each row like Quick mode."""
    handle = _root_or_422(request.root_id)
    resolved = _resolve_all(handle.path, request.files)
    return SuccessResponse(
        data={
            "files": [
                {"path": relative, "size_bytes": size, "pages": pages}
                for relative, (size, pages) in zip(request.files, describe_documents(resolved))
            ],
        },
        message="Files described.",
    )


@router.post("/folder/merge/")
async def merge_folder_files(request: FolderMergeRequest):
    """Merge the queued files, optionally skipping the unusable ones."""
    handle = _root_or_422(request.root_id)
    if len(request.files) < 2:
        raise HTTPException(status_code=400, detail="At least 2 PDF files are required.")
    resolved = _resolve_all(handle.path, request.files)

    try:
        outcome = merge_documents(
            resolved,
            request.output_filename,
            skip_invalid=request.skip_invalid,
        )
    except MergeError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return FileResponse(
        path=str(outcome.output_path),
        media_type="application/pdf",
        filename=outcome.output_path.name,
        headers={
            "X-Total-Pages": str(outcome.total_pages),
            "X-File-Size": str(outcome.size_bytes),
            "X-Output-File": outcome.output_path.name,
            "X-Merged-Files": str(outcome.merged),
            "X-Skipped-Files": str(len(outcome.skipped)),
        },
    )


@router.delete("/folder/roots/{root_id}")
async def release_folder(root_id: str):
    """Release a registration when the workspace no longer needs it."""
    if not registry.release(root_id):
        raise HTTPException(status_code=404, detail="Choose folder again.")
    return SuccessResponse(data={"root_id": root_id}, message="Folder released.")
