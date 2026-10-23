//! Image objects and the raster overlay.
//!
//! An image object is placed with the four corners the editor reports for it
//! (upper left, upper right, lower right, lower left, in canvas units): the
//! picture's unit square is mapped onto that parallelogram, so any angle is
//! exact, not only quarter turns. JPEG and PNG files with no orientation tag
//! are embedded as they are; anything else is decoded, turned upright and
//! stored as PNG. Opacity is a graphics-state alpha, so it never costs the
//! original bytes.

use std::collections::HashMap;
use std::io::Cursor;

use base64::alphabet;
use base64::engine::{general_purpose, DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use mupdf::pdf::{InsertImageOptions, PageImageSource, PdfDocument, PdfPage};
use mupdf::{Matrix, Point, Rect};

use super::model::NativeObject;
use super::shapes::{err, pt, Scale};

/// A picture above this many pixels is refused, not decoded.
const MAX_IMAGE_PIXELS: u64 = 400_000_000;

/// Pictures already stored in the document, so one used twice is stored once.
#[derive(Default)]
pub struct ImageStore {
    xrefs: HashMap<String, i32>,
}

/// Strict base64, with or without a `data:...;base64,` prefix.
pub fn decode_image_data(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.is_empty() {
        return Err("Image object has no image data.".into());
    }
    let payload = match encoded.strip_prefix("data:").and_then(|_| encoded.split_once(',')) {
        Some((_, rest)) => rest,
        None => encoded,
    };
    general_purpose::STANDARD.decode(payload).map_err(|_| "Image data is not valid base64.".to_string())
}

/// Base64 that skips anything outside the alphabet and does not insist on
/// padding, like Python's `b64decode` without `validate`. Used for the raster
/// overlay, which older versions sent loosely.
pub fn decode_lenient(encoded: &str) -> Result<Vec<u8>, String> {
    let payload = encoded.split_once(',').map_or(encoded, |(_, rest)| rest);
    let cleaned: String = payload
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/'))
        .collect();
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
    );
    engine.decode(cleaned.trim_end_matches('=')).map_err(|_| "Image data is not valid base64.".to_string())
}

/// Bytes the PDF library can embed: the original when it is a JPEG or PNG
/// without an orientation tag, otherwise an upright PNG.
pub fn prepare_image_stream(raw: Vec<u8>) -> Result<Vec<u8>, String> {
    let undecodable = || "Image data could not be decoded.".to_string();
    let format = image::guess_format(&raw).map_err(|_| undecodable())?;
    let (w, h, orientation) = {
        let mut decoder = ImageReader::with_format(Cursor::new(&raw[..]), format).into_decoder().map_err(|_| undecodable())?;
        let (w, h) = decoder.dimensions();
        (w, h, decoder.orientation().unwrap_or(Orientation::NoTransforms))
    };
    if w as u64 * h as u64 > MAX_IMAGE_PIXELS {
        return Err(format!("Image of {w} x {h} pixels is too large."));
    }
    if matches!(format, ImageFormat::Jpeg | ImageFormat::Png) && orientation == Orientation::NoTransforms {
        return Ok(raw);
    }
    let mut decoder = ImageReader::with_format(Cursor::new(&raw[..]), format).into_decoder().map_err(|_| undecodable())?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(w as u64 * h as u64 * 16 + (64 << 20));
    decoder.set_limits(limits).map_err(|_| undecodable())?;
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(|_| undecodable())?;
    decoded.apply_orientation(orientation);
    let decoded = match decoded {
        DynamicImage::ImageLuma8(_) | DynamicImage::ImageLumaA8(_) | DynamicImage::ImageRgb8(_) | DynamicImage::ImageRgba8(_) => decoded,
        other if other.color().has_alpha() => DynamicImage::ImageRgba8(other.to_rgba8()),
        other => DynamicImage::ImageRgb8(other.to_rgb8()),
    };
    let mut out = Vec::new();
    decoded.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).map_err(|e| format!("Image could not be re-encoded: {e}"))?;
    Ok(out)
}

/// Pixel size of an image without decoding it.
pub fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?.into_dimensions().ok()
}

