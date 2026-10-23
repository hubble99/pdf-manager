//! The Organize workspace: thumbnails of the pages of the files being
//! arranged, and the PDF assembled from the arrangement.
//!
//! The workspace keeps the page order itself and sends it as a list of page
//! references (`source`, `page`, `rotation`, `flip`). Reordering, deleting,
//! duplicating and inserting are therefore all just a different list; this
//! module walks the list and copies each page.
//!
//! Files stay where the user keeps them. A file is *registered* once (checked
//! and given a handle) and read from its own path afterwards; nothing is copied
//! or deleted, and a file that changed on disk since it was added is refused
//! rather than half-read. The output goes to a folder of the caller's choice
//! under a name that is never taken (`name (1).pdf`).
//!
//! Pages of PDF sources are copied with one copy map per source (see
//! [`pdf_graft`](super::pdf_graft)). An image becomes a page of its own size
//! (one pixel is one point), stored as a JPEG of quality 95 after the mirror
//! and the quarter turns are applied to its pixels. A mirrored PDF page keeps
//! its vector content: the content streams are wrapped in a reflection about
//! the middle of the visible page area.

use std::collections::HashMap;
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, SystemTime};

use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageReader, Limits};
use jpeg_encoder::{ColorType, Encoder as JpegEncoder};
use mupdf::pdf::{PdfDocument, PdfGraftMap, PdfWriteOptions};
use mupdf::{Rect, Size};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;
use crate::ops::image_to_pdf::flatten;
use crate::ops::naming::{create_part, sanitize_stem, PartGuard};
use crate::ops::pdf_graft::{graft_page, internal, open, path_str, save_error, Spill};
use crate::ops::pdf_merge::flush_budget;
use crate::ops::pdf_render::{encode_png, RenderService};
use crate::resources::SystemMemory;

pub const STAGE_PAGES: &str = "pages";
pub const STAGE_SAVING: &str = "saving";

/// A workspace holds a handful of files; the bound only stops an abandoned or
/// runaway session from growing without limit.
pub const MAX_DOCUMENTS: usize = 32;
pub const DEFAULT_BATCH: u32 = 24;
pub const MAX_BATCH: u32 = 48;
pub const DEFAULT_WIDTH: u32 = 150;
pub const MIN_WIDTH: u32 = 48;
pub const MAX_WIDTH: u32 = 400;
/// An image above this many pixels is refused, not decoded.
const MAX_IMAGE_PIXELS: u64 = 400_000_000;
const JPEG_QUALITY: u8 = 95;

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKind {
    Pdf,
    Image,
}

/// What the workspace learns when it adds a file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeDocument {
    pub document_id: String,
    pub name: String,
    pub kind: DocumentKind,
    pub page_count: u32,
}

/// One page of the arrangement.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRef {
    pub source: String,
    /// 1-based page of the source (an image has one page).
    #[serde(default = "first_page")]
    pub page: u32,
    /// Quarter turns clockwise, added to the page's own rotation: 0, 90, 180 or 270.
    #[serde(default)]
    pub rotation: i32,
    /// Mirrored left to right, before the rotation.
    #[serde(default)]
    pub flip: bool,
}

fn first_page() -> u32 {
    1
}

/// A registered file as the assembly sees it.
#[derive(Debug, Clone)]
pub struct Source {
    pub path: PathBuf,
    pub kind: DocumentKind,
    pub page_count: u32,
}

