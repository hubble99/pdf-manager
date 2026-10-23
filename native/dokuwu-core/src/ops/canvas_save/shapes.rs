//! Rectangles, ellipses, lines and pen strokes.
//!
//! Every function draws in the page's own (upright, top-left origin)
//! coordinates, already scaled from canvas units, into a `Shape`, which turns
//! them into PDF operators for the page's real orientation.

use mupdf::shape::{FinishOptions, PdfColor, Shape};
use mupdf::{Point, Quad, Rect};
use serde_json::Value;

use super::model::{numbers, value_f64, NativeObject};

/// Page units per canvas unit.
#[derive(Debug, Clone, Copy)]
pub struct Scale {
    pub x: f64,
    pub y: f64,
}

impl Scale {
    pub fn mean(self) -> f64 {
        (self.x + self.y) / 2.0
    }
}

type DrawResult = Result<(), String>;

pub fn err(e: mupdf::Error) -> String {
    e.to_string()
}

pub fn pt(x: f64, y: f64) -> Point {
    Point::new(x as f32, y as f32)
}

/// `#rgb` and `#rrggbb`; anything else of the wrong length is black, as before.
pub fn hex_to_rgb(text: Option<&str>) -> Result<[f32; 3], String> {
    let Some(text) = text.filter(|t| !t.is_empty()) else { return Ok([0.0; 3]) };
    let value = text.trim_start_matches('#');
    let expanded: String = if value.chars().count() == 3 {
        value.chars().flat_map(|c| [c, c]).collect()
    } else {
        value.to_string()
    };
    if expanded.chars().count() != 6 || !expanded.is_ascii() {
        return Ok([0.0; 3]);
    }
    let mut out = [0f32; 3];
    for (i, slot) in out.iter_mut().enumerate() {
        let byte = u8::from_str_radix(&expanded[i * 2..i * 2 + 2], 16)
            .map_err(|_| format!("{text:?} is not a colour"))?;
        *slot = byte as f32 / 255.0;
    }
    Ok(out)
}

pub fn rgb(text: Option<&str>) -> Result<PdfColor, String> {
    let [r, g, b] = hex_to_rgb(text)?;
    Ok(PdfColor::rgb(r, g, b))
}

/// Rotation of `(x, y)` about an origin, degrees, y down.
pub fn rotate_point(x: f64, y: f64, origin_x: f64, origin_y: f64, angle: f64) -> (f64, f64) {
    let radians = angle.to_radians();
    let (sin, cos) = radians.sin_cos();
    let (dx, dy) = (x - origin_x, y - origin_y);
    (origin_x + dx * cos - dy * sin, origin_y + dx * sin + dy * cos)
}

/// The four corners of a rectangle rotated about its centre, as a quad
/// (upper left, upper right, lower left, lower right).
pub fn shape_quad(x: f64, y: f64, width: f64, height: f64, angle: f64) -> Quad {
    let (cx, cy) = (x + width / 2.0, y + height / 2.0);
    let p = |px: f64, py: f64| {
        let (rx, ry) = rotate_point(px, py, cx, cy, angle);
        pt(rx, ry)
    };
    Quad::new(p(x, y), p(x + width, y), p(x, y + height), p(x + width, y + height))
}

const KAPPA: f64 = 0.552_284_749_830_793_6;
const QUARTERS: [[(f64, f64); 4]; 4] = [
    [(1.0, 0.0), (1.0, KAPPA), (KAPPA, 1.0), (0.0, 1.0)],
    [(0.0, 1.0), (-KAPPA, 1.0), (-1.0, KAPPA), (-1.0, 0.0)],
    [(-1.0, 0.0), (-1.0, -KAPPA), (-KAPPA, -1.0), (0.0, -1.0)],
    [(0.0, -1.0), (KAPPA, -1.0), (1.0, -KAPPA), (1.0, 0.0)],
];

