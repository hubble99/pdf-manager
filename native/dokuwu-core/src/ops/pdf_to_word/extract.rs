//! Reads one PDF page with MuPDF into a [`PageModel`].
//!
//! MuPDF's structured text gives every character with its font, size, colour
//! and position, image blocks with their placement, and the outlines of vector
//! graphics. Images are re-drawn into RGB(A) pixels here and encoded as PNG or
//! JPEG, because PDF image data (Flate, CMYK, JPX, masks) is often something
//! Word cannot show as is.

use mupdf::text_page::{TextBlockType, TextCharFlags};
use mupdf::{ColorParams, Colorspace, Device, Image, Matrix, Page, Pixmap, TextPageFlags};

use super::model::{EncodedImage, Glyph, PageImage, PageModel, Rect, Style, TextLine};
use crate::error::{CoreError, CoreResult};

/// Images are kept at most this sharp (pixels per inch at their size on the
/// page) and this large, so one huge scan cannot exhaust memory.
const MAX_IMAGE_DPI: f32 = 300.0;
const MAX_IMAGE_SIDE: f32 = 4000.0;

pub fn mupdf_error(context: &str, err: mupdf::Error) -> CoreError {
    CoreError::Internal(format!("{context}: {err}"))
}

pub fn read_page(page: &Page) -> CoreResult<PageModel> {
    let bounds = page.bounds().map_err(|e| mupdf_error("page bounds", e))?;
    let (ox, oy) = (bounds.x0, bounds.y0);
    let mut model = PageModel {
        width: bounds.x1 - bounds.x0,
        height: bounds.y1 - bounds.y0,
        ..PageModel::default()
    };
    let flags = TextPageFlags::PRESERVE_IMAGES | TextPageFlags::COLLECT_VECTORS;
    let text_page = page.to_text_page(flags).map_err(|e| mupdf_error("reading page text", e))?;

    for (block_index, block) in text_page.blocks().enumerate() {
        let r = block.bounds();
        let bbox = Rect::new(r.x0 - ox, r.y0 - oy, r.x1 - ox, r.y1 - oy);
        match block.r#type() {
            TextBlockType::Text => {
                for line in block.lines() {
                    if let Some(l) = read_line(&mut model, &line, block_index as u32, ox, oy) {
                        model.lines.push(l);
                    }
                }
            }
            TextBlockType::Image => {
                let (Some(image), Some(ctm)) = (block.image(), block.ctm()) else { continue };
                let visible = clip(bbox, model.width, model.height);
                if visible.width() < 1.0 || visible.height() < 1.0 {
                    continue;
                }
                // An image that cannot be decoded is left out rather than failing the page.
                if let Ok(Some(encoded)) = encode_image(&image, &ctm, bbox, ox, oy) {
                    model.images.push(PageImage { bbox, image: encoded });
                }
            }
            TextBlockType::Vector => {
                if !bbox.is_empty() || bbox.width() > 0.0 || bbox.height() > 0.0 {
                    model.rules.push(bbox);
                }
            }
            _ => {}
        }
    }
    Ok(model)
}

fn clip(r: Rect, w: f32, h: f32) -> Rect {
    Rect::new(r.x0.max(0.0), r.y0.max(0.0), r.x1.min(w), r.y1.min(h))
}