#[derive(Debug, Clone)]
pub struct AssembleOptions {
    pub output_dir: PathBuf,
    /// File name without extension; `organized` when empty.
    pub output_name: Option<String>,
    /// Bytes of input to copy before the pages so far are saved to a temporary
    /// file and reopened. `None` picks a share of the free memory; tests set it
    /// low to exercise the flush.
    pub flush_after_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembleReport {
    pub output_path: PathBuf,
    pub output_size_bytes: u64,
    pub pages: u32,
    pub duration_ms: u64,
}

/// One rendered thumbnail.
#[derive(Debug, Clone)]
pub struct Thumbnail {
    pub page: u32,
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ThumbnailBatch {
    pub start: u32,
    pub total: u32,
    pub pages: Vec<Thumbnail>,
}

impl ThumbnailBatch {
    /// One binary message for the whole batch, so the PNGs cross the app
    /// boundary as bytes and not as base64 text. Little endian:
    /// `start u32, total u32, count u32`, then per page `page u32, width u32,
    /// height u32, length u32` and the PNG.
    pub fn encode(&self) -> Vec<u8> {
        let size: usize = 12 + self.pages.iter().map(|p| 16 + p.png.len()).sum::<usize>();
        let mut out = Vec::with_capacity(size);
        for value in [self.start, self.total, self.pages.len() as u32] {
            out.extend_from_slice(&value.to_le_bytes());
        }
        for page in &self.pages {
            for value in [page.page, page.width, page.height, page.png.len() as u32] {
                out.extend_from_slice(&value.to_le_bytes());
            }
            out.extend_from_slice(&page.png);
        }
        out
    }
}

struct Entry {
    path: PathBuf,
    name: String,
    kind: DocumentKind,
    page_count: u32,
    stamp: Stamp,
    last_used: u64,
}

/// Size and modification time when the file was added.
#[derive(Debug, Clone, PartialEq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

impl Stamp {
    fn of(path: &Path) -> CoreResult<Self> {
        let meta = fs::metadata(path).map_err(|e| CoreError::io(path, e))?;
        if !meta.is_file() {
            return Err(CoreError::InvalidInput(format!("not a file: {}", path.display())));
        }
        Ok(Self { len: meta.len(), modified: meta.modified().ok() })
    }
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    /// Handles are numbered; `tick` also orders use for eviction.
    next_id: u64,
    tick: u64,
}

/// The files of the open workspace. One lives for the whole run of the app.
#[derive(Default)]
pub struct OrganizeRegistry {
    inner: Mutex<Inner>,
}

impl OrganizeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Checks `path` and records it under a new handle. PDFs that are
    /// protected or have no pages, and images that cannot be read, are refused.
    pub fn open(&self, path: &Path) -> CoreResult<OrganizeDocument> {
        let stamp = Stamp::of(path)?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let extension = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        let (kind, page_count) = if extension == "pdf" {
            let doc = open(path).map_err(|e| CoreError::InvalidInput(format!("Cannot open PDF: {e}")))?;
            if doc.needs_password().map_err(|e| internal("password check", e))? {
                return Err(CoreError::PasswordRequired);
            }
            let pages = doc.page_count().map_err(|e| internal("page count", e))?.max(0) as u32;
            if pages == 0 {
                return Err(CoreError::InvalidInput("The PDF has no pages.".into()));
            }
            (DocumentKind::Pdf, pages)
        } else if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
            check_image(path)?;
            (DocumentKind::Image, 1)
        } else {
            return Err(CoreError::Unsupported("Use a PDF or a JPG, JPEG, PNG, WEBP, BMP or TIFF image.".into()));
        };

        let mut inner = self.lock();
        while inner.entries.len() >= MAX_DOCUMENTS {
            let oldest = inner.entries.iter().min_by_key(|(_, e)| e.last_used).map(|(id, _)| id.clone());
            match oldest {
                Some(id) => inner.entries.remove(&id),
                None => break,
            };
        }
        inner.next_id += 1;
        inner.tick += 1;
        let document_id = format!("doc{}", inner.next_id);
        let last_used = inner.tick;
        inner.entries.insert(
            document_id.clone(),
            Entry { path: path.to_path_buf(), name: name.clone(), kind, page_count, stamp, last_used },
        );
        Ok(OrganizeDocument { document_id, name, kind, page_count })
    }

    /// The registered file, after checking that it is still the file that was
    /// added.
    fn source(&self, id: &str) -> CoreResult<Source> {
        let mut inner = self.lock();
        inner.tick += 1;
        let tick = inner.tick;
        let entry = inner
            .entries
            .get_mut(id)
            .ok_or_else(|| CoreError::InvalidInput("That document is no longer available. Add the file again.".into()))?;
        entry.last_used = tick;
        let now = Stamp::of(&entry.path)?;
        if now != entry.stamp {
            return Err(CoreError::InvalidInput(format!(
                "{} changed on disk since it was added. Add the file again.",
                entry.name
            )));
        }
        Ok(Source { path: entry.path.clone(), kind: entry.kind, page_count: entry.page_count })
    }

