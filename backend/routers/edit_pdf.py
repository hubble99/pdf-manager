import base64
import logging
import json

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse

import fitz
from config import settings
from core.edit_pdf_shapes import (
    draw_native_ellipse,
    draw_native_ellipse_from_corners,
    draw_native_path,
    draw_native_text,
    rotate_line,
    shape_quad,
)
from utils.file_utils import cleanup_temp_file, save_upload
from utils.filename_utils import sanitize_filename
from models.common import ErrorResponse

logger = logging.getLogger(__name__)

router = APIRouter()


def hex_to_rgb(hex_str: str):
    if not hex_str or not isinstance(hex_str, str): return (0, 0, 0)
    hex_str = hex_str.lstrip('#')
    if len(hex_str) == 3:
        hex_str = "".join([c*2 for c in hex_str])
    if len(hex_str) != 6: return (0, 0, 0)
    return (int(hex_str[0:2], 16)/255.0, int(hex_str[2:4], 16)/255.0, int(hex_str[4:6], 16)/255.0)


def _draw_native_object(page, item, scale_x, scale_y):
    item_type = item.get("type")
    stroke_w = float(item.get("strokeWidth", 0)) * ((scale_x + scale_y) / 2)
    stroke_color = hex_to_rgb(item.get("strokeColor"))
    fill_color = hex_to_rgb(item.get("fillColor"))
    fill_opacity = max(0.0, min(1.0, float(item.get("fillOpacity", 100)) / 100.0))
    angle = float(item.get("angle", 0) or 0)

    if item_type in ("rect", "circle"):
        x, y = float(item.get("x", 0)) * scale_x, float(item.get("y", 0)) * scale_y
        width, height = float(item.get("width", 0)) * scale_x, float(item.get("height", 0)) * scale_y
        vector_corners = item.get("vectorCorners")
        if vector_corners and len(vector_corners) == 4:
            corners = [fitz.Point(float(point[0]) * scale_x, float(point[1]) * scale_y) for point in vector_corners]
            if item_type == "rect":
                geometry = fitz.Quad(corners[0], corners[1], corners[3], corners[2])
                page.draw_quad(geometry, color=stroke_color if stroke_w > 0 else None,
                               fill=fill_color if fill_opacity > 0 else None, width=stroke_w,
                               lineJoin=1, stroke_opacity=1.0, fill_opacity=fill_opacity)
            else:
                draw_native_ellipse_from_corners(
                    page,
                    corners,
                    stroke_color if stroke_w > 0 else None,
                    fill_color if fill_opacity > 0 else None,
                    stroke_w,
                    fill_opacity,
                )
        elif item_type == "circle" and angle:
            draw_native_ellipse(page, x, y, width, height, angle,
                                stroke_color if stroke_w > 0 else None,
                                fill_color if fill_opacity > 0 else None,
                                stroke_w, fill_opacity)
        else:
            geometry = shape_quad(x, y, width, height, angle) if angle else fitz.Rect(x, y, x + width, y + height)
            draw = page.draw_quad if item_type == "rect" and angle else page.draw_rect if item_type == "rect" else page.draw_oval
            draw(geometry, color=stroke_color if stroke_w > 0 else None,
                 fill=fill_color if fill_opacity > 0 else None, width=stroke_w,
                 stroke_opacity=1.0, fill_opacity=fill_opacity)
    elif item_type == "line":
        points = item.get("points", [0, 0, 0, 0])
        scaled = [points[0] * scale_x, points[1] * scale_y, points[2] * scale_x, points[3] * scale_y]
        p1, p2 = rotate_line(scaled, angle)
        page.draw_line(p1, p2, color=stroke_color, width=stroke_w, lineCap=1)
    elif item_type in ("pen", "highlighter"):
        commands = item.get("vectorPath") or item.get("points") or []
        if commands:
            draw_native_path(
                page, commands,
                float(item.get("x", 0)) * scale_x,
                float(item.get("y", 0)) * scale_y,
                scale_x, scale_y, stroke_color, stroke_w,
                float(item.get("opacity", 1)),
                item.get("transformMatrix"),
                item.get("pathOffset"),
            )
    elif item_type == "text":
        draw_native_text(page, item, scale_x, scale_y, hex_to_rgb(item.get("color")))


async def _read_annotations(upload: UploadFile) -> list:
    """Decode and validate the multipart annotation document."""
    try:
        raw = await upload.read()
        payload = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail="Annotations file must be UTF-8 encoded JSON.",
        ) from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid annotations JSON at line {exc.lineno}, column {exc.colno}.",
        ) from exc

    if not isinstance(payload, list):
        raise HTTPException(
            status_code=400,
            detail="Annotations JSON must be an array with one entry per PDF page.",
        )

    for page_index, annotation in enumerate(payload):
        if annotation == "" or isinstance(annotation, (str, dict)):
            continue
        raise HTTPException(
            status_code=400,
            detail=f"Annotation entry at page index {page_index} must be a string, object, or empty string.",
        )

    return payload