fn draw_ellipse(shape: &mut Shape<'_>, map: impl Fn(f64, f64) -> Point) -> DrawResult {
    for quarter in QUARTERS {
        let [a, b, c, d] = quarter.map(|(nx, ny)| map(nx, ny));
        shape.draw_bezier(a, b, c, d).map_err(err)?;
    }
    Ok(())
}

/// An ellipse in the rectangle of `width` by `height` at `(x, y)`, turned about
/// its centre.
fn ellipse_at_angle(shape: &mut Shape<'_>, x: f64, y: f64, width: f64, height: f64, angle: f64) -> DrawResult {
    let (cx, cy) = (x + width / 2.0, y + height / 2.0);
    let (rx, ry) = (width.abs() / 2.0, height.abs() / 2.0);
    draw_ellipse(shape, |nx, ny| {
        let (px, py) = rotate_point(cx + nx * rx, cy + ny * ry, cx, cy, angle);
        pt(px, py)
    })
}

/// An ellipse inside the parallelogram of the editor's four corners (upper
/// left, upper right, lower right, lower left).
fn ellipse_in_corners(shape: &mut Shape<'_>, corners: &[Point; 4]) -> DrawResult {
    let (tl, tr, bl) = (corners[0], corners[1], corners[3]);
    let axis_x = (tr.x - tl.x, tr.y - tl.y);
    let axis_y = (bl.x - tl.x, bl.y - tl.y);
    let center = (tl.x + (axis_x.0 + axis_y.0) / 2.0, tl.y + (axis_x.1 + axis_y.1) / 2.0);
    draw_ellipse(shape, |nx, ny| {
        let (nx, ny) = (nx as f32, ny as f32);
        Point::new(
            center.0 + nx * axis_x.0 / 2.0 + ny * axis_y.0 / 2.0,
            center.1 + nx * axis_x.1 / 2.0 + ny * axis_y.1 / 2.0,
        )
    })
}

fn f(value: Option<f64>, default: f64) -> f64 {
    value.unwrap_or(default)
}

/// The object's four corners in page units when it carries `vectorCorners`.
pub fn corners_of(item: &NativeObject<'_>, scale: Scale) -> Result<Option<[Point; 4]>, String> {
    let Some(corners) = item.vector_corners.as_ref().filter(|c| c.len() == 4) else { return Ok(None) };
    let mut out = [Point::new(0.0, 0.0); 4];
    for (slot, corner) in out.iter_mut().zip(corners) {
        let numbers = corner
            .as_array()
            .and_then(|a| numbers(a))
            .filter(|n| n.len() >= 2)
            .ok_or_else(|| "vectorCorners must be four [x, y] pairs".to_string())?;
        *slot = pt(numbers[0] * scale.x, numbers[1] * scale.y);
    }
    Ok(Some(out))
}

fn line_options(width: f64, color: PdfColor, close_path: bool) -> FinishOptions {
    FinishOptions {
        color: Some(color),
        width: width as f32,
        line_cap: Some(1),
        close_path,
        ..Default::default()
    }
}