    /// Forgets a file. The file itself is not touched. Returns whether the
    /// handle existed.
    pub fn release(&self, id: &str) -> bool {
        self.lock().entries.remove(id).is_some()
    }

    pub fn release_all(&self) -> usize {
        let mut inner = self.lock();
        let count = inner.entries.len();
        inner.entries.clear();
        count
    }

    pub fn count(&self) -> usize {
        self.lock().entries.len()
    }

    /// Thumbnails of up to `count` pages from page `start` (1-based), each
    /// `width` pixels wide (clamped to 48..=400).
    pub fn thumbnails(
        &self,
        render: &RenderService,
        id: &str,
        start: u32,
        count: u32,
        width: u32,
    ) -> CoreResult<ThumbnailBatch> {
        if start < 1 {
            return Err(CoreError::InvalidInput("The starting page must be at least 1.".into()));
        }
        if count < 1 {
            return Err(CoreError::InvalidInput("The batch size must be at least 1.".into()));
        }
        if count > MAX_BATCH {
            return Err(CoreError::InvalidInput(format!("A thumbnail batch can request at most {MAX_BATCH} pages.")));
        }
        let width = width.clamp(MIN_WIDTH, MAX_WIDTH);
        let source = self.source(id)?;
        match source.kind {
            DocumentKind::Image => {
                if start != 1 {
                    return Err(CoreError::InvalidInput("An image has a single page.".into()));
                }
                let png = image_thumbnail(&source.path, width)?;
                Ok(ThumbnailBatch { start: 1, total: 1, pages: vec![png.with_page(1)] })
            }
            DocumentKind::Pdf => {
                let total = source.page_count;
                if start > total {
                    return Err(CoreError::InvalidInput(format!(
                        "Page {start} is out of range (the document has {total} pages)."
                    )));
                }
                let last = total.min(start + count - 1);
                let mut pages = Vec::with_capacity((last - start + 1) as usize);
                for page in start..=last {
                    let rendered = render.render_width(&source.path, page, width)?;
                    pages.push(Thumbnail { page, width: rendered.width, height: rendered.height, png: rendered.png });
                }
                Ok(ThumbnailBatch { start, total, pages })
            }
        }
    }

    /// The files `refs` use, after the same check as for thumbnails.
    pub fn sources_for(&self, refs: &[PageRef]) -> CoreResult<HashMap<String, Source>> {
        let mut sources = HashMap::new();
        for page_ref in refs {
            if !sources.contains_key(&page_ref.source) {
                sources.insert(page_ref.source.clone(), self.source(&page_ref.source)?);
            }
        }
        Ok(sources)
    }
}

struct Picture {
    width: u32,
    height: u32,
    png: Vec<u8>,
}

impl Picture {
    fn with_page(self, page: u32) -> Thumbnail {
        Thumbnail { page, width: self.width, height: self.height, png: self.png }
    }
}

/// The header of `path` can be read and the picture is not absurdly large.
fn check_image(path: &Path) -> CoreResult<()> {
    let (w, h) = decoder_for(path)?.dimensions();
    if w == 0 || h == 0 || w as u64 * h as u64 > MAX_IMAGE_PIXELS {
        return Err(CoreError::Unsupported(format!("image of {w} x {h} pixels is too large")));
    }
    Ok(())
}

fn decoder_for(path: &Path) -> CoreResult<Box<dyn ImageDecoder + 'static>> {
    let file = fs::File::open(path).map_err(|e| CoreError::io(path, e))?;
    let reader = ImageReader::new(BufReader::new(file)).with_guessed_format().map_err(|e| CoreError::io(path, e))?;
    let decoder = reader.into_decoder().map_err(|e| CoreError::InvalidInput(format!("Cannot open image: {e}")))?;
    Ok(Box::new(decoder))
}

