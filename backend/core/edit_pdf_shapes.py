"""Geometry and native drawing helpers for the Edit PDF feature."""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Iterable

import fitz


def rotate_point(x: float, y: float, origin_x: float, origin_y: float, angle: float) -> fitz.Point:
    radians = math.radians(angle or 0)
    cosine, sine = math.cos(radians), math.sin(radians)
    dx, dy = x - origin_x, y - origin_y
    return fitz.Point(
        origin_x + dx * cosine - dy * sine,
        origin_y + dx * sine + dy * cosine,
    )


def shape_quad(x: float, y: float, width: float, height: float, angle: float = 0) -> fitz.Quad:
    """Return the four corners of a Fabric rectangle rotated around its center."""
    center_x, center_y = x + width / 2, y + height / 2
    return fitz.Quad(
        rotate_point(x, y, center_x, center_y, angle),
        rotate_point(x + width, y, center_x, center_y, angle),
        rotate_point(x, y + height, center_x, center_y, angle),
        rotate_point(x + width, y + height, center_x, center_y, angle),
    )


def rotate_line(points: Iterable[float], angle: float = 0) -> tuple[fitz.Point, fitz.Point]:
    x1, y1, x2, y2 = [float(value) for value in points]
    center_x, center_y = (x1 + x2) / 2, (y1 + y2) / 2
    return (
        rotate_point(x1, y1, center_x, center_y, angle),
        rotate_point(x2, y2, center_x, center_y, angle),
    )


def _ellipse_beziers(
    x: float, y: float, width: float, height: float, angle: float = 0
) -> list[tuple[fitz.Point, fitz.Point, fitz.Point, fitz.Point]]:
    """Build four cubic Bezier quarters for a rotated ellipse.

    PyMuPDF's page.draw_oval only accepts an axis-aligned rectangle.  Using a
    Shape keeps the ellipse vector-based while preserving Fabric's center
    rotation semantics.
    """
    center_x, center_y = x + width / 2, y + height / 2
    radius_x, radius_y = abs(width) / 2, abs(height) / 2
    kappa = 0.5522847498307936
    quarters = (
        ((1, 0), (1, kappa), (kappa, 1), (0, 1)),
        ((0, 1), (-kappa, 1), (-1, kappa), (-1, 0)),
        ((-1, 0), (-1, -kappa), (-kappa, -1), (0, -1)),
        ((0, -1), (kappa, -1), (1, -kappa), (1, 0)),
    )

    def point(nx: float, ny: float) -> fitz.Point:
        return rotate_point(
            center_x + nx * radius_x,
            center_y + ny * radius_y,
            center_x,
            center_y,
            angle,
        )

    return [tuple(point(*coords) for coords in quarter) for quarter in quarters]


def _ellipse_beziers_from_corners(
    corners: Iterable[fitz.Point],
) -> list[tuple[fitz.Point, fitz.Point, fitz.Point, fitz.Point]]:
    """Build an ellipse in the transformed rectangle described by Fabric corners.

    Fabric returns corners in top-left, top-right, bottom-right, bottom-left
    order. Deriving both local axes from those points preserves the actual
    center, rotation, and non-uniform scale without reconstructing an
    axis-aligned bounding box first.
    """
    top_left, top_right, _, bottom_left = list(corners)
    axis_x = fitz.Point(top_right.x - top_left.x, top_right.y - top_left.y)
    axis_y = fitz.Point(bottom_left.x - top_left.x, bottom_left.y - top_left.y)
    center = fitz.Point(
        top_left.x + (axis_x.x + axis_y.x) / 2,
        top_left.y + (axis_x.y + axis_y.y) / 2,
    )
    kappa = 0.5522847498307936
    quarters = (
        ((1, 0), (1, kappa), (kappa, 1), (0, 1)),
        ((0, 1), (-kappa, 1), (-1, kappa), (-1, 0)),
        ((-1, 0), (-1, -kappa), (-kappa, -1), (0, -1)),
        ((0, -1), (kappa, -1), (1, -kappa), (1, 0)),
    )

    def point(nx: float, ny: float) -> fitz.Point:
        return fitz.Point(
            center.x + nx * axis_x.x / 2 + ny * axis_y.x / 2,
            center.y + nx * axis_x.y / 2 + ny * axis_y.y / 2,
        )

    return [tuple(point(*coords) for coords in quarter) for quarter in quarters]


