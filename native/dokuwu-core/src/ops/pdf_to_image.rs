//! PDF pages to images (PNG, JPEG, WEBP).
//!
//! One page becomes one image file; several pages become one ZIP. Pages are
//! rendered and encoded by a few worker threads (each opens the PDF itself,
//! because MuPDF documents belong to the thread that opened them) and written
//! in page order, so memory holds only the pages in flight whatever the size of
//! the PDF or of the selection. The result is written as a `.part` file and
//! renamed to a free name in the output folder when complete; cancelling or a
//! failure removes it.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use jpeg_encoder::{ColorType, Encoder as JpegEncoder};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;
use crate::ops::naming::{create_part, sanitize_stem, PartGuard};
use crate::ops::ordered::run_ordered;
use crate::ops::page_ranges;
use crate::ops::pdf_render::{export_dpi, RenderDocument, RgbView, MAX_DPI, MIN_DPI};
use crate::ops::zip_stream::ZipWriter;
use crate::resources::{worker_count, MemoryBrake, MemoryProbe, SystemMemory, MIB};

/// Stage name used in progress reports.
pub const STAGE: &str = "pages";

pub const JPEG_QUALITY: u8 = 90;
pub const WEBP_QUALITY: f32 = 90.0;
/// The largest side WEBP can store.
const WEBP_MAX_SIDE: f64 = 16_383.0;
const MAX_WORKERS: usize = 4;
const RESERVE_BYTES: u64 = 512 * MIB;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    #[serde(alias = "jpg")]
    Jpeg,
    Webp,
}

