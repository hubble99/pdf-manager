//! What one PDF page looks like after reading, before any layout decisions.
//!
//! Coordinates are PDF points (1/72 inch) with the origin at the top-left of
//! the page and y growing downwards, the same as MuPDF's structured text.

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl Rect {
    pub const fn new(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
        Self { x0, y0, x1, y1 }
    }

    pub fn width(&self) -> f32 {
        self.x1 - self.x0
    }

    pub fn height(&self) -> f32 {
        self.y1 - self.y0
    }

    pub fn area(&self) -> f32 {
        self.width().max(0.0) * self.height().max(0.0)
    }

    pub fn cx(&self) -> f32 {
        (self.x0 + self.x1) / 2.0
    }

    pub fn cy(&self) -> f32 {
        (self.y0 + self.y1) / 2.0
    }

    pub fn union(&self, o: &Rect) -> Rect {
        Rect::new(self.x0.min(o.x0), self.y0.min(o.y0), self.x1.max(o.x1), self.y1.max(o.y1))
    }

    pub fn contains_point(&self, x: f32, y: f32, tol: f32) -> bool {
        x >= self.x0 - tol && x <= self.x1 + tol && y >= self.y0 - tol && y <= self.y1 + tol
    }

    pub fn overlap_x(&self, o: &Rect) -> f32 {
        (self.x1.min(o.x1) - self.x0.max(o.x0)).max(0.0)
    }


    pub fn is_empty(&self) -> bool {
        !(self.x1 > self.x0 && self.y1 > self.y0)
    }
}

/// Character formatting. `font` indexes [`PageModel::fonts`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Style {
    pub font: u16,
    pub size: f32,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    /// 0xRRGGBB.
    pub color: u32,
}

impl Style {
    /// Same look in Word. Sizes are compared at Word's half-point precision.
    pub fn same_run(&self, o: &Style) -> bool {
        self.font == o.font
            && half_points(self.size) == half_points(o.size)
            && self.bold == o.bold
            && self.italic == o.italic
            && self.underline == o.underline
            && self.strike == o.strike
            && self.color == o.color
    }
}

pub fn half_points(size: f32) -> u32 {
    (size * 2.0).round().max(2.0) as u32
}

#[derive(Clone, Debug, PartialEq)]
pub struct Glyph {
    pub ch: char,
    pub x0: f32,
    pub x1: f32,
    pub style: Style,
}

/// One line of text as MuPDF found it. MuPDF splits a visual line where there
/// is a wide gap, so table cells on the same row arrive as separate lines.
#[derive(Clone, Debug, PartialEq)]
pub struct TextLine {
    pub bbox: Rect,
    pub baseline: f32,
    pub glyphs: Vec<Glyph>,
    /// MuPDF text block the line came from; lines of one block usually belong
    /// to one paragraph or one table row.
    pub block: u32,
}

impl TextLine {
    pub fn text(&self) -> String {
        self.glyphs.iter().map(|g| g.ch).collect()
    }

    /// Font size used by most characters of the line.
    pub fn main_size(&self) -> f32 {
        dominant(self.glyphs.iter().filter(|g| !g.ch.is_whitespace()).map(|g| g.style.size))
            .unwrap_or_else(|| self.bbox.height().max(1.0))
    }

    pub fn main_style(&self) -> Option<Style> {
        let mut best: Option<(Style, usize)> = None;
        let mut counts: Vec<(Style, usize)> = Vec::new();
        for g in self.glyphs.iter().filter(|g| !g.ch.is_whitespace()) {
            match counts.iter_mut().find(|(s, _)| s.same_run(&g.style)) {
                Some((_, n)) => *n += 1,
                None => counts.push((g.style, 1)),
            }
        }
        for (s, n) in counts {
            if best.map_or(true, |(_, b)| n > b) {
                best = Some((s, n));
            }
        }
        best.map(|(s, _)| s)
    }

    pub fn is_blank(&self) -> bool {
        self.glyphs.iter().all(|g| g.ch.is_whitespace())
    }
}

/// The value seen most often, at half-point precision.
pub fn dominant(values: impl Iterator<Item = f32>) -> Option<f32> {
    let mut counts: Vec<(u32, usize)> = Vec::new();
    for v in values {
        let k = half_points(v);
        match counts.iter_mut().find(|(c, _)| *c == k) {
            Some((_, n)) => *n += 1,
            None => counts.push((k, 1)),
        }
    }
    counts.into_iter().max_by_key(|&(k, n)| (n, k)).map(|(k, _)| k as f32 / 2.0)
}

/// An image already encoded in a format Word can show.
#[derive(Clone, Debug, PartialEq)]
pub struct EncodedImage {
    pub bytes: Vec<u8>,
    /// `"png"` or `"jpeg"`.
    pub ext: &'static str,
    pub px_width: u32,
    pub px_height: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PageImage {
    pub bbox: Rect,
    pub image: EncodedImage,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PageModel {
    pub width: f32,
    pub height: f32,
    /// PDF font names as found (subset prefix still on).
    pub fonts: Vec<String>,
    pub lines: Vec<TextLine>,
    pub images: Vec<PageImage>,
    /// Bounding boxes of vector graphics (lines, rectangles). Thin ones are
    /// table borders, underlines and separators.
    pub rules: Vec<Rect>,
    /// Text drawn invisibly, as an OCR layer over a scan is.
    pub has_invisible_text: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dominant_prefers_most_common() {
        assert_eq!(dominant([10.0, 10.1, 12.0, 10.0].into_iter()), Some(10.0));
        assert_eq!(dominant(std::iter::empty()), None);
    }

    #[test]
    fn rect_helpers() {
        let a = Rect::new(0.0, 0.0, 10.0, 10.0);
        let b = Rect::new(5.0, 8.0, 20.0, 30.0);
        assert_eq!(a.overlap_x(&b), 5.0);
        assert_eq!(a.union(&b), Rect::new(0.0, 0.0, 20.0, 30.0));
    }
}