def draw_native_ellipse(
    page: fitz.Page,
    x: float,
    y: float,
    width: float,
    height: float,
    angle: float,
    color,
    fill,
    width_stroke: float,
    fill_opacity: float,
) -> None:
    """Draw a rotated ellipse as a filled/stroked vector path."""
    shape = page.new_shape()
    for bezier in _ellipse_beziers(x, y, width, height, angle):
        shape.draw_bezier(*bezier)
    shape.finish(
        width=width_stroke,
        color=color,
        fill=fill,
        stroke_opacity=1.0,
        fill_opacity=fill_opacity,
        closePath=True,
    )
    shape.commit()


def draw_native_ellipse_from_corners(
    page: fitz.Page,
    corners: Iterable[fitz.Point],
    color,
    fill,
    width_stroke: float,
    fill_opacity: float,
) -> None:
    """Draw a vector ellipse using Fabric's transformed corner geometry."""
    shape = page.new_shape()
    for bezier in _ellipse_beziers_from_corners(corners):
        shape.draw_bezier(*bezier)
    shape.finish(
        width=width_stroke,
        color=color,
        fill=fill,
        stroke_opacity=1.0,
        fill_opacity=fill_opacity,
        closePath=True,
    )
    shape.commit()


def draw_native_path(
    page: fitz.Page,
    commands: Iterable,
    offset_x: float,
    offset_y: float,
    scale_x: float,
    scale_y: float,
    color,
    width: float,
    opacity: float,
    transform_matrix=None,
    path_offset=None,
) -> None:
    """Draw Fabric freehand path commands as a vector Shape.

    Fabric emits M/L/Q/C commands. Quadratic segments are converted to cubic
    segments because PyMuPDF's Shape API exposes cubic Bezier primitives.
    """
    current = None
    start = None
    shape = page.new_shape()

    def scaled(point) -> fitz.Point:
        if transform_matrix and len(transform_matrix) == 6:
            a, b, c, d, e, f = [float(value) for value in transform_matrix]
            local_x, local_y = float(point[0]), float(point[1])
            if path_offset and len(path_offset) == 2:
                local_x -= float(path_offset[0])
                local_y -= float(path_offset[1])
            return fitz.Point(
                (a * local_x + c * local_y + e) * scale_x,
                (b * local_x + d * local_y + f) * scale_y,
            )
        return fitz.Point(
            offset_x + float(point[0]) * scale_x,
            offset_y + float(point[1]) * scale_y,
        )

    for command in commands or []:
        if not command:
            continue
        kind = str(command[0]).upper()
        values = command[1:]
        if kind == "M" and len(values) >= 2:
            current = scaled(values[:2])
            start = current
        elif kind == "L" and len(values) >= 2 and current is not None:
            end = scaled(values[:2])
            shape.draw_line(current, end)
            current = end
        elif kind == "Q" and len(values) >= 4 and current is not None:
            control = scaled(values[:2])
            end = scaled(values[2:4])
            c1 = fitz.Point(
                current.x + (control.x - current.x) * 2 / 3,
                current.y + (control.y - current.y) * 2 / 3,
            )
            c2 = fitz.Point(
                end.x + (control.x - end.x) * 2 / 3,
                end.y + (control.y - end.y) * 2 / 3,
            )
            shape.draw_bezier(current, c1, c2, end)
            current = end
        elif kind == "C" and len(values) >= 6 and current is not None:
            shape.draw_bezier(
                current,
                scaled(values[:2]),
                scaled(values[2:4]),
                scaled(values[4:6]),
            )
            current = scaled(values[4:6])
        elif kind == "Z" and current is not None and start is not None:
            shape.draw_line(current, start)
            current = start

    if current is not None:
        shape.finish(
            width=width,
            color=color,
            lineCap=1,
            lineJoin=1,
            stroke_opacity=max(0.0, min(1.0, opacity)),
            closePath=False,
        )
        shape.commit()