fn read_line(
    model: &mut PageModel,
    line: &mupdf::text_page::TextLine<'_>,
    block: u32,
    ox: f32,
    oy: f32,
) -> Option<TextLine> {
    let b = line.bounds();
    let mut glyphs = Vec::new();
    let mut baseline = None;
    for ch in line.chars() {
        let Some(c) = ch.char() else { continue };
        let flags = ch.flags();
        if !flags.intersects(TextCharFlags::FILLED | TextCharFlags::STROKED) && !c.is_whitespace() {
            model.has_invisible_text = true;
        }
        let q = ch.quad();
        let x0 = q.ul.x.min(q.ll.x) - ox;
        let x1 = q.ur.x.max(q.lr.x) - ox;
        if baseline.is_none() && !c.is_whitespace() {
            baseline = Some(ch.origin().y - oy);
        }
        let (font_name, font_bold, font_italic) = match ch.font() {
            Some(f) => (f.name().to_owned(), f.is_bold(), f.is_italic()),
            None => (String::new(), false, false),
        };
        let lower = font_name.to_ascii_lowercase();
        let style = Style {
            font: font_index(model, &font_name),
            size: ch.size(),
            bold: font_bold || flags.contains(TextCharFlags::BOLD) || lower.contains("bold") || lower.contains("black") || lower.contains("heavy"),
            italic: font_italic || lower.contains("italic") || lower.contains("oblique"),
            underline: flags.contains(TextCharFlags::UNDERLINE),
            strike: flags.contains(TextCharFlags::STRIKEOUT),
            color: ch.argb() & 0x00ff_ffff,
        };
        glyphs.push(Glyph { ch: c, x0, x1: x1.max(x0), style });
    }
    // Trailing spaces only shift alignment checks.
    while glyphs.last().is_some_and(|g| g.ch.is_whitespace()) {
        glyphs.pop();
    }
    if glyphs.is_empty() {
        return None;
    }
    let bbox = Rect::new(b.x0 - ox, b.y0 - oy, b.x1 - ox, b.y1 - oy);
    // Glyph extents are more exact than the line box, which includes
    // trailing whitespace and font bearings.
    let x0 = glyphs.iter().map(|g| g.x0).fold(f32::INFINITY, f32::min);
    let x1 = glyphs.iter().map(|g| g.x1).fold(f32::NEG_INFINITY, f32::max);
    let bbox = Rect::new(x0.max(bbox.x0 - 2.0), bbox.y0, x1.min(bbox.x1 + 2.0).max(x0), bbox.y1);
    Some(TextLine { bbox, baseline: baseline.unwrap_or(bbox.y1), glyphs, block })
}

fn font_index(model: &mut PageModel, name: &str) -> u16 {
    if let Some(i) = model.fonts.iter().position(|f| f == name) {
        return i as u16;
    }
    model.fonts.push(name.to_owned());
    (model.fonts.len() - 1).min(u16::MAX as usize) as u16
}

/// Draws the image as it appears on the page (rotation and flips included)
/// into an RGBA pixmap and encodes it. Returns `None` for an image too small
/// to matter.
fn encode_image(image: &Image, ctm: &Matrix, bbox: Rect, ox: f32, oy: f32) -> CoreResult<Option<EncodedImage>> {
    let disp_w = bbox.width();
    let disp_h = bbox.height();
    if disp_w < 1.0 || disp_h < 1.0 {
        return Ok(None);
    }
    // Pixels: the image's own resolution, capped by MAX_IMAGE_DPI at its
    // displayed size and by MAX_IMAGE_SIDE.
    let native = (image.width().max(image.height()) as f32).max(1.0);
    let wanted = (disp_w.max(disp_h) / 72.0 * MAX_IMAGE_DPI).min(native).min(MAX_IMAGE_SIDE).max(1.0);
    let scale = wanted / disp_w.max(disp_h);
    let pw = (disp_w * scale).round().max(1.0) as i32;
    let ph = (disp_h * scale).round().max(1.0) as i32;

    let mut pixmap = Pixmap::new_with_w_h(&Colorspace::device_rgb(), pw, ph, true)
        .map_err(|e| mupdf_error("image buffer", e))?;
    pixmap.clear().map_err(|e| mupdf_error("image buffer", e))?;
    {
        let sx = pw as f32 / disp_w;
        let sy = ph as f32 / disp_h;
        // Page placement, moved so the image's box starts at (0, 0), then scaled to the pixmap.
        let m = Matrix::new(
            ctm.a * sx,
            ctm.b * sy,
            ctm.c * sx,
            ctm.d * sy,
            (ctm.e - ox - bbox.x0) * sx,
            (ctm.f - oy - bbox.y0) * sy,
        );
        let device = Device::from_pixmap(&pixmap).map_err(|e| mupdf_error("image device", e))?;
        device
            .fill_image(image, &m, 1.0, ColorParams::default())
            .map_err(|e| mupdf_error("drawing image", e))?;
    }
    Ok(Some(encode_rgba(&pixmap)?))
}

