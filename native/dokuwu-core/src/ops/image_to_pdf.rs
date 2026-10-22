//! Images to one PDF, a page per image.
//!
//! Pictures are not re-encoded when they do not need to be: a JPEG goes into
//! the PDF byte for byte, and an 8-bit RGB or grey PNG reuses its compressed
//! data. Anything else (WEBP, BMP, TIFF, palette or 16-bit PNG, transparency) is
//! decoded and stored losslessly; transparent areas are flattened on white.
//! Rotation, mirroring and the camera's EXIF orientation are applied as the
//! page's placement matrix, not by touching pixels, so they cost nothing and
//! lose nothing.
//!
//! A few worker threads prepare images while the calling thread writes pages in
//! order with a streaming PDF writer, so memory holds only the images in
//! flight. An image that cannot be read is skipped and listed in the report.

use std::io::{BufWriter, Cursor, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageReader, Limits};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;
use crate::ops::naming::{create_part, sanitize_stem, PartGuard};
use crate::ops::ordered::run_ordered;
use crate::ops::pdf_writer::PdfWriter;
use crate::resources::{worker_count, MemoryBrake, MemoryProbe, SystemMemory, MIB};

/// Stage name used in progress reports.
pub const STAGE: &str = "images";

const MAX_WORKERS: usize = 3;
const PLANNED_BYTES_PER_WORKER: u64 = 384 * MIB;
const RESERVE_BYTES: u64 = 512 * MIB;
/// An image above this many pixels is refused rather than risking memory.
const MAX_PIXELS: u64 = 400_000_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub path: PathBuf,
    /// Clockwise quarter turns in degrees: 0, 90, 180 or 270.
    #[serde(default)]
    pub rotation: u16,
    /// Mirror left to right (before the rotation).
    #[serde(default)]
    pub flip_h: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageToPdfOptions {
    /// `a4`, `a3`, `a5`, `letter`, `legal`, `f4` or `match_image`.
    pub page_size: String,
    /// Folder the PDF is written to. Must exist.
    pub output_dir: PathBuf,
    /// Name without `.pdf`; blank means `output`.
    #[serde(default)]
    pub output_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedImage {
    pub source: PathBuf,
    pub error: SkipReason,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkipReason {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageToPdfReport {
    pub output_path: PathBuf,
    pub output_size_bytes: u64,
    pub pages: u32,
    pub page_size: String,
    pub skipped: Vec<SkippedImage>,
    pub duration_ms: u64,
}

/// Standard sheets in points, portrait.
fn sheet(name: &str) -> Option<(f64, f64)> {
    Some(match name {
        "a4" => (595.0, 842.0),
        "a3" => (842.0, 1191.0),
        "a5" => (148.0 * 72.0 / 25.4, 210.0 * 72.0 / 25.4),
        "letter" => (612.0, 792.0),
        "legal" => (612.0, 1008.0),
        // F4 is a regional size with several conventions; this one is 210 x 330 mm.
        "f4" => (210.0 * 72.0 / 25.4, 330.0 * 72.0 / 25.4),
        _ => return None,
    })
}

/// A placement of the image's unit square: `p = a*u + c*v + e`,
/// `q = b*u + d*v + f`, where (u, v) runs over the stored image with v = 1 at
/// the top row and (p, q) over the displayed picture.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Map {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl Map {
    const IDENTITY: Map = Map { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };
    const FLIP_H: Map = Map { a: -1.0, b: 0.0, c: 0.0, d: 1.0, e: 1.0, f: 0.0 };
    const FLIP_V: Map = Map { a: 1.0, b: 0.0, c: 0.0, d: -1.0, e: 0.0, f: 1.0 };
    const TURN_CW: Map = Map { a: 0.0, b: -1.0, c: 1.0, d: 0.0, e: 0.0, f: 1.0 };

    /// This transform, then `next`.
    fn then(self, n: Map) -> Map {
        Map {
            a: n.a * self.a + n.c * self.b,
            b: n.b * self.a + n.d * self.b,
            c: n.a * self.c + n.c * self.d,
            d: n.b * self.c + n.d * self.d,
            e: n.a * self.e + n.c * self.f + n.e,
            f: n.b * self.e + n.d * self.f + n.f,
        }
    }

    fn turns(quarter_turns: u16) -> Map {
        (0..quarter_turns % 4).fold(Map::IDENTITY, |m, _| m.then(Map::TURN_CW))
    }

    fn from_orientation(o: Orientation) -> Map {
        match o {
            Orientation::NoTransforms => Map::IDENTITY,
            Orientation::Rotate90 => Map::turns(1),
            Orientation::Rotate180 => Map::turns(2),
            Orientation::Rotate270 => Map::turns(3),
            Orientation::FlipHorizontal => Map::FLIP_H,
            Orientation::FlipVertical => Map::FLIP_V,
            Orientation::Rotate90FlipH => Map::turns(1).then(Map::FLIP_H),
            Orientation::Rotate270FlipH => Map::turns(3).then(Map::FLIP_H),
        }
    }

    /// The picture's width and height swap places.
    fn swaps_axes(&self) -> bool {
        self.a.abs() < 0.5
    }
}

enum Payload {
    /// A complete JPEG file, stored as is.
    Jpeg(Vec<u8>),
    /// A zlib stream of PNG-filtered rows (`/Predictor 15`).
    Flate(Vec<u8>),
}

struct Prepared {
    width: u32,
    height: u32,
    gray: bool,
    payload: Payload,
    map: Map,
}

enum Item {
    Page(Prepared),
    Skipped(CoreError),
}

/// Builds `options.output_dir/<name>.pdf` from `images`, one page each.
pub fn images_to_pdf(images: &[ImageInput], options: &ImageToPdfOptions, ctx: &JobContext) -> CoreResult<ImageToPdfReport> {
    images_to_pdf_with(images, options, ctx, Arc::new(SystemMemory::new()))
}

pub(crate) fn images_to_pdf_with(
    images: &[ImageInput],
    options: &ImageToPdfOptions,
    ctx: &JobContext,
    probe: Arc<dyn MemoryProbe>,
) -> CoreResult<ImageToPdfReport> {
    let started = Instant::now();
    if images.is_empty() {
        return Err(CoreError::InvalidInput("no images provided".into()));
    }
    let page_size = options.page_size.trim().to_ascii_lowercase();
    if page_size != "match_image" && sheet(&page_size).is_none() {
        return Err(CoreError::InvalidInput(format!("unsupported page size: {}", options.page_size)));
    }
    if let Some(bad) = images.iter().find(|i| i.rotation % 90 != 0) {
        return Err(CoreError::InvalidInput(format!("rotation must be a multiple of 90, got {}", bad.rotation)));
    }
    if !options.output_dir.is_dir() {
        return Err(CoreError::NotFound { path: options.output_dir.clone() });
    }
    ctx.check_cancelled()?;

    let stem = sanitize_stem(options.output_name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or("output"));
    let (file, part) = create_part(&options.output_dir, &stem, "pdf").map_err(|e| CoreError::io(&options.output_dir, e))?;
    let guard = PartGuard::new(part.clone());
    let io_err = |e: std::io::Error| CoreError::io(&part, e);
    let mut pdf = PdfWriter::new(BufWriter::with_capacity(1 << 20, file)).map_err(io_err)?;

    let workers = worker_count(probe.as_ref(), PLANNED_BYTES_PER_WORKER, RESERVE_BYTES, MAX_WORKERS);
    let total = images.len() as u64;
    ctx.report(STAGE, 0, Some(total));
    let mut page_ids: Vec<u32> = Vec::new();
    let mut skipped: Vec<SkippedImage> = Vec::new();

    run_ordered(
        images.len(),
        workers,
        workers + 2,
        ctx,
        || Ok(()),
        |_, index| {
            ctx.check_cancelled()?;
            match prepare(&images[index], &probe, ctx) {
                Ok(p) => Ok(Item::Page(p)),
                Err(e) if e.is_cancelled() => Err(e),
                Err(e) => Ok(Item::Skipped(e)),
            }
        },
        |index, item| {
            match item {
                Item::Skipped(error) => skipped.push(SkippedImage {
                    source: images[index].path.clone(),
                    error: SkipReason { code: error.code().to_string(), message: error.to_string() },
                }),
                Item::Page(image) => {
                    let id = write_page(&mut pdf, &image, &page_size).map_err(io_err)?;
                    page_ids.push(id);
                }
            }
            ctx.report(STAGE, index as u64 + 1, Some(total));
            Ok(())
        },
    )?;

    if page_ids.is_empty() {
        let detail = skipped.first().map(|s| format!(": {}", s.error.message)).unwrap_or_default();
        return Err(CoreError::InvalidInput(format!("none of the provided images could be processed{detail}")));
    }
    let mut out = pdf.finish(&page_ids, "Dokuwu").map_err(io_err)?;
    out.flush().map_err(io_err)?;
    drop(out);
    let output_path = guard.publish(&options.output_dir, &stem, "pdf").map_err(|e| CoreError::io(&options.output_dir, e))?;
    let output_size_bytes = std::fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);
    Ok(ImageToPdfReport {
        output_path,
        output_size_bytes,
        pages: page_ids.len() as u32,
        page_size,
        skipped,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn num(x: f64) -> String {
    let s = format!("{x:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" || s == "-0" { "0".to_string() } else { s.to_string() }
}

/// Writes the image, its content stream and the page; returns the page's object number.
fn write_page<W: Write>(pdf: &mut PdfWriter<W>, image: &Prepared, page_size: &str) -> std::io::Result<u32> {
    let (mut disp_w, mut disp_h) = (image.width as f64, image.height as f64);
    if image.map.swaps_axes() {
        std::mem::swap(&mut disp_w, &mut disp_h);
    }
    // Page box and the rectangle the picture fills.
    let (page_w, page_h, x, y, w, h) = if page_size == "match_image" {
        // One pixel is one point.
        (disp_w, disp_h, 0.0, 0.0, disp_w, disp_h)
    } else {
        let (mut pw, mut ph) = sheet(page_size).unwrap_or((595.0, 842.0));
        // A landscape picture gets the landscape version of the sheet.
        if disp_w > disp_h {
            std::mem::swap(&mut pw, &mut ph);
        }
        let scale = (pw / disp_w).min(ph / disp_h);
        let (w, h) = (disp_w * scale, disp_h * scale);
        (pw, ph, (pw - w) / 2.0, (ph - h) / 2.0, w, h)
    };
    let m = image.map;
    let content = format!(
        "q {} {} {} {} {} {} cm /Im0 Do Q",
        num(w * m.a),
        num(h * m.b),
        num(w * m.c),
        num(h * m.d),
        num(x + w * m.e),
        num(y + h * m.f)
    );

    let space = if image.gray { "/DeviceGray" } else { "/DeviceRGB" };
    let filter = match image.payload {
        Payload::Jpeg(_) => "/Filter /DCTDecode".to_string(),
        Payload::Flate(_) => format!(
            "/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors {} /BitsPerComponent 8 /Columns {} >>",
            if image.gray { 1 } else { 3 },
            image.width
        ),
    };
    let data: &[u8] = match &image.payload {
        Payload::Jpeg(b) | Payload::Flate(b) => b,
    };
    let image_id = pdf.stream_object(
        &format!(
            "/Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {space} /BitsPerComponent 8 {filter}",
            image.width, image.height
        ),
        data,
    )?;
    let content_id = pdf.stream_object("", content.as_bytes())?;
    pdf.dict_object(&format!(
        "/Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Resources << /XObject << /Im0 {image_id} 0 R >> >> /Contents {content_id} 0 R",
        num(page_w),
        num(page_h)
    ))
}

fn prepare(input: &ImageInput, probe: &Arc<dyn MemoryProbe>, ctx: &JobContext) -> CoreResult<Prepared> {
    let path = &input.path;
    let bytes = std::fs::read(path).map_err(|e| CoreError::io(path, e))?;
    let user = Map::turns(input.rotation / 90);
    let compose = |exif: Map| {
        let flipped = if input.flip_h { exif.then(Map::FLIP_H) } else { exif };
        flipped.then(user)
    };

    if let Some((width, height, components)) = jpeg_header(&bytes) {
        if components == 1 || components == 3 {
            let exif = decoder_orientation(&bytes);
            return Ok(Prepared {
                width,
                height,
                gray: components == 1,
                payload: Payload::Jpeg(bytes),
                map: compose(Map::from_orientation(exif)),
            });
        }
    }
    if let Some((width, height, gray, idat)) = png_passthrough(&bytes) {
        return Ok(Prepared { width, height, gray, payload: Payload::Flate(idat), map: compose(Map::IDENTITY) });
    }

    // Everything else is decoded.
    let mut decoder = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| CoreError::io(path, e))?
        .into_decoder()
        .map_err(|e| CoreError::Unsupported(format!("cannot read image: {e}")))?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 || w as u64 * h as u64 > MAX_PIXELS {
        return Err(CoreError::Unsupported(format!("image of {w} x {h} pixels is too large")));
    }
    let exif = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let needed = w as u64 * h as u64 * 12 + RESERVE_BYTES;
    MemoryBrake::new(Arc::clone(probe), needed).wait_for_headroom(ctx)?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(w as u64 * h as u64 * 16 + 64 * MIB);
    decoder.set_limits(limits).map_err(|e| CoreError::Unsupported(format!("image too large: {e}")))?;
    let decoded = DynamicImage::from_decoder(decoder).map_err(|e| CoreError::Unsupported(format!("cannot decode image: {e}")))?;
    drop(bytes);
    let (gray, pixels) = flatten(decoded);
    let idat = png_idat(w, h, gray, &pixels)?;
    Ok(Prepared { width: w, height: h, gray, payload: Payload::Flate(idat), map: compose(Map::from_orientation(exif)) })
}

fn decoder_orientation(bytes: &[u8]) -> Orientation {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_decoder().ok())
        .and_then(|mut d| d.orientation().ok())
        .unwrap_or(Orientation::NoTransforms)
}

/// Grey or RGB 8-bit samples, transparency flattened on white.
pub(crate) fn flatten(img: DynamicImage) -> (bool, Vec<u8>) {
    let over_white = |c: u8, a: u8| ((c as u32 * a as u32 + 255 * (255 - a as u32) + 127) / 255) as u8;
    match img {
        DynamicImage::ImageLuma8(g) => (true, g.into_raw()),
        DynamicImage::ImageRgb8(r) => (false, r.into_raw()),
        DynamicImage::ImageLumaA8(ga) => {
            (true, ga.as_raw().chunks_exact(2).map(|p| over_white(p[0], p[1])).collect())
        }
        other if other.color().has_alpha() => {
            let rgba = other.to_rgba8();
            let mut out = Vec::with_capacity(rgba.as_raw().len() / 4 * 3);
            for p in rgba.as_raw().chunks_exact(4) {
                out.extend_from_slice(&[over_white(p[0], p[3]), over_white(p[1], p[3]), over_white(p[2], p[3])]);
            }
            (false, out)
        }
        other if matches!(other.color(), image::ColorType::L16) => (true, other.to_luma8().into_raw()),
        other => (false, other.to_rgb8().into_raw()),
    }
}

/// Width, height and component count of a baseline or progressive 8-bit JPEG.
fn jpeg_header(bytes: &[u8]) -> Option<(u32, u32, u8)> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            return None;
        }
        let marker = bytes[i + 1];
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if (0xD0..=0xD8).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        match marker {
            0xC0..=0xC2 => {
                let s = bytes.get(i + 4..i + 4 + 6)?;
                let (precision, h, w, comps) = (s[0], u16::from_be_bytes([s[1], s[2]]), u16::from_be_bytes([s[3], s[4]]), s[5]);
                return (precision == 8 && w > 0 && h > 0).then_some((w as u32, h as u32, comps));
            }
            // Other frame types (lossless, arithmetic) are decoded instead.
            0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => return None,
            0xDA => return None,
            _ => {}
        }
        i += 2 + len;
    }
    None
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Chunks of a PNG file as (type, data).
fn png_chunks(bytes: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    let mut at = 8usize;
    std::iter::from_fn(move || {
        let head = bytes.get(at..at + 8)?;
        let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
        let kind = [head[4], head[5], head[6], head[7]];
        let data = bytes.get(at + 8..at + 8 + len)?;
        at += 12 + len;
        Some((kind, data))
    })
}

/// An 8-bit, non-interlaced grey or RGB PNG: its compressed rows can go into
/// the PDF as they are. Returns width, height, grey and the joined IDAT data.
fn png_passthrough(bytes: &[u8]) -> Option<(u32, u32, bool, Vec<u8>)> {
    if bytes.len() < 33 || bytes[..8] != PNG_SIGNATURE {
        return None;
    }
    let mut header = None;
    let mut idat = Vec::new();
    for (kind, data) in png_chunks(bytes) {
        match &kind {
            b"IHDR" if data.len() == 13 => {
                let w = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                let h = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
                let (depth, color, interlace) = (data[8], data[9], data[12]);
                if depth != 8 || interlace != 0 || !(color == 0 || color == 2) || w == 0 || h == 0 {
                    return None;
                }
                header = Some((w, h, color == 0));
            }
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => break,
            _ => {}
        }
    }
    let (w, h, gray) = header?;
    (!idat.is_empty()).then_some((w, h, gray, idat))
}

/// Compresses samples as PNG and returns the IDAT payload (a zlib stream of
/// filtered rows), which a PDF reads with `/Predictor 15`.
fn png_idat(width: u32, height: u32, gray: bool, pixels: &[u8]) -> CoreResult<Vec<u8>> {
    let mut out = Vec::with_capacity(pixels.len() / 3);
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(if gray { png::ColorType::Grayscale } else { png::ColorType::Rgb });
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Balanced);
        enc.set_filter(png::Filter::Adaptive);
        let mut writer = enc.write_header().map_err(|e| CoreError::Internal(format!("png encode: {e}")))?;
        writer.write_image_data(pixels).map_err(|e| CoreError::Internal(format!("png encode: {e}")))?;
    }
    let mut idat = Vec::with_capacity(out.len());
    for (kind, data) in png_chunks(&out) {
        if &kind == b"IDAT" {
            idat.extend_from_slice(data);
        }
    }
    Ok(idat)
}