def _font_candidates(family: str, bold: bool, italic: bool) -> list[str]:
    suffix = "bi" if bold and italic else "bd" if bold else "i" if italic else ""
    normalized = (family or "Arial").lower()
    families = {
        "arial": f"arial{suffix}.ttf",
        "calibri": f"calibri{'z' if bold and italic else 'b' if bold else 'i' if italic else ''}.ttf",
        "cambria": f"cambria{'z' if bold and italic else 'b' if bold else 'i' if italic else ''}.ttf",
        "times new roman": f"times{suffix}.ttf",
        "courier new": f"cour{suffix}.ttf",
        "georgia": f"georgia{'z' if bold and italic else 'b' if bold else 'i' if italic else ''}.ttf",
        "verdana": f"verdana{'z' if bold and italic else 'b' if bold else 'i' if italic else ''}.ttf",
        "tahoma": f"tahoma{'bd' if bold else ''}.ttf" if not italic else f"arial{suffix}.ttf",
        "trebuchet ms": f"trebuc{'bi' if bold and italic else 'bd' if bold else 'it' if italic else ''}.ttf",
        "century gothic": f"gothic{'bi' if bold and italic else 'b' if bold else 'i' if italic else ''}.ttf",
    }
    return [families.get(normalized, f"arial{suffix}.ttf"), "arial.ttf"]


def load_font(family: str, bold: bool = False, italic: bool = False) -> fitz.Font:
    font_dir = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    for filename in _font_candidates(family, bold, italic):
        path = font_dir / filename
        if path.exists():
            return fitz.Font(fontfile=str(path), embed=True)
    return fitz.Font("helv")


def draw_native_text(page: fitz.Page, item: dict, scale_x: float, scale_y: float, color) -> None:
    font = load_font(item.get("fontFamily", "Arial"), item.get("bold", False), item.get("italic", False))
    font_size = max(1.0, float(item.get("fontSize", 12)) * (scale_x + scale_y) / 2)
    x, y = float(item.get("x", 0)) * scale_x, float(item.get("y", 0)) * scale_y
    width = float(item.get("width") or 0) * scale_x
    lines = item.get("lines") or str(item.get("text", "")).splitlines() or [""]
    line_widths = item.get("lineWidths") or []
    align = item.get("textAlign", "left")
    line_height = font_size * float(item.get("lineHeight", 1.16))
    writer = fitz.TextWriter(page.rect)
    baseline = y + font_size * font.ascender
    for index, line in enumerate(lines):
        offset = 0.0
        line_width = float(line_widths[index]) * scale_x if index < len(line_widths) else font.text_length(line, fontsize=font_size)
        if align == "center":
            offset = max(0.0, (width - line_width) / 2)
        elif align == "right":
            offset = max(0.0, width - line_width)
        writer.append(fitz.Point(x + offset, baseline + index * line_height), line, font=font, fontsize=font_size)
    transform_matrix = item.get("transformMatrix")
    if transform_matrix and len(transform_matrix) == 6:
        angle = math.degrees(math.atan2(float(transform_matrix[1]), float(transform_matrix[0])))
    else:
        angle = float(item.get("angle", 0) or 0)
    writer.write_text(
        page,
        color=color,
        opacity=max(0.0, min(1.0, float(item.get("opacity", 1)))),
        morph=(fitz.Point(x, y), fitz.Matrix(angle)) if angle else None,
        overlay=True,
    )
