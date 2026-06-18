"""
Extract Pages router — POST /api/v1/extract/
Accepts 1 PDF + page range string + output mode.
Returns either a PDF (combine) or ZIP (multi-file modes).
"""
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from core.pdf_extract import ExtractError, OUTPUT_MODES, extract_pages
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload, sanitize_filename, sanitize_stem

logger = logging.getLogger("pdf_manager.router.extract")
router = APIRouter(prefix="/extract", tags=["extract"])

_MODE_MIME = {
    "combine": "application/pdf",
    "separate_page": "application/zip",
    "separate_range": "application/zip",
    "split_all": "application/zip",
}


@router.post("/")
async def extract_pages_endpoint(
    file: UploadFile = File(...),
    page_ranges: str = Form(default="1"),
    output_mode: str = Form(default="combine"),
    output_filename: str = Form(default=""),
):
    """
    Extract pages from a PDF.

    - **file**: Source PDF
    - **page_ranges**: E.g. "1-3,5,7-9" (ignored for split_all)
    - **output_mode**: combine | separate_page | separate_range | split_all
    - **output_filename**: Desired base name for output file(s)
    """
    temp_path: Path | None = None

    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF.")

        if output_mode not in OUTPUT_MODES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid output_mode. Choose from: {', '.join(sorted(OUTPUT_MODES))}",
            )

        temp_path = await save_upload(file, subdir="extract")

        is_zip = output_mode != "combine"
        ext = "zip" if is_zip else "pdf"

        # Derive a clean name from original filename (no UUID, no .pdf extension)
        original_stem = sanitize_stem(file.filename or "document")

        # Determine the target filename
        if output_filename:
            target_stem = sanitize_stem(output_filename)
        else:
            target_stem = f"extracted_{original_stem}"

        safe_name = sanitize_filename(target_stem, ext)           # e.g. "extracted_report.zip"
        clean_name = Path(safe_name).stem                          # e.g. "extracted_report"
        out_name = f"{clean_name}_{uuid.uuid4().hex[:8]}.{ext}"   # unique name on disk

        try:
            out_path, pages_extracted = extract_pages(
                input_path=temp_path,
                page_str=page_ranges,
                output_mode=output_mode,
                out_name=out_name,
                clean_name=Path(safe_name).stem,
            )
        except ExtractError as e:
            raise HTTPException(status_code=422, detail=str(e))

        mime = _MODE_MIME[output_mode]

        return FileResponse(
            path=str(out_path),
            media_type=mime,
            filename=safe_name,
            headers={
                "X-Pages-Extracted": str(pages_extracted),
                "X-Output-File": safe_name,
                "X-Output-Mode": output_mode,
                "Content-Disposition": f'attachment; filename="{safe_name}"',
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"extract error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Extraction failed due to an unexpected error.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)
