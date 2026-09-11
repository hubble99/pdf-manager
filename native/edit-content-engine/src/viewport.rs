use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub left: f32,
    pub bottom: f32,
    pub right: f32,
    pub top: f32,
}

impl Rect {
    pub fn width(self) -> f32 {
        self.right - self.left
    }

    pub fn height(self) -> f32 {
        self.top - self.bottom
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quad {
    pub points: [Point; 4],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PageRotation {
    #[serde(rename = "0")]
    None,
    #[serde(rename = "90")]
    Clockwise90,
    #[serde(rename = "180")]
    Clockwise180,
    #[serde(rename = "270")]
    Clockwise270,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportTransform {
    pub crop_box: Rect,
    pub rotation: PageRotation,
    pub zoom: f32,
    pub device_pixel_ratio: f32,
    pub scroll_css: Point,
    pub viewport_origin_css: Point,
    pub viewport_size_css: Point,
}

impl ViewportTransform {
    pub fn validate(self) -> Result<Self, &'static str> {
        if self.crop_box.width() <= 0.0
            || self.crop_box.height() <= 0.0
            || self.zoom <= 0.0
            || self.device_pixel_ratio <= 0.0
            || self.viewport_size_css.x <= 0.0
            || self.viewport_size_css.y <= 0.0
        {
            return Err("invalid viewport transform");
        }
        Ok(self)
    }

    fn rotated_size(self) -> Point {
        match self.rotation {
            PageRotation::None | PageRotation::Clockwise180 => Point {
                x: self.crop_box.width(),
                y: self.crop_box.height(),
            },
            PageRotation::Clockwise90 | PageRotation::Clockwise270 => Point {
                x: self.crop_box.height(),
                y: self.crop_box.width(),
            },
        }
    }

    fn scale(self) -> f32 {
        let rotated = self.rotated_size();
        (self.viewport_size_css.x / rotated.x).min(self.viewport_size_css.y / rotated.y) * self.zoom
    }

    pub fn pdf_to_viewport_css(self, point: Point) -> Result<Point, &'static str> {
        let transform = self.validate()?;
        let x = point.x - transform.crop_box.left;
        let y = point.y - transform.crop_box.bottom;
        let width = transform.crop_box.width();
        let height = transform.crop_box.height();
        let rotated = match transform.rotation {
            PageRotation::None => Point { x, y: height - y },
            PageRotation::Clockwise90 => Point { x: y, y: x },
            PageRotation::Clockwise180 => Point { x: width - x, y },
            PageRotation::Clockwise270 => Point {
                x: height - y,
                y: width - x,
            },
        };
        let scale = transform.scale();
        Ok(Point {
            x: transform.viewport_origin_css.x + rotated.x * scale - transform.scroll_css.x,
            y: transform.viewport_origin_css.y + rotated.y * scale - transform.scroll_css.y,
        })
    }

    pub fn viewport_css_to_pdf(self, point: Point) -> Result<Point, &'static str> {
        let transform = self.validate()?;
        let scale = transform.scale();
        let rotated = Point {
            x: (point.x - transform.viewport_origin_css.x + transform.scroll_css.x) / scale,
            y: (point.y - transform.viewport_origin_css.y + transform.scroll_css.y) / scale,
        };
        let width = transform.crop_box.width();
        let height = transform.crop_box.height();
        let local = match transform.rotation {
            PageRotation::None => Point {
                x: rotated.x,
                y: height - rotated.y,
            },
            PageRotation::Clockwise90 => Point {
                x: rotated.y,
                y: rotated.x,
            },
            PageRotation::Clockwise180 => Point {
                x: width - rotated.x,
                y: rotated.y,
            },
            PageRotation::Clockwise270 => Point {
                x: width - rotated.y,
                y: height - rotated.x,
            },
        };
        Ok(Point {
            x: local.x + transform.crop_box.left,
            y: local.y + transform.crop_box.bottom,
        })
    }

    pub fn viewport_css_to_device(self, point: Point) -> Result<Point, &'static str> {
        let transform = self.validate()?;
        Ok(Point {
            x: point.x * transform.device_pixel_ratio,
            y: point.y * transform.device_pixel_ratio,
        })
    }

    pub fn project_quad(self, quad: Quad) -> Result<Quad, &'static str> {
        let mut points = quad.points;
        for point in &mut points {
            *point = self.pdf_to_viewport_css(*point)?;
        }
        Ok(Quad { points })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transform(rotation: PageRotation) -> ViewportTransform {
        ViewportTransform {
            crop_box: Rect {
                left: 20.0,
                bottom: 30.0,
                right: 420.0,
                top: 230.0,
            },
            rotation,
            zoom: 1.75,
            device_pixel_ratio: 2.0,
            scroll_css: Point { x: 17.0, y: 31.0 },
            viewport_origin_css: Point { x: 5.0, y: 9.0 },
            viewport_size_css: Point { x: 900.0, y: 700.0 },
        }
    }

    fn close(left: Point, right: Point) {
        assert!((left.x - right.x).abs() < 0.001, "x: {left:?} != {right:?}");
        assert!((left.y - right.y).abs() < 0.001, "y: {left:?} != {right:?}");
    }

    #[test]
    fn round_trips_crop_rotation_zoom_scroll_and_dpr() {
        let corners = [
            Point { x: 20.0, y: 30.0 },
            Point { x: 420.0, y: 30.0 },
            Point { x: 420.0, y: 230.0 },
            Point { x: 20.0, y: 230.0 },
            Point { x: 137.25, y: 88.5 },
        ];
        for rotation in [
            PageRotation::None,
            PageRotation::Clockwise90,
            PageRotation::Clockwise180,
            PageRotation::Clockwise270,
        ] {
            let transform = transform(rotation);
            for corner in corners {
                let css = transform.pdf_to_viewport_css(corner).unwrap();
                let device = transform.viewport_css_to_device(css).unwrap();
                close(
                    Point {
                        x: device.x / transform.device_pixel_ratio,
                        y: device.y / transform.device_pixel_ratio,
                    },
                    css,
                );
                close(transform.viewport_css_to_pdf(css).unwrap(), corner);
            }
        }
    }

    #[test]
    fn resize_recomputes_scale_without_changing_pdf_location() {
        let point = Point { x: 211.0, y: 97.0 };
        let before = transform(PageRotation::Clockwise90);
        let mut after = before;
        after.viewport_size_css = Point { x: 450.0, y: 350.0 };
        let before_css = before.pdf_to_viewport_css(point).unwrap();
        let after_css = after.pdf_to_viewport_css(point).unwrap();
        assert_ne!(before_css, after_css);
        close(after.viewport_css_to_pdf(after_css).unwrap(), point);
    }
}