/// The picture with its EXIF orientation applied, like the page it becomes.
fn decode_oriented(path: &Path) -> CoreResult<DynamicImage> {
    let mut decoder = decoder_for(path)?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 || w as u64 * h as u64 > MAX_IMAGE_PIXELS {
        return Err(CoreError::Unsupported(format!("image of {w} x {h} pixels is too large")));
    }
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut limits = Limits::default();
    limits.max_alloc = Some(w as u64 * h as u64 * 16 + (64 << 20));
    decoder.set_limits(limits).map_err(|e| CoreError::Unsupported(format!("image too large: {e}")))?;
    let mut decoded = DynamicImage::from_decoder(decoder)
        .map_err(|e| CoreError::InvalidInput(format!("Cannot read image: {e}")))?;
    decoded.apply_orientation(orientation);
    Ok(decoded)
}

/// RGB samples of `image`, transparency flattened on white.
fn flatten_rgb(image: DynamicImage) -> (u32, u32, Vec<u8>) {
    let (width, height) = (image.width(), image.height());
    let (gray, pixels) = flatten(image);
    let rgb = if gray { pixels.iter().flat_map(|&g| [g, g, g]).collect() } else { pixels };
    (width, height, rgb)
}

fn image_thumbnail(path: &Path, target_width: u32) -> CoreResult<Picture> {
    let image = decode_oriented(path)?;
    let ratio = target_width as f64 / image.width().max(1) as f64;
    let height = ((image.height() as f64 * ratio).round() as u32).max(1);
    let small = image.resize_exact(target_width, height, FilterType::Lanczos3);
    let (width, height, rgb) = flatten_rgb(small);
    let png = encode_png(width, height, 3, width as isize * 3, &rgb)?;
    Ok(Picture { width, height, png })
}

/// JPEG bytes and size of an image page: mirrored first, then turned clockwise.
fn image_page_jpeg(path: &Path, rotation: i32, flip: bool) -> CoreResult<(Vec<u8>, u32, u32)> {
    let mut image = decode_oriented(path)?;
    if flip {
        image = image.fliph();
    }
    image = match rotation {
        90 => image.rotate90(),
        180 => image.rotate180(),
        270 => image.rotate270(),
        _ => image,
    };
    let (width, height, rgb) = flatten_rgb(image);
    if width > u16::MAX as u32 || height > u16::MAX as u32 {
        return Err(CoreError::Unsupported(format!("image of {width} x {height} pixels is too large for a page")));
    }
    let mut out = Vec::with_capacity(rgb.len() / 8);
    let mut encoder = JpegEncoder::new(&mut out, JPEG_QUALITY);
    encoder.set_optimized_huffman_tables(true);
    encoder
        .encode(&rgb, width as u16, height as u16, ColorType::Rgb)
        .map_err(|e| CoreError::Internal(format!("jpeg encode: {e}")))?;
    Ok((out, width, height))
}

fn write_options() -> PdfWriteOptions {
    let mut write = PdfWriteOptions::default();
    write.set_garbage_level(4).set_compress(true);
    write
}

/// Reflects the page's content left to right about the middle of its visible
/// area. The page keeps its size, boxes and rotation; text and vectors stay
/// vector.
///
/// The reflection translates by the horizontal bounds of the *visible* box (the
/// crop box inside the media box), not by the page width: for a page whose box
/// does not start at zero the two differ, and the content would shift instead
/// of mirroring in place. A page's content is usually several streams that
/// render as one, so the reflection opens before the first and closes after
/// the last, with the original wrapped in its own `q`/`Q` so unbalanced input
/// cannot leak into the reflection.
fn mirror_page(target: &mut PdfDocument, index: i32) -> CoreResult<()> {
    let mut page = target.load_pdf_page(index).map_err(|e| internal("loading page", e))?;
    let (x0, x1) = visible_x(&page)?;
    page.wrap_contents(target).map_err(|e| internal("wrapping page content", e))?;
    let prefix = format!("q -1 0 0 1 {} 0 cm\n", fmt_number(x0 + x1));
    page.insert_contents(target, prefix.as_bytes(), false).map_err(|e| internal("mirroring page", e))?;
    page.insert_contents(target, b"Q\n", true).map_err(|e| internal("mirroring page", e))?;
    Ok(())
}