fn encode_rgba(pixmap: &Pixmap) -> CoreResult<EncodedImage> {
    let w = pixmap.width();
    let h = pixmap.height();
    let n = pixmap.n() as usize;
    let stride = pixmap.stride() as usize;
    let samples = pixmap.samples();
    let mut rgba = Vec::with_capacity(w as usize * h as usize * 4);
    let mut opaque = true;
    for y in 0..h as usize {
        let row = &samples[y * stride..y * stride + w as usize * n];
        for px in row.chunks_exact(n) {
            let a = if n >= 4 { px[3] } else { 255 };
            // MuPDF pixmaps with alpha are premultiplied.
            let un = |c: u8| -> u8 {
                if a == 0 {
                    255
                } else if a == 255 {
                    c
                } else {
                    ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8
                }
            };
            rgba.extend_from_slice(&[un(px[0]), un(px[1]), un(px[2]), a]);
            opaque &= a == 255;
        }
    }
    let photo = opaque && looks_like_photo(&rgba);
    if photo {
        let rgb: Vec<u8> = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        let mut out = Vec::new();
        jpeg_encoder::Encoder::new(&mut out, 88)
            .encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
            .map_err(|e| CoreError::Internal(format!("jpeg encode: {e}")))?;
        return Ok(EncodedImage { bytes: out, ext: "jpeg", px_width: w, px_height: h });
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        let data: Vec<u8>;
        if opaque {
            enc.set_color(png::ColorType::Rgb);
            data = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        } else {
            enc.set_color(png::ColorType::Rgba);
            data = rgba;
        }
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Balanced);
        let mut writer = enc.write_header().map_err(|e| CoreError::Internal(format!("png encode: {e}")))?;
        writer.write_image_data(&data).map_err(|e| CoreError::Internal(format!("png encode: {e}")))?;
    }
    Ok(EncodedImage { bytes: out, ext: "png", px_width: w, px_height: h })
}

/// Many distinct colours means a photo, which JPEG stores far smaller than PNG.
/// Drawings, charts and screenshots have few colours and stay sharp as PNG.
fn looks_like_photo(rgba: &[u8]) -> bool {
    let pixels = rgba.len() / 4;
    if pixels < 64 * 64 {
        return false;
    }
    let step = (pixels / 20_000).max(1);
    let mut seen = std::collections::HashSet::new();
    for i in (0..pixels).step_by(step) {
        let p = &rgba[i * 4..i * 4 + 3];
        // Quantize a little so JPEG noise in the source does not count.
        seen.insert(((p[0] >> 3) as u32) << 10 | ((p[1] >> 3) as u32) << 5 | (p[2] >> 3) as u32);
        if seen.len() > 1500 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_colours_are_not_photos() {
        let rgba: Vec<u8> = (0..100 * 100).flat_map(|i| if i % 2 == 0 { [255, 0, 0, 255] } else { [0, 0, 255, 255] }).collect();
        assert!(!looks_like_photo(&rgba));
    }

    #[test]
    fn noisy_pixels_are_photos() {
        let mut x: u32 = 12345;
        let rgba: Vec<u8> = (0..200 * 200)
            .flat_map(|_| {
                x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
                let b = x.to_le_bytes();
                [b[1], b[2], b[3], 255]
            })
            .collect();
        assert!(looks_like_photo(&rgba));
    }
}
