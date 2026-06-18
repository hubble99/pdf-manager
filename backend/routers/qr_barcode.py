"""QR & Barcode Generator router — POST /api/v1/qr-barcode/qr and /barcode"""
import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel, Field

from core.qr_generator import generate_qr, QRGeneratorError
from core.barcode_generator import generate_barcode, BarcodeGeneratorError
from models.common import ErrorResponse

logger = logging.getLogger("pdf_manager.router.qr_barcode")
router = APIRouter(prefix="/qr-barcode", tags=["qr-barcode"])


class QRRequest(BaseModel):
    content: str = Field(..., min_length=1)
    size: int = Field(default=10, ge=1, le=20)
    error_correction: str = Field(default="M", pattern="^[LMQHlmqh]$")
    format: str = Field(default="png", pattern="^(?i)(png|svg)$")
    border: int = Field(default=4, ge=0)


class BarcodeRequest(BaseModel):
    content: str = Field(..., min_length=1)
    barcode_type: str = Field(default="code128")
    format: str = Field(default="png", pattern="^(?i)(png|svg)$")


@router.post("/qr")
async def qr_endpoint(request: QRRequest):
    """
    Generate a QR code.
    Returns the image directly.
    """
    try:
        img_bytes, mime_type = generate_qr(
            content=request.content,
            size=request.size,
            error_correction=request.error_correction,
            format=request.format,
            border=request.border,
        )
        
        return Response(
            content=img_bytes,
            media_type=mime_type,
            headers={
                "X-Format": request.format.upper(),
                "X-Content-Length": str(len(request.content)),
            }
        )
    except QRGeneratorError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"qr error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="QR generation failed.",
                detail=str(e),
            ).model_dump(),
        )


@router.post("/barcode")
async def barcode_endpoint(request: BarcodeRequest):
    """
    Generate a barcode.
    Returns the image directly.
    """
    try:
        img_bytes, mime_type = generate_barcode(
            content=request.content,
            barcode_type=request.barcode_type,
            out_format=request.format,
        )
        
        return Response(
            content=img_bytes,
            media_type=mime_type,
            headers={
                "X-Format": request.format.upper(),
                "X-Barcode-Type": request.barcode_type.upper(),
            }
        )
    except BarcodeGeneratorError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"barcode error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Barcode generation failed.",
                detail=str(e),
            ).model_dump(),
        )