@router.post("/edit-pdf/save")
async def save_edited_pdf_endpoint(
    file: UploadFile = File(...),
    annotations: UploadFile = File(...),
    output_filename: str = Form("edited_document")
):
    annotations_list = await _read_annotations(annotations)
    temp_path = None
    doc = None

    try:
        temp_path = await save_upload(file, subdir="edit_pdf")
        doc = fitz.open(temp_path)

        for idx, page_data in enumerate(annotations_list):
            if idx >= len(doc):
                break

            if not page_data:
                continue # No annotations for this page

            page = doc[idx]

            try:
                if isinstance(page_data, str):
                    # Legacy raster-only
                    page_b64 = page_data
                    if "," in page_b64:
                        page_b64 = page_b64.split(",", 1)[1]
                    if page_b64:
                        img_bytes = base64.b64decode(page_b64)
                        page.insert_image(page.rect, stream=img_bytes)
                elif isinstance(page_data, dict):
                    # Hybrid vector/raster
                    # Normalize /Rotate while preserving appearance. Canvas coordinates
                    # then match the rendered page dimensions used by the editor.
                    if page.rotation:
                        page.remove_rotation()
                    page_b64 = page_data.get("image_b64", "")
                    native_objects = page_data.get("native_objects")
                    shapes = native_objects if native_objects is not None else page_data.get("shapes", [])
                    canvas_w = page_data.get("canvas_width", page.rect.width)
                    canvas_h = page_data.get("canvas_height", page.rect.height)

                    # Scale factors from frontend CSS pixels to PDF points
                    scale_x = page.rect.width / canvas_w
                    scale_y = page.rect.height / canvas_h

                    # 1. Draw native objects in editor layer order.
                    for shape in shapes:
                        if native_objects is not None:
                            _draw_native_object(page, shape, scale_x, scale_y)
                            continue
                        x = shape.get("x", 0) * scale_x
                        y = shape.get("y", 0) * scale_y
                        w = shape.get("width", 0) * scale_x
                        h = shape.get("height", 0) * scale_y

                        stroke_w = shape.get("strokeWidth", 0) * ((scale_x + scale_y) / 2)
                        stroke_color = hex_to_rgb(shape.get("strokeColor"))
                        fill_color = hex_to_rgb(shape.get("fillColor"))
                        fill_opacity = shape.get("fillOpacity", 100) / 100.0

                        rect = fitz.Rect(x, y, x + w, y + h)

                        if shape.get("type") == "rect":
                            page.draw_rect(
                                rect,
                                color=stroke_color if stroke_w > 0 else None,
                                fill=fill_color if fill_opacity > 0 else None,
                                width=stroke_w,
                                fill_opacity=fill_opacity
                            )
                        elif shape.get("type") == "circle":
                            page.draw_oval(
                                rect,
                                color=stroke_color if stroke_w > 0 else None,
                                fill=fill_color if fill_opacity > 0 else None,
                                width=stroke_w,
                                fill_opacity=fill_opacity
                            )
                        elif shape.get("type") == "line":
                            pts = shape.get("points", [0,0,0,0])
                            p1 = fitz.Point(pts[0] * scale_x, pts[1] * scale_y)
                            p2 = fitz.Point(pts[2] * scale_x, pts[3] * scale_y)
                            page.draw_line(
                                p1, p2,
                                color=stroke_color,
                                width=stroke_w
                            )

                    # 2. Draw Raster Overlay (Freehand/Text)
                    if page_b64:
                        if "," in page_b64:
                            page_b64 = page_b64.split(",", 1)[1]
                        img_bytes = base64.b64decode(page_b64)
                        raster_rect = page_data.get("raster_rect")
                        target_rect = page.rect
                        if raster_rect and len(raster_rect) == 4:
                            target_rect = fitz.Rect(
                                raster_rect[0] * scale_x, raster_rect[1] * scale_y,
                                (raster_rect[0] + raster_rect[2]) * scale_x,
                                (raster_rect[1] + raster_rect[3]) * scale_y,
                            )
                        page.insert_image(target_rect, stream=img_bytes)
            except Exception as e:
                logger.error(f"Error stamping annotation on page {idx}: {e}", exc_info=True)
                raise HTTPException(
                    status_code=422,
                    detail=f"Could not stamp annotation on page index {idx}: {e}"
                )

        # Ensure output directory exists
        settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        
        safe_name = sanitize_filename(output_filename, "pdf")
        out_path = settings.OUTPUT_DIR / safe_name
        
        # Save document
        doc.save(str(out_path), garbage=4, deflate=True)
        total_pages = doc.page_count
        size_bytes = out_path.stat().st_size
        doc.close()
        doc = None
        cleanup_temp_file(temp_path)
        temp_path = None
        
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
        logger.error(f"save_edited_pdf_endpoint error: {e}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(
                status="error",
                message="Could not save edited PDF due to an unexpected error.",
                detail=str(e),
            ).model_dump(),
        )
    finally:
        if doc is not None:
            doc.close()
        if temp_path is not None:
            cleanup_temp_file(temp_path)