/// `rect` and `circle`.
pub fn draw_rect_or_ellipse(shape: &mut Shape<'_>, item: &NativeObject<'_>, scale: Scale, is_rect: bool) -> DrawResult {
    let stroke_w = f(item.stroke_width, 0.0) * scale.mean();
    let stroke = rgb(item.stroke_color.as_deref())?;
    let fill = rgb(item.fill_color.as_deref())?;
    let fill_opacity = (f(item.fill_opacity, 100.0) / 100.0).clamp(0.0, 1.0);
    let angle = f(item.angle, 0.0);
    let x = f(item.x, 0.0) * scale.x;
    let y = f(item.y, 0.0) * scale.y;
    let width = f(item.width, 0.0) * scale.x;
    let height = f(item.height, 0.0) * scale.y;
    let mut options = FinishOptions {
        color: (stroke_w > 0.0).then_some(stroke),
        fill: (fill_opacity > 0.0).then_some(fill),
        width: stroke_w as f32,
        stroke_opacity: Some(1.0),
        fill_opacity: Some(fill_opacity as f32),
        ..Default::default()
    };

    if let Some(corners) = corners_of(item, scale)? {
        if is_rect {
            options.line_join = Some(1);
            shape.draw_quad(Quad::new(corners[0], corners[1], corners[3], corners[2])).map_err(err)?;
        } else {
            ellipse_in_corners(shape, &corners)?;
        }
    } else if !is_rect && angle != 0.0 {
        ellipse_at_angle(shape, x, y, width, height, angle)?;
    } else if angle != 0.0 {
        shape.draw_quad(shape_quad(x, y, width, height, angle)).map_err(err)?;
    } else {
        let rect = Rect::new(x as f32, y as f32, (x + width) as f32, (y + height) as f32);
        if is_rect {
            shape.draw_rect(&rect).map_err(err)?;
        } else {
            shape.draw_oval(rect).map_err(err)?;
        }
    }
    shape.finish(&options).map_err(err)?;
    Ok(())
}

pub fn draw_line(shape: &mut Shape<'_>, item: &NativeObject<'_>, scale: Scale) -> DrawResult {
    let points = match &item.points {
        Some(values) => numbers(values).filter(|n| n.len() >= 4).ok_or_else(|| "a line needs four coordinates".to_string())?,
        None => vec![0.0; 4],
    };
    let (x1, y1, x2, y2) = (points[0] * scale.x, points[1] * scale.y, points[2] * scale.x, points[3] * scale.y);
    let (cx, cy) = ((x1 + x2) / 2.0, (y1 + y2) / 2.0);
    let angle = f(item.angle, 0.0);
    let (ax, ay) = rotate_point(x1, y1, cx, cy, angle);
    let (bx, by) = rotate_point(x2, y2, cx, cy, angle);
    let width = f(item.stroke_width, 0.0) * scale.mean();
    shape.draw_line(pt(ax, ay), pt(bx, by)).map_err(err)?;
    shape.finish(&line_options(width, rgb(item.stroke_color.as_deref())?, false)).map_err(err)?;
    Ok(())
}

