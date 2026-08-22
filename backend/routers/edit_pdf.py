import json
import logging
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from config import settings
from core.edit_pdf import EditPdfStampError, save_edited_pdf
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload
from utils.filename_utils import sanitize_filename

logger = logging.getLogger(__name__)
router = APIRouter()


async def _read_annotations(upload: UploadFile) -> list:
    try:
        raw = await upload.read()
        payload = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Annotations file must be UTF-8 encoded JSON.") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid annotations JSON at line {exc.lineno}, column {exc.colno}.") from exc
    if not isinstance(payload, list):
        raise HTTPException(status_code=400, detail="Annotations JSON must be an array with one entry per PDF page.")
    for page_index, annotation in enumerate(payload):
        if annotation == "" or isinstance(annotation, (str, dict)):
            continue
        raise HTTPException(status_code=400, detail=f"Annotation entry at page index {page_index} must be a string, object, or empty string.")
    return payload


@router.post("/edit-pdf/save")
async def save_edited_pdf_endpoint(file: UploadFile = File(...), annotations: UploadFile = File(...), output_filename: str = Form("edited_document")):
    annotations_list = await _read_annotations(annotations)
    temp_path: Path | None = None
    try:
        temp_path = await save_upload(file, subdir="edit_pdf")
        safe_name = sanitize_filename(output_filename, "pdf")
        out_path = settings.OUTPUT_DIR / safe_name
        try:
            result = save_edited_pdf(temp_path, annotations_list, out_path)
        except EditPdfStampError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return FileResponse(
            path=str(out_path), media_type="application/pdf", filename=safe_name,
            headers={"X-Total-Pages": str(result["total_pages"]), "X-File-Size": str(result["size_bytes"]), "X-Output-File": safe_name},
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("save_edited_pdf_endpoint error: %s", exc, exc_info=True)
        return JSONResponse(status_code=500, content=ErrorResponse(message="Could not save edited PDF due to an unexpected error.", detail=str(exc)).model_dump())
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)
