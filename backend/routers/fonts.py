"""App-level font library endpoints for Edit Canvas."""

import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from core import font_library
from models.common import ErrorResponse

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/fonts")
async def list_fonts():
    return {"fonts": font_library.list_fonts()}


@router.post("/fonts")
async def upload_font(file: UploadFile = File(...)):
    try:
        data = await file.read()
        saved = font_library.save_font(data, file.filename or "")
        return {"font": saved}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("upload_font error: %s", exc, exc_info=True)
        return Response(
            status_code=500,
            media_type="application/json",
            content=ErrorResponse(message="Could not store the uploaded font.", detail=str(exc)).model_dump_json(),
            headers={"content-type": "application/json"},
        )


@router.delete("/fonts/{font_id}")
async def delete_font(font_id: str):
    if not font_library.delete_font(font_id):
        raise HTTPException(status_code=404, detail=f"Font '{font_id}' is not installed.")
    return {"deleted": True}


@router.get("/fonts/{font_id}/file")
async def get_font_file(font_id: str):
    data = font_library.load_font_buffer(font_id)
    if data is None:
        raise HTTPException(status_code=404, detail=f"Font '{font_id}' is not installed.")
    media_type = "font/otf" if data[:4] == b"OTTO" else "font/ttf"
    return Response(content=data, media_type=media_type)
