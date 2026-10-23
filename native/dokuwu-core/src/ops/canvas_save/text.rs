//! Text objects: real, selectable text in the library font, with letter
//! spacing, alignment, rotation, opacity and the thin outline that stands in for
//! weights between two real faces.
//!
//! Each run (a line, or one grapheme cluster when letter spacing is on) is one
//! text operation positioned from the metrics of the font itself, so the PDF
//! shows what the editor measured.

use std::collections::HashMap;

use mupdf::shape::{PdfColor, Shape, TextOptions};
use mupdf::{Matrix, Point};
use unicode_normalization::char::canonical_combining_class;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use super::fonts::{load_font, FontSources, LoadedFont};
use super::model::{numbers, split_lines, value_f64, NativeObject};
use super::shapes::{err, pt, rgb, Scale};

/// What text drawing remembers across a document: which resource name each
/// embedded font got, so two different fonts never share one.
#[derive(Default)]
pub struct FontNames {
    by_font: HashMap<u64, String>,
    used: HashMap<String, u64>,
}

impl FontNames {
    fn name_for(&mut self, font_name: &str, data: &[u8]) -> String {
        let key = fnv(data);
        if let Some(name) = self.by_font.get(&key) {
            return name.clone();
        }
        let base: String = font_name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .to_string();
        let base = if base.is_empty() { "Font".to_string() } else { base };
        let mut name = base.clone();
        let mut n = 1;
        while self.used.get(&name).is_some_and(|owner| *owner != key) {
            n += 1;
            name = format!("{base}-{n}");
        }
        self.used.insert(name.clone(), key);
        self.by_font.insert(key, name.clone());
        name
    }
}

