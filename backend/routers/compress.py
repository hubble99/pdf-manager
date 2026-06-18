"""
Compress PDF router — POST /api/v1/compress/
Accepts 1 PDF + quality level, returns the compressed PDF with metadata.
"""
import json
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from core.pdf_compress import CompressError, compress_pdf, compress_pdf_with_progress
from config import settings
from models.common import ErrorResponse
from utils.file_utils import cleanup_temp_file, save_upload

logger = logging.getLogger("pdf_manager.router.compress")
router = APIRouter(prefix="/compress", tags=["compress"])


@router.post("/")
async def compress_pdf_endpoint(
    file: UploadFile = File(...),
    quality: int = Form(default=70),
    output_filename: str = Form(default=""),
):
    """
    Compress a PDF by re-encoding embedded images at lower JPEG quality.

    - **file**: Source PDF
    - **quality**: JPEG quality 10–95 (default 70). Lower = smaller file.

    Returns the compressed PDF with size metadata in response headers.
    """
    temp_path: Path | None = None

    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF.")

        if not (10 <= quality <= 95):
            raise HTTPException(status_code=400, detail="Quality must be between 10 and 95.")

        temp_path = await save_upload(file, subdir="compress")

        try:
            result = compress_pdf(temp_path, quality=quality, output_filename=output_filename)
        except CompressError as e:
            raise HTTPException(status_code=422, detail=str(e))

        out_path: Path = result["output_path"]
        safe_filename = out_path.name
        return FileResponse(
            path=str(out_path),
            media_type="application/pdf",
            filename=safe_filename,
            headers={
                "X-Size-Before": str(result["size_before"]),
                "X-Size-After": str(result["size_after"]),
                "X-Reduction-Pct": str(result["reduction_pct"]),
                "X-Images-Processed": str(result["images_processed"]),
                "X-Output-File": safe_filename,
                "Content-Disposition": f'attachment; filename="{safe_filename}"',
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"compress error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Compression failed due to an unexpected error.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        if temp_path:
            cleanup_temp_file(temp_path)


# In-memory dictionary to store download paths
download_cache: dict[str, Path] = {}


@router.post("/stream")
async def compress_pdf_stream(
    file: UploadFile = File(...),
    quality: int = Form(default=70),
    output_filename: str = Form(default=""),
):
    temp_path: Path | None = None
    try:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="File must be a PDF.")
        if not (10 <= quality <= 95):
            raise HTTPException(status_code=400, detail="Quality must be between 10 and 95.")

        temp_path = await save_upload(file, subdir="compress")
        
        from utils.file_utils import sanitize_filename
        
        if output_filename:
            out_name = sanitize_filename(output_filename, "pdf")
        else:
            out_name = sanitize_filename(f"{Path(file.filename).stem}_compressed", "pdf")
            
        download_id = uuid.uuid4().hex
        # Include download_id in the filename for uniqueness during temp storage
        temp_out_name = f"{Path(out_name).stem}_{download_id[:8]}.pdf"
        out_path = settings.OUTPUT_DIR / temp_out_name

        def sse_generator():
            try:
                gen = compress_pdf_with_progress(str(temp_path), str(out_path), quality)
                while True:
                    try:
                        progress = next(gen)
                        event_data = {
                            "type": "progress",
                            "page": progress["page"],
                            "total": progress["total"],
                            "percent": progress["percent"],
                            "images_on_page": progress.get("images_on_page", 0)
                        }
                        yield f"data: {json.dumps(event_data)}\n\n"
                    except StopIteration as e:
                        result = e.value
                        event_data = {
                            "type": "complete",
                            "download_id": download_id,
                            "filename": out_name,
                            "size_before": result["size_before"],
                            "size_after": result["size_after"],
                            "reduction_pct": result["reduction_pct"],
                            "images_processed": result["images_processed"]
                        }
                        download_cache[download_id] = out_path
                        yield f"data: {json.dumps(event_data)}\n\n"
                        break
            except Exception as e:
                logger.error(f"SSE error: {e}", exc_info=True)
                yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            finally:
                if temp_path:
                    cleanup_temp_file(temp_path)

        return StreamingResponse(sse_generator(), media_type="text/event-stream")
    except Exception as e:
        if temp_path:
            cleanup_temp_file(temp_path)
        logger.error(f"compress_pdf_stream error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/download/{download_id}")
async def download_compressed_pdf(download_id: str):
    if download_id not in download_cache:
        raise HTTPException(status_code=404, detail="Download not found or expired.")
    
    file_path = download_cache.pop(download_id)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File no longer exists.")
        
    return FileResponse(
        path=str(file_path),
        media_type="application/pdf",
        filename=file_path.name,
    )