/// Corners in page units, ordered upper left, upper right, lower right, lower left.
pub fn image_corners(item: &NativeObject<'_>, scale: Scale) -> Result<[Point; 4], String> {
    if let Some(corners) = super::shapes::corners_of(item, scale)? {
        return Ok(corners);
    }
    let x = item.x.unwrap_or(0.0);
    let y = item.y.unwrap_or(0.0);
    let width = item.width.unwrap_or(0.0);
    let height = item.height.unwrap_or(0.0);
    let angle = item.angle.unwrap_or(0.0).to_radians();
    let (sin, cos) = angle.sin_cos();
    let local = [(0.0, 0.0), (width, 0.0), (width, height), (0.0, height)];
    Ok(local.map(|(px, py)| pt((x + px * cos - py * sin) * scale.x, (y + px * sin + py * cos) * scale.y)))
}

/// Corners of `target` with the picture fitted inside, centred, keeping its
/// proportions.
pub fn fitted_corners(target: Rect, picture: (u32, u32)) -> [Point; 4] {
    let (pw, ph) = (picture.0 as f32, picture.1 as f32);
    let (tw, th) = (target.x1 - target.x0, target.y1 - target.y0);
    let k = (tw / pw).min(th / ph);
    let (w, h) = (pw * k, ph * k);
    let x0 = target.x0 + (tw - w) / 2.0;
    let y0 = target.y0 + (th - h) / 2.0;
    [Point::new(x0, y0), Point::new(x0 + w, y0), Point::new(x0 + w, y0 + h), Point::new(x0, y0 + h)]
}

fn number(v: f32) -> String {
    let text = format!("{v:.6}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text.is_empty() || text == "-" || text == "-0" { "0".into() } else { text.to_string() }
}

/// Draws the picture on `page` inside `corners` (page units). The caller has
/// already put everything drawn so far on the page.
pub fn place_image(
    doc: &mut PdfDocument,
    page: &mut PdfPage,
    store: &mut ImageStore,
    key: &str,
    bytes: &[u8],
    corners: &[Point; 4],
    opacity: f32,
) -> Result<(), String> {
    let (tl, tr, bl) = (corners[0], corners[1], corners[3]);
    let ctm = page.ctm().map_err(err)?;
    let ipctm = ctm.invert().ok_or_else(|| "the page transform cannot be inverted".to_string())?;
    // Unit square (picture bottom-left origin) onto the corners, then into the
    // page's own PDF space.
    let onto = Matrix::new(tr.x - tl.x, tr.y - tl.y, tl.x - bl.x, tl.y - bl.y, bl.x, bl.y);
    let m = onto * ipctm;

    page.insert_contents(
        doc,
        format!("q\n{} {} {} {} {} {} cm\n", number(m.a), number(m.b), number(m.c), number(m.d), number(m.e), number(m.f)).as_bytes(),
        true,
    )
    .map_err(err)?;
    let options = InsertImageOptions { overlay: true, opacity: (opacity < 1.0).then_some(opacity), optional_content: None };
    let unit = Rect::new(0.0, 0.0, 1.0, 1.0);
    let placed = match store.xrefs.get(key) {
        Some(xref) => page.insert_image(doc, unit, PageImageSource::ExistingXref(*xref), options),
        None => page.insert_image(doc, unit, PageImageSource::Bytes { data: bytes, format_hint: None }, options),
    }
    .map_err(err)?;
    store.xrefs.entry(key.to_string()).or_insert(placed.xref);
    page.insert_contents(doc, b"Q\n", true).map_err(err)?;
    Ok(())
}

/// A key that is the same for the same bytes, so one picture used twice is
/// stored once.
pub fn content_key(raw: &[u8]) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in raw {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{}:{hash:016x}", raw.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_images_are_refused() {
        assert!(prepare_image_stream(b"not an image".to_vec()).is_err());
    }

    #[test]
    fn corners_without_the_editors_own_follow_its_clockwise_turn() {
        let item: NativeObject<'_> = serde_json::from_str(r#"{"x": 10, "y": 20, "width": 30, "height": 40, "angle": 90}"#).unwrap();
        let corners = image_corners(&item, Scale { x: 1.0, y: 1.0 }).unwrap();
        let rounded: Vec<(f32, f32)> = corners.iter().map(|p| ((p.x * 1e4).round() / 1e4, (p.y * 1e4).round() / 1e4)).collect();
        assert_eq!(rounded, vec![(10.0, 20.0), (10.0, 50.0), (-30.0, 50.0), (-30.0, 20.0)]);
    }
}