/// Horizontal extent, in the page's own coordinates, of what a viewer shows.
fn visible_x(page: &mupdf::pdf::PdfPage) -> CoreResult<(f32, f32)> {
    let object = page.object();
    let read = |key: &str| -> CoreResult<Option<(f32, f32)>> {
        let Some(array) = object.get_dict_inheritable(key).map_err(|e| internal("reading page box", e))? else {
            return Ok(None);
        };
        let Some(array) = array.resolve().map_err(|e| internal("reading page box", e))? else { return Ok(None) };
        if !array.is_array().map_err(|e| internal("reading page box", e))? || array.len().unwrap_or(0) < 4 {
            return Ok(None);
        }
        let mut values = [0f32; 4];
        for (i, slot) in values.iter_mut().enumerate() {
            let item = array.get_array(i as i32).map_err(|e| internal("reading page box", e))?;
            let Some(item) = item.and_then(|v| v.resolve().ok().flatten()) else { return Ok(None) };
            *slot = item.as_float().map_err(|e| internal("reading page box", e))?;
        }
        Ok(Some((values[0].min(values[2]), values[0].max(values[2]))))
    };
    let media = read("MediaBox")?.unwrap_or((0.0, 612.0));
    let (c0, c1) = read("CropBox")?.unwrap_or(media);
    let (x0, x1) = (c0.max(media.0), c1.min(media.1));
    Ok(if x1 > x0 { (x0, x1) } else { media })
}