impl ImageFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpeg",
            ImageFormat::Webp => "webp",
        }
    }

    fn max_side(self) -> Option<f64> {
        match self {
            ImageFormat::Webp => Some(WEBP_MAX_SIDE),
            ImageFormat::Jpeg => Some(65_535.0),
            ImageFormat::Png => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfToImageOptions {
    pub format: ImageFormat,
    /// Resolution to render at, 36 to 600. Pages that would pass 60 megapixels
    /// (or a format's size limit) are rendered at a lower dpi and listed in the
    /// report.
    pub dpi: u32,
    /// `1-3,5,7-9`; blank means every page.
    #[serde(default)]
    pub page_ranges: String,
    /// Folder the result is written to. Must exist.
    pub output_dir: PathBuf,
    /// Name without extension; blank means the PDF's name.
    #[serde(default)]
    pub output_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfToImageReport {
    pub output_path: PathBuf,
    pub output_size_bytes: u64,
    pub pages: u32,
    /// Several pages are packed in a ZIP; one page is a plain image file.
    pub is_zip: bool,
    pub format: ImageFormat,
    pub dpi: u32,
    /// 1-based pages rendered at a lower dpi than asked for.
    pub reduced_pages: Vec<u32>,
    pub duration_ms: u64,
}

struct Rendered {
    bytes: Vec<u8>,
    reduced: bool,
}

/// Converts the selected pages of `input` to images in `options.output_dir`.
pub fn pdf_to_images(input: &Path, options: &PdfToImageOptions, ctx: &JobContext) -> CoreResult<PdfToImageReport> {
    pdf_to_images_with(input, options, ctx, Arc::new(SystemMemory::new()))
}

pub(crate) fn pdf_to_images_with(
    input: &Path,
    options: &PdfToImageOptions,
    ctx: &JobContext,
    probe: Arc<dyn MemoryProbe>,
) -> CoreResult<PdfToImageReport> {
    let started = Instant::now();
    if !(MIN_DPI..=MAX_DPI).contains(&options.dpi) {
        return Err(CoreError::InvalidInput(format!("dpi must be between {MIN_DPI} and {MAX_DPI}")));
    }
    if !options.output_dir.is_dir() {
        return Err(CoreError::NotFound { path: options.output_dir.clone() });
    }
    ctx.check_cancelled()?;

    let doc = RenderDocument::open(input)?;
    let pages = page_ranges::select(&options.page_ranges, doc.page_count())?;
    let format = options.format;
    let dpi = options.dpi;

    // Size the pool from the biggest selected page: a render holds the pixmap
    // plus the encoder's copy and output.
    let mut plans = Vec::with_capacity(pages.len());
    let mut biggest_px = 0.0f64;
    for &page in &pages {
        ctx.check_cancelled()?;
        let (w, h) = doc.page_size_pt(page)?;
        let actual = export_dpi(w, h, dpi, format.max_side());
        let px = w * actual as f64 / 72.0 * (h * actual as f64 / 72.0);
        biggest_px = biggest_px.max(px);
        plans.push((page, actual, px));
    }
    drop(doc);
    let per_worker = (biggest_px * 3.0 * 3.0) as u64 + 32 * MIB;
    let workers = worker_count(probe.as_ref(), per_worker, RESERVE_BYTES, MAX_WORKERS);

    let stem = match options.output_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => sanitize_stem(name),
        None => sanitize_stem(&input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()),
    };
    let ext = format.extension();
    let is_zip = pages.len() > 1;
    let (final_stem, final_ext) = if is_zip {
        (format!("{stem}_images"), "zip")
    } else {
        (format!("{stem}_page{:04}", pages[0]), ext)
    };
    let (file, part) = create_part(&options.output_dir, &final_stem, final_ext)
        .map_err(|e| CoreError::io(&options.output_dir, e))?;
    let guard = PartGuard::new(part.clone());
    let mut sink = Sink::new(file, is_zip);

    let total = pages.len() as u64;
    ctx.report(STAGE, 0, Some(total));
    let mut reduced_pages = Vec::new();

    run_ordered(
        pages.len(),
        workers,
        workers * 2,
        ctx,
        || RenderDocument::open(input),
        |doc, index| {
            let (page, actual, px) = plans[index];
            MemoryBrake::new(Arc::clone(&probe), (px * 3.0 * 3.0) as u64 + RESERVE_BYTES).wait_for_headroom(ctx)?;
            ctx.check_cancelled()?;
            let bytes = doc.render_rgb(page, actual, |view| encode(&view, format))?;
            Ok(Rendered { bytes, reduced: actual < dpi })
        },
        |index, rendered| {
            let page = plans[index].0;
            if rendered.reduced {
                reduced_pages.push(page);
            }
            sink.add(&format!("{stem}_page{page:04}.{ext}"), &rendered.bytes).map_err(|e| CoreError::io(&part, e))?;
            ctx.report(STAGE, index as u64 + 1, Some(total));
            Ok(())
        },
    )?;

    let mut out = sink.finish().map_err(|e| CoreError::io(&part, e))?;
    out.flush().map_err(|e| CoreError::io(&part, e))?;
    drop(out);
    let output_path = guard
        .publish(&options.output_dir, &final_stem, final_ext)
        .map_err(|e| CoreError::io(&options.output_dir, e))?;
    let output_size_bytes = std::fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);
    Ok(PdfToImageReport {
        output_path,
        output_size_bytes,
        pages: pages.len() as u32,
        is_zip,
        format,
        dpi,
        reduced_pages,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// A ZIP for several pages, or the bare image for one.
enum Sink {
    Zip(ZipWriter<BufWriter<File>>),
    Single(BufWriter<File>),
}

impl Sink {
    fn new(file: File, zip: bool) -> Self {
        let out = BufWriter::with_capacity(1 << 20, file);
        if zip {
            Sink::Zip(ZipWriter::new(out))
        } else {
            Sink::Single(out)
        }
    }

    fn add(&mut self, name: &str, data: &[u8]) -> std::io::Result<()> {
        match self {
            Sink::Zip(z) => z.add(name, data),
            Sink::Single(w) => w.write_all(data),
        }
    }

    fn finish(self) -> std::io::Result<BufWriter<File>> {
        match self {
            Sink::Zip(z) => z.finish(),
            Sink::Single(w) => Ok(w),
        }
    }
}

fn encode(view: &RgbView<'_>, format: ImageFormat) -> CoreResult<Vec<u8>> {
    match format {
        ImageFormat::Png => encode_png(view),
        ImageFormat::Jpeg => encode_jpeg(view),
        ImageFormat::Webp => encode_webp(view),
    }
}

fn encode_png(view: &RgbView<'_>) -> CoreResult<Vec<u8>> {
    let data = view.packed();
    let mut out = Vec::with_capacity(data.len() / 4);
    {
        let mut enc = png::Encoder::new(&mut out, view.width, view.height);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Balanced);
        enc.set_filter(png::Filter::Adaptive);
        // Record the render resolution (pixels per metre) so viewers show the real size.
        let ppm = (view.dpi as f64 / 0.0254).round() as u32;
        enc.set_pixel_dims(Some(png::PixelDimensions { xppu: ppm, yppu: ppm, unit: png::Unit::Meter }));
        let mut writer = enc.write_header().map_err(|e| CoreError::Internal(format!("png encode: {e}")))?;
        writer.write_image_data(&data).map_err(|e| CoreError::Internal(format!("png encode: {e}")))?;
    }
    Ok(out)
}

fn encode_jpeg(view: &RgbView<'_>) -> CoreResult<Vec<u8>> {
    let (w, h) = (u16::try_from(view.width), u16::try_from(view.height));
    let (Ok(w), Ok(h)) = (w, h) else {
        return Err(CoreError::Unsupported("the page is too large for JPEG".into()));
    };
    let data = view.packed();
    let mut out = Vec::with_capacity(data.len() / 8);
    let mut enc = JpegEncoder::new(&mut out, JPEG_QUALITY);
    enc.set_optimized_huffman_tables(true);
    enc.encode(&data, w, h, ColorType::Rgb).map_err(|e| CoreError::Internal(format!("jpeg encode: {e}")))?;
    Ok(out)
}

fn encode_webp(view: &RgbView<'_>) -> CoreResult<Vec<u8>> {
    let data = view.packed();
    let encoded = webp::Encoder::from_rgb(&data, view.width, view.height).encode(WEBP_QUALITY);
    Ok(encoded.to_vec())
}