fn fnv(data: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in data {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Approximates Fabric's graphemes so letter spacing never splits a base letter
/// from its combining marks.
pub fn text_clusters(text: &str) -> Vec<String> {
    let mut clusters: Vec<String> = Vec::new();
    for c in text.chars() {
        let joins = clusters.last().is_some_and(|last| {
            canonical_combining_class(c) != 0
                || c.general_category_group() == GeneralCategoryGroup::Mark
                || c == '\u{200d}'
                || last.ends_with('\u{200d}')
        });
        if joins {
            clusters.last_mut().expect("checked").push(c);
        } else {
            clusters.push(c.to_string());
        }
    }
    clusters
}

/// Width of `text` set in `font` at `size`, from the glyph advances.
fn text_length(font: &mupdf::Font, text: &str, size: f64) -> f64 {
    let mut total = 0.0f64;
    for c in text.chars() {
        let glyph = font.encode_character(c as i32).unwrap_or(0);
        total += font.advance_glyph(glyph).unwrap_or(0.0) as f64;
    }
    total * size
}

fn first_weight(item: &NativeObject<'_>) -> Option<i32> {
    // `a or b` in the old code: a zero counts as not given.
    [item.font_face_weight, item.font_weight]
        .into_iter()
        .flatten()
        .find(|w| *w != 0.0)
        .map(|w| w as i32)
}

/// The matrix `pctm * (T(-p) * M * T(p)) * ipctm` that turns what a shape drew
/// by `matrix` about `fixpoint` (page coordinates).
fn morph_matrix(fixpoint: Point, matrix: &Matrix, pctm: &Matrix, ipctm: &Matrix) -> Matrix {
    let user = Matrix::new_translate(-fixpoint.x, -fixpoint.y) * matrix * Matrix::new_translate(fixpoint.x, fixpoint.y);
    pctm * user * ipctm
}

fn cm(m: &Matrix) -> String {
    format!("{} {} {} {} {} {} cm\n", g(m.a), g(m.b), g(m.c), g(m.d), g(m.e), g(m.f))
}

fn g(v: f32) -> String {
    let text = format!("{v:.6}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text.is_empty() || text == "-" || text == "-0" { "0".into() } else { text.to_string() }
}

/// Draws a text object into `shape`. When the object is turned, the returned
/// matrix has to be applied (`q <matrix> cm ... Q`) around what the shape
/// accumulated.
pub fn draw_text(
    shape: &mut Shape<'_>,
    item: &NativeObject<'_>,
    scale: Scale,
    sources: &FontSources<'_>,
    names: &mut FontNames,
    page_rotation: i32,
) -> Result<Option<Matrix>, String> {
    // An in-between weight is drawn with the nearest lighter real face plus a
    // thin outline; the frontend sends both the face and the outline amount.
    let synthetic_em = item.synthetic_stroke_em.unwrap_or(0.0).clamp(0.0, 0.1);
    let family = item.font_family.as_deref().unwrap_or("Arial");
    let loaded = load_font(sources, family, item.bold.unwrap_or(false), item.italic.unwrap_or(false), first_weight(item));
    let font_size = (item.font_size.unwrap_or(12.0) * scale.mean()).max(1.0);
    let letter_spacing = item.letter_spacing.unwrap_or(0.0).clamp(-100.0, 500.0);
    let tracking_gap = font_size * letter_spacing / 1000.0;
    let x = item.x.unwrap_or(0.0) * scale.x;
    let y = item.y.unwrap_or(0.0) * scale.y;
    let width = item.width.filter(|w| *w != 0.0).unwrap_or(0.0) * scale.x;

    let lines: Vec<String> = match &item.lines {
        Some(lines) if !lines.is_empty() => lines.clone(),
        _ => {
            let split: Vec<String> = split_lines(item.text.as_deref().unwrap_or("")).into_iter().map(String::from).collect();
            if split.is_empty() { vec![String::new()] } else { split }
        }
    };
    let line_widths: Vec<f64> = item
        .line_widths
        .as_deref()
        .map(|values| values.iter().filter_map(value_f64).collect())
        .unwrap_or_default();
    let align = item.text_align.as_deref().unwrap_or("left");
    let line_height = font_size * item.line_height.unwrap_or(1.16);
    let baseline = y + font_size * loaded.font.ascender() as f64;

    let mut operations: Vec<(Point, String)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let clusters = text_clusters(line);
        let line_width = match line_widths.get(index) {
            Some(w) => w * scale.x,
            None => text_length(&loaded.font, line, font_size) + tracking_gap * clusters.len().saturating_sub(1) as f64,
        };
        let offset = match align {
            "center" => ((width - line_width) / 2.0).max(0.0),
            "right" => (width - line_width).max(0.0),
            _ => 0.0,
        };
        let position_x = x + offset;
        let position_y = baseline + index as f64 * line_height;
        if letter_spacing == 0.0 || clusters.len() <= 1 {
            operations.push((pt(position_x, position_y), line.clone()));
        } else {
            let mut cursor = position_x;
            for cluster in clusters {
                let advance = text_length(&loaded.font, &cluster, font_size) + tracking_gap;
                operations.push((pt(cursor, position_y), cluster));
                cursor += advance;
            }
        }
    }

    let angle = match item.transform_matrix.as_deref().and_then(numbers).filter(|m| m.len() == 6) {
        Some(m) => m[1].atan2(m[0]).to_degrees(),
        None => item.angle.unwrap_or(0.0),
    };
    let opacity = item.opacity.unwrap_or(1.0).clamp(0.0, 1.0) as f32;
    let color = rgb(item.color.as_deref())?;

    let LoadedFont { font, data } = loaded;
    let font_name = match &data {
        Some(bytes) => names.name_for(font.name(), bytes),
        None => "helv".to_string(),
    };
    let mut options = TextOptions {
        fontsize: font_size as f32,
        fontname: font_name,
        fontfile: data.as_deref(),
        simple: data.is_none(),
        // The page turns the text with it; undo that so it reads upright.
        rotate: page_rotation.rem_euclid(360),
        ..Default::default()
    };
    if opacity < 1.0 {
        options.fill_opacity = Some(opacity);
        options.stroke_opacity = Some(opacity);
    }
    set_colors(&mut options, color, synthetic_em);
    for (position, text) in &operations {
        shape.insert_text(*position, text, &options).map_err(err)?;
    }

    if angle == 0.0 {
        return Ok(None);
    }
    let matrix = morph_matrix(pt(x, y), &Matrix::new_rotate(angle as f32), shape.pctm(), shape.ipctm());
    Ok(Some(matrix))
}

fn set_colors(options: &mut TextOptions<'_>, color: PdfColor, synthetic_em: f64) {
    if synthetic_em > 0.0 {
        // Fill and stroke the glyph outlines: real text, a little heavier.
        options.color = Some(color.clone());
        options.fill = Some(color);
        options.render_mode = 2;
        options.border_width = synthetic_em as f32;
    } else {
        options.fill = Some(color);
    }
}

/// `q <matrix> cm ... Q` around `content`.
pub fn wrap_with_matrix(matrix: &Matrix, content: &str) -> String {
    format!("q\n{}{content}Q\n", cm(matrix))
}
