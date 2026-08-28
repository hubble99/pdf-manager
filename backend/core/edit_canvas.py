import base64
from pathlib import Path

import fitz

from core.edit_canvas_shapes import (
    draw_native_ellipse,
    draw_native_ellipse_from_corners,
    draw_native_path,
    draw_native_text,
    rotate_line,
    shape_quad,
)


class EditCanvasStampError(Exception):
    def __init__(self, page_index: int, cause: Exception):
        self.page_index = page_index
        super().__init__(f"Could not stamp annotation on page index {page_index}: {cause}")


def hex_to_rgb(hex_str: str):
    if not hex_str or not isinstance(hex_str, str):
        return (0, 0, 0)
    value = hex_str.lstrip("#")
    if len(value) == 3:
        value = "".join(char * 2 for char in value)
    if len(value) != 6:
        return (0, 0, 0)
    return tuple(int(value[index:index + 2], 16) / 255.0 for index in (0, 2, 4))


def _draw_native_object(page, item, scale_x, scale_y):
    item_type = item.get("type")
    stroke_w = float(item.get("strokeWidth", 0)) * ((scale_x + scale_y) / 2)
    stroke_color = hex_to_rgb(item.get("strokeColor"))
    fill_color = hex_to_rgb(item.get("fillColor"))
    fill_opacity = max(0.0, min(1.0, float(item.get("fillOpacity", 100)) / 100.0))
    angle = float(item.get("angle", 0) or 0)

    if item_type in ("rect", "circle"):
        x = float(item.get("x", 0)) * scale_x
        y = float(item.get("y", 0)) * scale_y
        width = float(item.get("width", 0)) * scale_x
        height = float(item.get("height", 0)) * scale_y
        vector_corners = item.get("vectorCorners")
        if vector_corners and len(vector_corners) == 4:
            corners = [fitz.Point(float(point[0]) * scale_x, float(point[1]) * scale_y) for point in vector_corners]
            if item_type == "rect":
                geometry = fitz.Quad(corners[0], corners[1], corners[3], corners[2])
                page.draw_quad(geometry, color=stroke_color if stroke_w > 0 else None, fill=fill_color if fill_opacity > 0 else None, width=stroke_w, lineJoin=1, stroke_opacity=1.0, fill_opacity=fill_opacity)
            else:
                draw_native_ellipse_from_corners(page, corners, stroke_color if stroke_w > 0 else None, fill_color if fill_opacity > 0 else None, stroke_w, fill_opacity)
        elif item_type == "circle" and angle:
            draw_native_ellipse(page, x, y, width, height, angle, stroke_color if stroke_w > 0 else None, fill_color if fill_opacity > 0 else None, stroke_w, fill_opacity)
        else:
            geometry = shape_quad(x, y, width, height, angle) if angle else fitz.Rect(x, y, x + width, y + height)
            draw = page.draw_quad if item_type == "rect" and angle else page.draw_rect if item_type == "rect" else page.draw_oval
            draw(geometry, color=stroke_color if stroke_w > 0 else None, fill=fill_color if fill_opacity > 0 else None, width=stroke_w, stroke_opacity=1.0, fill_opacity=fill_opacity)
    elif item_type == "line":
        points = item.get("points", [0, 0, 0, 0])
        scaled = [points[0] * scale_x, points[1] * scale_y, points[2] * scale_x, points[3] * scale_y]
        p1, p2 = rotate_line(scaled, angle)
        page.draw_line(p1, p2, color=stroke_color, width=stroke_w, lineCap=1)
    elif item_type in ("pen", "highlighter"):
        commands = item.get("vectorPath") or item.get("points") or []
        if commands:
            draw_native_path(page, commands, float(item.get("x", 0)) * scale_x, float(item.get("y", 0)) * scale_y, scale_x, scale_y, stroke_color, stroke_w, float(item.get("opacity", 1)), item.get("transformMatrix"), item.get("pathOffset"))
    elif item_type == "text":
        draw_native_text(page, item, scale_x, scale_y, hex_to_rgb(item.get("color")))


def _insert_raster(page, encoded_image: str, target_rect=None):
    image_data = encoded_image.split(",", 1)[-1] if "," in encoded_image else encoded_image
    if image_data:
        page.insert_image(target_rect or page.rect, stream=base64.b64decode(image_data))


def _draw_legacy_shape(page, shape, scale_x, scale_y):
    x = shape.get("x", 0) * scale_x
    y = shape.get("y", 0) * scale_y
    width = shape.get("width", 0) * scale_x
    height = shape.get("height", 0) * scale_y
    stroke_width = shape.get("strokeWidth", 0) * ((scale_x + scale_y) / 2)
    stroke_color = hex_to_rgb(shape.get("strokeColor"))
    fill_color = hex_to_rgb(shape.get("fillColor"))
    fill_opacity = shape.get("fillOpacity", 100) / 100.0
    rect = fitz.Rect(x, y, x + width, y + height)
    if shape.get("type") == "rect":
        page.draw_rect(rect, color=stroke_color if stroke_width > 0 else None, fill=fill_color if fill_opacity > 0 else None, width=stroke_width, fill_opacity=fill_opacity)
    elif shape.get("type") == "circle":
        page.draw_oval(rect, color=stroke_color if stroke_width > 0 else None, fill=fill_color if fill_opacity > 0 else None, width=stroke_width, fill_opacity=fill_opacity)
    elif shape.get("type") == "line":
        points = shape.get("points", [0, 0, 0, 0])
        page.draw_line(fitz.Point(points[0] * scale_x, points[1] * scale_y), fitz.Point(points[2] * scale_x, points[3] * scale_y), color=stroke_color, width=stroke_width)


def save_edited_pdf(input_path: Path, annotations: list, output_path: Path) -> dict:
    document = fitz.open(str(input_path))
    try:
        for page_index, page_data in enumerate(annotations):
            if page_index >= len(document) or not page_data:
                continue
            page = document[page_index]
            try:
                if isinstance(page_data, str):
                    _insert_raster(page, page_data)
                    continue
                if page.rotation:
                    page.remove_rotation()
                native_objects = page_data.get("native_objects")
                shapes = native_objects if native_objects is not None else page_data.get("shapes", [])
                canvas_width = page_data.get("canvas_width", page.rect.width)
                canvas_height = page_data.get("canvas_height", page.rect.height)
                scale_x = page.rect.width / canvas_width
                scale_y = page.rect.height / canvas_height
                for shape in shapes:
                    if native_objects is not None:
                        _draw_native_object(page, shape, scale_x, scale_y)
                    else:
                        _draw_legacy_shape(page, shape, scale_x, scale_y)
                page_b64 = page_data.get("image_b64", "")
                if page_b64:
                    raster_rect = page_data.get("raster_rect")
                    target_rect = page.rect
                    if raster_rect and len(raster_rect) == 4:
                        target_rect = fitz.Rect(raster_rect[0] * scale_x, raster_rect[1] * scale_y, (raster_rect[0] + raster_rect[2]) * scale_x, (raster_rect[1] + raster_rect[3]) * scale_y)
                    _insert_raster(page, page_b64, target_rect)
            except Exception as exc:
                raise EditCanvasStampError(page_index, exc) from exc
        output_path.parent.mkdir(parents=True, exist_ok=True)
        document.save(str(output_path), garbage=4, deflate=True)
        return {"total_pages": document.page_count, "size_bytes": output_path.stat().st_size}
    finally:
        document.close()