/// Numbers in a content stream: no exponent, trimmed zeros.
fn fmt_number(value: f32) -> String {
    let text = format!("{value:.4}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn check_refs(refs: &[PageRef], sources: &HashMap<String, Source>) -> CoreResult<()> {
    if refs.is_empty() {
        return Err(CoreError::InvalidInput("The document has no pages to save.".into()));
    }
    for (index, page_ref) in refs.iter().enumerate() {
        let n = index + 1;
        let Some(source) = sources.get(&page_ref.source) else {
            return Err(CoreError::InvalidInput(format!(
                "Page entry {n} refers to a document that is no longer available."
            )));
        };
        if page_ref.page < 1 || page_ref.page > source.page_count {
            return Err(CoreError::InvalidInput(format!(
                "Page entry {n} refers to page {}, but that source has {} page(s).",
                page_ref.page, source.page_count
            )));
        }
        // Rejected, not normalised: turning 360 or -90 into a quarter turn
        // would hide a caller that sends values outside the contract.
        if !matches!(page_ref.rotation, 0 | 90 | 180 | 270) {
            return Err(CoreError::InvalidInput(format!("Page entry {n} has an unsupported rotation.")));
        }
    }
    Ok(())
}

/// Builds one PDF from `refs` in `options.output_dir`.
pub fn assemble(
    sources: &HashMap<String, Source>,
    refs: &[PageRef],
    options: &AssembleOptions,
    ctx: &JobContext,
) -> CoreResult<AssembleReport> {
    let started = Instant::now();
    check_refs(refs, sources)?;
    if !options.output_dir.is_dir() {
        return Err(CoreError::NotFound { path: options.output_dir.clone() });
    }
    ctx.check_cancelled()?;
    let budget = options.flush_after_bytes.unwrap_or_else(|| flush_budget(&SystemMemory::new()));

    let base = sanitize_stem(options.output_name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or("organized"));
    let (file, part) = create_part(&options.output_dir, &base, "pdf").map_err(|e| CoreError::io(&options.output_dir, e))?;
    drop(file);
    let guard = PartGuard::new(part.clone());

    // Declared first, so they are dropped last: the temporary files can only be
    // deleted once the documents and copy maps that read them are gone.
    let mut spill = Spill::new(&options.output_dir, &base);
    let mut target = PdfDocument::new();
    let mut inputs: HashMap<String, Input> = HashMap::new();
    let mut held = 0u64;
    let total = refs.len() as u64;
    ctx.report(STAGE_PAGES, 0, Some(total));

    for (done, page_ref) in refs.iter().enumerate() {
        ctx.check_cancelled()?;
        let source = &sources[&page_ref.source];
        let entry_error = |e: mupdf::Error| internal(&format!("cannot add page entry {}", done + 1), e);
        match source.kind {
            DocumentKind::Image => {
                let (jpeg, width, height) = image_page_jpeg(&source.path, page_ref.rotation, page_ref.flip)?;
                let mut page = target.new_page(Size::new(width as f32, height as f32)).map_err(entry_error)?;
                let rect = Rect::new(0.0, 0.0, width as f32, height as f32);
                let image = mupdf::pdf::PageImageSource::Bytes { data: &jpeg, format_hint: None };
                page.insert_image(&mut target, rect, image, Default::default()).map_err(entry_error)?;
                held += jpeg.len() as u64;
            }
            DocumentKind::Pdf => {
                if !inputs.contains_key(&page_ref.source) {
                    let doc = open(&source.path).map_err(|e| CoreError::InvalidInput(format!("Cannot open PDF: {e}")))?;
                    let map = target.new_graft_map().map_err(|e| internal("copy map", e))?;
                    let size = fs::metadata(&source.path).map(|m| m.len()).unwrap_or(0);
                    inputs.insert(page_ref.source.clone(), Input { doc, map: Some(map), per_page: size / source.page_count.max(1) as u64 });
                }
                let input = inputs.get_mut(&page_ref.source).expect("just inserted");
                if input.map.is_none() {
                    input.map = Some(target.new_graft_map().map_err(|e| internal("copy map", e))?);
                }
                let map = input.map.as_mut().expect("map exists");
                graft_page(&mut target, map, &input.doc, page_ref.page as i32 - 1).map_err(entry_error)?;
                let index = target.page_count().map_err(entry_error)? - 1;
                if page_ref.flip {
                    mirror_page(&mut target, index)?;
                }
                if page_ref.rotation != 0 {
                    let mut page = target.load_pdf_page(index).map_err(entry_error)?;
                    let turned = (page.rotation().map_err(entry_error)? + page_ref.rotation).rem_euclid(360);
                    page.set_rotation(turned).map_err(entry_error)?;
                }
                held += input.per_page;
            }
        }
        ctx.report(STAGE_PAGES, done as u64 + 1, Some(total));
        if held >= budget && done + 1 < refs.len() {
            target = spill.flush(target)?;
            // The copy maps point into the document that was just saved; new
            // ones are made when a source is next used.
            for input in inputs.values_mut() {
                input.map = None;
            }
            spill.reap();
            held = 0;
        }
    }

    ctx.check_cancelled()?;
    ctx.report(STAGE_SAVING, 0, None);
    if target.page_count().map_err(|e| internal("page count", e))? < 1 {
        return Err(CoreError::InvalidInput("The assembled document has no pages.".into()));
    }
    target.save_with_options(path_str(&part)?, write_options()).map_err(|e| save_error(&part, e))?;
    drop(inputs);
    drop(target);
    spill.clean();
    ctx.check_cancelled()?;

    let output_path = guard.publish(&options.output_dir, &base, "pdf").map_err(|e| CoreError::io(&options.output_dir, e))?;
    Ok(AssembleReport {
        output_size_bytes: fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0),
        output_path,
        pages: refs.len() as u32,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// An opened PDF source and its copy map into the output.
struct Input {
    doc: PdfDocument,
    /// Dropped (to `None`) when the output is flushed to disk.
    map: Option<PdfGraftMap>,
    per_page: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_have_no_exponent_or_trailing_zeros() {
        assert_eq!(fmt_number(612.0), "612");
        assert_eq!(fmt_number(595.2756), "595.2756");
        assert_eq!(fmt_number(0.5), "0.5");
        assert_eq!(fmt_number(-12.25), "-12.25");
    }

    #[test]
    fn a_batch_frame_carries_every_page() {
        let batch = ThumbnailBatch {
            start: 3,
            total: 10,
            pages: vec![
                Thumbnail { page: 3, width: 150, height: 200, png: vec![1, 2, 3] },
                Thumbnail { page: 4, width: 150, height: 210, png: vec![9] },
            ],
        };
        let bytes = batch.encode();
        let word = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
        assert_eq!((word(0), word(4), word(8)), (3, 10, 2));
        assert_eq!((word(12), word(16), word(20), word(24)), (3, 150, 200, 3));
        assert_eq!(&bytes[28..31], &[1, 2, 3]);
        assert_eq!((word(31), word(43)), (4, 1));
        assert_eq!(bytes.len(), 12 + 16 + 3 + 16 + 1);
    }
}
