//! Draws an [`Encoded`] barcode as PNG or SVG.
//!
//! Measurements follow `python-barcode`: bars 15 mm high, 1 mm margin above and
//! below, text 10 pt about 5 mm under the bars, PNG at 300 dpi.

use ab_glyph::{point, Font, FontRef, PxScale, ScaleFont};

use super::Encoded;
use crate::error::{CoreError, CoreResult};
use crate::ops::code_image::{encode_gray_png, xml_escape};

const BAR_HEIGHT_MM: f64 = 15.0;
const MARGIN_MM: f64 = 1.0;
const TEXT_DISTANCE_MM: f64 = 5.0;
const FONT_PT: f64 = 10.0;
const DPI: f64 = 300.0;

static FONT_BYTES: &[u8] = include_bytes!("../../../assets/fonts/DejaVuSansMono.ttf");

fn pt_to_mm(pt: f64) -> f64 {
    pt * 0.352_777_778
}

fn mm_to_px(mm: f64) -> f64 {
    mm * DPI / 25.4
}

fn width_mm(e: &Encoded) -> f64 {
    2.0 * e.quiet_mm + e.modules.len() as f64 * e.module_mm
}

fn height_mm() -> f64 {
    2.0 * MARGIN_MM + BAR_HEIGHT_MM + pt_to_mm(FONT_PT) / 2.0 + TEXT_DISTANCE_MM
}

/// Runs of bars as `(first module, module count)`.
fn bar_runs(modules: &[bool]) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut i = 0;
    while i < modules.len() {
        if modules[i] {
            let start = i;
            while i < modules.len() && modules[i] {
                i += 1;
            }
            runs.push((start, i - start));
        } else {
            i += 1;
        }
    }
    runs
}

/// 8-bit grayscale PNG, black on white.
pub(super) fn png(e: &Encoded) -> CoreResult<Vec<u8>> {
    let width = mm_to_px(width_mm(e)) as usize;
    let height = mm_to_px(height_mm()) as usize;
    let mut pixels = vec![255_u8; width * height];

    // Bar edges come from the running position, so neighbouring bars share an
    // edge and widths stay as even as the pixel grid allows.
    let top = mm_to_px(MARGIN_MM).round() as usize;
    let bottom = (mm_to_px(MARGIN_MM + BAR_HEIGHT_MM).round() as usize).min(height);
    for (start, count) in bar_runs(&e.modules) {
        let x0 = mm_to_px(e.quiet_mm + start as f64 * e.module_mm).round() as usize;
        let x1 = mm_to_px(e.quiet_mm + (start + count) as f64 * e.module_mm).round() as usize;
        for y in top..bottom {
            pixels[y * width + x0.min(width)..y * width + x1.min(width)].fill(0);
        }
    }

    draw_text(&mut pixels, width, height, e)?;
    encode_gray_png(width as u32, height as u32, png::BitDepth::Eight, &pixels)
}

/// Text centred under the bars, in DejaVu Sans Mono, so digits look the same on
/// every machine. `y` is the bottom of the descenders, like the Python output.
fn draw_text(pixels: &mut [u8], width: usize, height: usize, e: &Encoded) -> CoreResult<()> {
    let font = FontRef::try_from_slice(FONT_BYTES)
        .map_err(|err| CoreError::Internal(format!("barcode font: {err}")))?;
    // `PxScale` is the height from ascent to descent; the font size means the em.
    let em_px = mm_to_px(pt_to_mm(FONT_PT)).floor() as f32;
    let units = font.units_per_em().unwrap_or(2048.0);
    let scaled = font.as_scaled(PxScale::from(em_px * font.height_unscaled() / units));

    let text_width: f32 = e
        .text
        .chars()
        .map(|c| scaled.h_advance(scaled.glyph_id(c)))
        .sum();
    let center = mm_to_px(width_mm(e) / 2.0) as f32;
    let descender_y = mm_to_px(MARGIN_MM + BAR_HEIGHT_MM + TEXT_DISTANCE_MM) as f32;
    let baseline = descender_y + scaled.descent();

    let mut x = center - text_width / 2.0;
    for c in e.text.chars() {
        let id = scaled.glyph_id(c);
        let glyph = id.with_scale_and_position(scaled.scale(), point(x, baseline));
        if let Some(outline) = font.outline_glyph(glyph) {
            let bounds = outline.px_bounds();
            outline.draw(|gx, gy, coverage| {
                let px = bounds.min.x as i64 + i64::from(gx);
                let py = bounds.min.y as i64 + i64::from(gy);
                if (0..width as i64).contains(&px) && (0..height as i64).contains(&py) {
                    let at = py as usize * width + px as usize;
                    let ink = (coverage.clamp(0.0, 1.0) * 255.0) as u8;
                    pixels[at] = pixels[at].saturating_sub(ink);
                }
            });
        }
        x += scaled.h_advance(id);
    }
    Ok(())
}

/// SVG in millimetres with one `rect` per bar and the text as a `text` element.
pub(super) fn svg(e: &Encoded) -> String {
    let (w, h) = (width_mm(e), height_mm());
    // The viewBox is in millimetres, so the font size is too.
    let font_mm = pt_to_mm(FONT_PT);
    let mut out = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" width=\"{w:.3}mm\" height=\"{h:.3}mm\" viewBox=\"0 0 {w:.3} {h:.3}\">\n"
    );
    out.push_str("<rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>\n");
    for (start, count) in bar_runs(&e.modules) {
        out.push_str(&format!(
            "<rect x=\"{:.3}\" y=\"{:.3}\" width=\"{:.3}\" height=\"{:.3}\" fill=\"#000000\"/>\n",
            e.quiet_mm + start as f64 * e.module_mm,
            MARGIN_MM,
            count as f64 * e.module_mm,
            BAR_HEIGHT_MM
        ));
    }
    out.push_str(&format!(
        "<text x=\"{:.3}\" y=\"{:.3}\" fill=\"#000000\" font-family=\"DejaVu Sans Mono, Consolas, monospace\" font-size=\"{font_mm:.3}\" text-anchor=\"middle\">{}</text>\n",
        w / 2.0,
        MARGIN_MM + BAR_HEIGHT_MM + TEXT_DISTANCE_MM,
        xml_escape(&e.text)
    ));
    out.push_str("</svg>\n");
    out
}