/// A pen or highlighter stroke: Fabric's M/L/Q/C/Z path commands as a vector.
pub fn draw_path(shape: &mut Shape<'_>, item: &NativeObject<'_>, scale: Scale) -> DrawResult {
    let commands: &[Value] = item
        .vector_path
        .as_deref()
        .filter(|c| !c.is_empty())
        .or(item.points.as_deref())
        .unwrap_or(&[]);
    if commands.is_empty() {
        return Ok(());
    }
    let offset = (f(item.x, 0.0) * scale.x, f(item.y, 0.0) * scale.y);
    let matrix = item
        .transform_matrix
        .as_deref()
        .and_then(numbers)
        .filter(|m| m.len() == 6);
    let path_offset = item.path_offset.as_deref().and_then(numbers).filter(|o| o.len() == 2);

    let scaled = |x: f64, y: f64| -> Point {
        if let Some(m) = &matrix {
            let (mut lx, mut ly) = (x, y);
            if let Some(o) = &path_offset {
                lx -= o[0];
                ly -= o[1];
            }
            return pt((m[0] * lx + m[2] * ly + m[4]) * scale.x, (m[1] * lx + m[3] * ly + m[5]) * scale.y);
        }
        pt(offset.0 + x * scale.x, offset.1 + y * scale.y)
    };

    let mut current: Option<Point> = None;
    let mut start: Option<Point> = None;
    for command in commands {
        let Some(items) = command.as_array().filter(|c| !c.is_empty()) else { continue };
        let kind = items[0].as_str().unwrap_or("").to_uppercase();
        let values: Vec<f64> = items[1..].iter().filter_map(value_f64).collect();
        let need = |n: usize| values.len() >= n && items.len() > n;
        match kind.as_str() {
            "M" if need(2) => {
                current = Some(scaled(values[0], values[1]));
                start = current;
            }
            "L" if need(2) && current.is_some() => {
                let end = scaled(values[0], values[1]);
                shape.draw_line(current.expect("checked"), end).map_err(err)?;
                current = Some(end);
            }
            "Q" if need(4) && current.is_some() => {
                let from = current.expect("checked");
                let control = scaled(values[0], values[1]);
                let end = scaled(values[2], values[3]);
                let c1 = Point::new(from.x + (control.x - from.x) * 2.0 / 3.0, from.y + (control.y - from.y) * 2.0 / 3.0);
                let c2 = Point::new(end.x + (control.x - end.x) * 2.0 / 3.0, end.y + (control.y - end.y) * 2.0 / 3.0);
                shape.draw_bezier(from, c1, c2, end).map_err(err)?;
                current = Some(end);
            }
            "C" if need(6) && current.is_some() => {
                let end = scaled(values[4], values[5]);
                shape
                    .draw_bezier(current.expect("checked"), scaled(values[0], values[1]), scaled(values[2], values[3]), end)
                    .map_err(err)?;
                current = Some(end);
            }
            "Z" if current.is_some() && start.is_some() => {
                shape.draw_line(current.expect("checked"), start.expect("checked")).map_err(err)?;
                current = start;
            }
            _ => {}
        }
    }

    if current.is_some() {
        let opacity = f(item.opacity, 1.0).clamp(0.0, 1.0) as f32;
        let options = FinishOptions {
            color: Some(rgb(item.stroke_color.as_deref())?),
            width: (f(item.stroke_width, 0.0) * scale.mean()) as f32,
            line_cap: Some(1),
            line_join: Some(1),
            stroke_opacity: Some(opacity),
            close_path: false,
            ..Default::default()
        };
        shape.finish(&options).map_err(err)?;
    }
    Ok(())
}

/// The simple shapes of older payloads: a rectangle, an ellipse or a line,
/// without rotation.
pub fn draw_legacy(shape: &mut Shape<'_>, item: &NativeObject<'_>, scale: Scale) -> DrawResult {
    let x = f(item.x, 0.0) * scale.x;
    let y = f(item.y, 0.0) * scale.y;
    let width = f(item.width, 0.0) * scale.x;
    let height = f(item.height, 0.0) * scale.y;
    let stroke_w = f(item.stroke_width, 0.0) * scale.mean();
    let stroke = rgb(item.stroke_color.as_deref())?;
    let fill = rgb(item.fill_color.as_deref())?;
    let fill_opacity = f(item.fill_opacity, 100.0) / 100.0;
    let rect = Rect::new(x as f32, y as f32, (x + width) as f32, (y + height) as f32);
    let paint = FinishOptions {
        color: (stroke_w > 0.0).then_some(stroke.clone()),
        fill: (fill_opacity > 0.0).then_some(fill),
        width: stroke_w as f32,
        fill_opacity: Some(fill_opacity.clamp(0.0, 1.0) as f32),
        ..Default::default()
    };
    match item.kind.as_deref() {
        Some("rect") => {
            shape.draw_rect(&rect).map_err(err)?;
            shape.finish(&paint).map_err(err)?;
        }
        Some("circle") => {
            shape.draw_oval(rect).map_err(err)?;
            shape.finish(&paint).map_err(err)?;
        }
        Some("line") => {
            let points = match &item.points {
                Some(values) => numbers(values).filter(|n| n.len() >= 4).ok_or_else(|| "a line needs four coordinates".to_string())?,
                None => vec![0.0; 4],
            };
            shape
                .draw_line(pt(points[0] * scale.x, points[1] * scale.y), pt(points[2] * scale.x, points[3] * scale.y))
                .map_err(err)?;
            shape
                .finish(&FinishOptions { color: Some(stroke), width: stroke_w as f32, close_path: false, ..Default::default() })
                .map_err(err)?;
        }
        _ => {}
    }
    Ok(())
}
