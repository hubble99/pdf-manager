//! QR codes as PNG or SVG.
//!
//! The matrix comes from the `qrcode` crate; the PNG and the SVG are written
//! here so the output is the same on every machine: modules are squares of
//! `size` pixels with a quiet border, like the Python version produced.

use qrcode::bits::Bits;
use qrcode::types::Version;
use qrcode::{Color, EcLevel, QrCode};

use super::code_image::{encode_gray_png, invalid};
pub use super::code_image::{Generated, OutputFormat};
use crate::error::{CoreError, CoreResult};

pub const MIN_SIZE: u32 = 1;
pub const MAX_SIZE: u32 = 20;
pub const MAX_BORDER: u32 = 50;
/// Quiet zone the QR standard asks for, in modules.
pub const DEFAULT_BORDER: u32 = 4;

/// Generates a QR code for `content`.
///
/// `size` is the width of one module in pixels (1 to 20, PNG only), `level`
/// the error correction (L, M, Q or H), `format` `png` or `svg`, `border` the
/// quiet zone in modules. The smallest version that fits is used.
pub fn generate(
    content: &str,
    size: u32,
    level: &str,
    format: &str,
    border: u32,
) -> CoreResult<Generated> {
    if content.trim().is_empty() {
        return Err(invalid("Content cannot be empty."));
    }
    let format = OutputFormat::parse(format)?;
    let ec = parse_level(level)?;
    if !(MIN_SIZE..=MAX_SIZE).contains(&size) {
        return Err(invalid(format!(
            "Size must be between {MIN_SIZE} and {MAX_SIZE}."
        )));
    }
    if border > MAX_BORDER {
        return Err(invalid(format!(
            "Border must be at most {MAX_BORDER} modules."
        )));
    }

    let code = build_code(content.as_bytes(), ec)?;
    let width = code.width();
    let dark: Vec<bool> = code
        .to_colors()
        .into_iter()
        .map(|c| c == Color::Dark)
        .collect();

    let bytes = match format {
        OutputFormat::Png => render_png(&dark, width, size as usize, border as usize)?,
        OutputFormat::Svg => render_svg(&dark, width, border as usize).into_bytes(),
    };
    Ok(Generated {
        bytes,
        mime: format.mime(),
    })
}

fn parse_level(level: &str) -> CoreResult<EcLevel> {
    match level.to_ascii_uppercase().as_str() {
        "L" => Ok(EcLevel::L),
        "M" => Ok(EcLevel::M),
        "Q" => Ok(EcLevel::Q),
        "H" => Ok(EcLevel::H),
        _ => Err(invalid(format!(
            "Unsupported error correction level: {level}"
        ))),
    }
}

fn too_long() -> CoreError {
    invalid("Content is too long for a QR code.")
}

/// Smallest version that holds `data`.
///
/// Text that is plain ASCII goes through the crate's segment optimiser. Anything
/// else is stored as one byte-mode segment: the optimiser would read UTF-8
/// bytes as Shift JIS pairs and pick Kanji mode, which scanners then show as
/// garbage.
fn build_code(data: &[u8], ec: EcLevel) -> CoreResult<QrCode> {
    if data.is_ascii() {
        return QrCode::with_error_correction_level(data, ec).map_err(|_| too_long());
    }
    for number in 1..=40 {
        let mut bits = Bits::new(Version::Normal(number));
        if bits.push_byte_data(data).is_err() || bits.push_terminator(ec).is_err() {
            continue;
        }
        if let Ok(code) = QrCode::with_bits(bits, ec) {
            return Ok(code);
        }
    }
    Err(too_long())
}

/// 1-bit grayscale PNG, `size` pixels per module.
fn render_png(dark: &[bool], width: usize, size: usize, border: usize) -> CoreResult<Vec<u8>> {
    let side = (width + 2 * border) * size;
    let row_bytes = side.div_ceil(8);
    // 1 = white. Start from an all-white image and clear the dark modules.
    let mut data = vec![0xFF_u8; row_bytes * side];
    for (row, modules) in dark.chunks(width).enumerate() {
        let first = (border + row) * size;
        for (col, _) in modules.iter().enumerate().filter(|(_, d)| **d) {
            let x0 = (border + col) * size;
            for y in first..first + size {
                let base = y * row_bytes;
                for x in x0..x0 + size {
                    data[base + x / 8] &= !(0x80 >> (x % 8));
                }
            }
        }
    }
    encode_gray_png(side as u32, side as u32, png::BitDepth::One, &data)
}

/// SVG with one unit per module (shown at 1 mm per module), plain `rect`
/// elements, one per horizontal run of dark modules. No namespace prefixes, so
/// it renders in an `<img>` tag as it is.
fn render_svg(dark: &[bool], width: usize, border: usize) -> String {
    let side = width + 2 * border;
    let mut svg = String::new();
    svg.push_str(&format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" width=\"{side}mm\" height=\"{side}mm\" viewBox=\"0 0 {side} {side}\" shape-rendering=\"crispEdges\">\n"
    ));
    svg.push_str(&format!(
        "<rect width=\"{side}\" height=\"{side}\" fill=\"#ffffff\"/>\n"
    ));
    for (row, modules) in dark.chunks(width).enumerate() {
        let mut col = 0;
        while col < width {
            if !modules[col] {
                col += 1;
                continue;
            }
            let start = col;
            while col < width && modules[col] {
                col += 1;
            }
            svg.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"1\" fill=\"#000000\"/>\n",
                border + start,
                border + row,
                col - start
            ));
        }
    }
    svg.push_str("</svg>\n");
    svg
}
