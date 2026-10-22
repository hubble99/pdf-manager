//! What the QR and barcode generators return, and the PNG writer they share.

use crate::error::{CoreError, CoreResult};

/// An image ready to show or save.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generated {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Png,
    Svg,
}

impl OutputFormat {
    /// `png` or `svg`, in any case.
    pub fn parse(name: &str) -> CoreResult<Self> {
        match name.to_ascii_lowercase().as_str() {
            "png" => Ok(Self::Png),
            "svg" => Ok(Self::Svg),
            _ => Err(invalid(format!("Unsupported format: {name}"))),
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Svg => "image/svg+xml",
        }
    }
}

pub(crate) fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::InvalidInput(message.into())
}

/// Encodes `data` (`height` rows of `width` samples, row after row, 1-bit
/// rows padded to whole bytes) as a PNG.
pub(crate) fn encode_gray_png(
    width: u32,
    height: u32,
    depth: png::BitDepth,
    data: &[u8],
) -> CoreResult<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Grayscale);
    encoder.set_depth(depth);
    let mut writer = encoder
        .write_header()
        .map_err(|e| CoreError::Internal(format!("PNG header: {e}")))?;
    writer
        .write_image_data(data)
        .map_err(|e| CoreError::Internal(format!("PNG data: {e}")))?;
    writer
        .finish()
        .map_err(|e| CoreError::Internal(format!("PNG finish: {e}")))?;
    Ok(out)
}

/// Escapes text for an SVG text node.
pub(crate) fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}
