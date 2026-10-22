//! Page previews and PDF facts.
//!
//! The preview and thumbnail components ask for one page at a time, many times
//! over (a 200-page document in a grid is 200 requests), so rendering is a small
//! service rather than a job: two worker threads, each keeping the last PDF it
//! opened. MuPDF opens lazily, so a cached document costs little even for a huge
//! file, and scrolling a grid does not reopen the file for every page.
//!
//! Rules carried over from the old preview route, so pages look the same:
//!
//! - the longest side is capped at 1024, 2048 or 4096 px (low, auto, high hint);
//! - the dpi is lowered to fit, never below [`MIN_DPI`];
//! - RGB on white, colour-managed (ICC) like a PDF viewer shows it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use mupdf::pdf::PdfDocument;
use mupdf::{Colorspace, Context, Matrix, MetadataName};
use serde::Serialize;

use crate::error::{CoreError, CoreResult};
use crate::resources::{MemoryProbe, SystemMemory, MIB};

pub const MIN_DPI: u32 = 36;
pub const MAX_DPI: u32 = 600;
/// Hard ceiling for one rendered page, so a large sheet cannot exhaust memory.
pub const MAX_PIXELS: f64 = 60_000_000.0;
/// Pages above this many pixels wait for free memory before they are rendered.
const BIG_RENDER_PIXELS: f64 = 20_000_000.0;
const RESERVE_BYTES: u64 = 256 * MIB;
const WORKERS: usize = 2;

/// How sharp a preview may get: the longest side in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QualityHint {
    Low,
    Auto,
    High,
}

impl QualityHint {
    pub fn max_side(self) -> f64 {
        match self {
            QualityHint::Low => 1024.0,
            QualityHint::Auto => 2048.0,
            QualityHint::High => 4096.0,
        }
    }

    /// Unknown words mean `Auto`, like the old route.
    pub fn parse(text: &str) -> Self {
        match text {
            "low" => QualityHint::Low,
            "high" => QualityHint::High,
            _ => QualityHint::Auto,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMetadata {
    pub format: String,
    pub title: String,
    pub author: String,
    pub subject: String,
    pub keywords: String,
    pub creator: String,
    pub producer: String,
    pub creation_date: String,
    pub mod_date: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInfo {
    pub size_bytes: u64,
    /// 0 when the PDF is encrypted (the count cannot be read).
    pub pages: u32,
    pub encrypted: bool,
    pub metadata: PdfMetadata,
}

/// One rendered page.
#[derive(Debug, Clone)]
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    /// The dpi actually used, after the size rules.
    pub dpi: u32,
    pub png: Vec<u8>,
}

fn mupdf_error(context: &str, err: mupdf::Error) -> CoreError {
    CoreError::Internal(format!("{context}: {err}"))
}

fn path_str(path: &Path) -> CoreResult<&str> {
    path.to_str()
        .ok_or_else(|| CoreError::InvalidInput(format!("path is not valid text: {}", path.display())))
}

fn file_size(path: &Path) -> CoreResult<u64> {
    let meta = std::fs::metadata(path).map_err(|e| CoreError::io(path, e))?;
    if !meta.is_file() {
        return Err(CoreError::InvalidInput(format!("not a file: {}", path.display())));
    }
    Ok(meta.len())
}

/// Colour-managed rendering, once per process (MuPDF shares the setting between
/// the contexts of all threads).
fn enable_icc() {
    Context::get().enable_icc();
}

fn open_pdf(path: &Path) -> CoreResult<PdfDocument> {
    PdfDocument::open(path_str(path)?).map_err(|e| CoreError::InvalidInput(format!("cannot open PDF: {e}")))
}

/// Page count, size, protection and metadata of a PDF.
pub fn pdf_info(path: &Path) -> CoreResult<PdfInfo> {
    let size_bytes = file_size(path)?;
    let doc = open_pdf(path)?;
    let encrypted = doc.needs_password().map_err(|e| mupdf_error("password check", e))?;
    let meta = |name: MetadataName| doc.metadata(name).unwrap_or_default();
    let metadata = PdfMetadata {
        format: meta(MetadataName::Format),
        title: meta(MetadataName::Title),
        author: meta(MetadataName::Author),
        subject: meta(MetadataName::Subject),
        keywords: meta(MetadataName::Keywords),
        creator: meta(MetadataName::Creator),
        producer: meta(MetadataName::Producer),
        creation_date: meta(MetadataName::CreationDate),
        mod_date: meta(MetadataName::ModDate),
    };
    let pages = if encrypted { 0 } else { doc.page_count().unwrap_or(0).max(0) as u32 };
    Ok(PdfInfo { size_bytes, pages, encrypted, metadata })
}

/// The dpi to render a page of `width_pt` by `height_pt` points at, given the
/// wish `dpi` and the hint. Mirrors the old route: scale down so the longest
/// side fits, floor at [`MIN_DPI`], then keep under [`MAX_PIXELS`].
pub fn effective_dpi(width_pt: f64, height_pt: f64, dpi: u32, hint: QualityHint) -> u32 {
    let wished = dpi.clamp(MIN_DPI, MAX_DPI) as f64;
    let target_w = width_pt * wished / 72.0;
    let target_h = height_pt * wished / 72.0;
    let max_side = hint.max_side();
    let mut actual = wished;
    if target_w > max_side || target_h > max_side {
        let scale = (max_side / target_w).min(max_side / target_h);
        actual = (wished * scale).floor();
    }
    let mut actual = actual.max(MIN_DPI as f64);
    let pixels = width_pt * actual / 72.0 * (height_pt * actual / 72.0);
    if pixels > MAX_PIXELS {
        actual = (actual * (MAX_PIXELS / pixels).sqrt()).floor().max(MIN_DPI as f64);
    }
    actual as u32
}

/// The dpi to export a page of `width_pt` by `height_pt` points at. Unlike a
/// preview, an export keeps the dpi the user asked for; it is lowered only when
/// the page would pass [`MAX_PIXELS`] or `max_side` pixels (a format limit, such
/// as 16383 for WEBP), and never below [`MIN_DPI`].
pub fn export_dpi(width_pt: f64, height_pt: f64, dpi: u32, max_side: Option<f64>) -> u32 {
    let wished = dpi.clamp(MIN_DPI, MAX_DPI) as f64;
    let mut scale: f64 = 1.0;
    let pixels = width_pt * wished / 72.0 * (height_pt * wished / 72.0);
    if pixels > MAX_PIXELS {
        scale = scale.min((MAX_PIXELS / pixels).sqrt());
    }
    if let Some(max_side) = max_side {
        let longest = width_pt.max(height_pt) * wished / 72.0;
        if longest > max_side {
            scale = scale.min(max_side / longest);
        }
    }
    ((wished * scale).floor().max(MIN_DPI as f64)) as u32
}

/// A rendered page as RGB samples borrowed from MuPDF (`stride` bytes per row,
/// which can be more than `width * 3`).
pub struct RgbView<'a> {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub samples: &'a [u8],
    /// The dpi the page was actually rendered at.
    pub dpi: u32,
}

impl RgbView<'_> {
    /// Rows packed without padding.
    pub fn packed(&self) -> std::borrow::Cow<'_, [u8]> {
        let row = self.width as usize * 3;
        if self.stride == row {
            return std::borrow::Cow::Borrowed(&self.samples[..row * self.height as usize]);
        }
        let mut out = Vec::with_capacity(row * self.height as usize);
        for y in 0..self.height as usize {
            out.extend_from_slice(&self.samples[y * self.stride..y * self.stride + row]);
        }
        std::borrow::Cow::Owned(out)
    }
}

/// A PDF opened for rendering. MuPDF documents are tied to the thread that
/// opened them, so one of these lives inside a worker.
pub struct RenderDocument {
    doc: PdfDocument,
    pages: u32,
}

impl RenderDocument {
    pub fn open(path: &Path) -> CoreResult<Self> {
        enable_icc();
        file_size(path)?;
        let doc = open_pdf(path)?;
        if doc.needs_password().map_err(|e| mupdf_error("password check", e))? {
            return Err(CoreError::PasswordRequired);
        }
        let pages = doc.page_count().map_err(|e| mupdf_error("page count", e))?.max(0) as u32;
        Ok(Self { doc, pages })
    }

    pub fn page_count(&self) -> u32 {
        self.pages
    }

    /// Size of page `page` (1-based) in points, as rendered (rotation applied).
    pub fn page_size_pt(&self, page: u32) -> CoreResult<(f64, f64)> {
        self.check_page(page)?;
        let loaded = self.doc.load_page(page as i32 - 1).map_err(|e| mupdf_error("loading page", e))?;
        let bounds = loaded.bounds().map_err(|e| mupdf_error("page bounds", e))?;
        Ok(((bounds.x1 - bounds.x0) as f64, (bounds.y1 - bounds.y0) as f64))
    }

    fn check_page(&self, page: u32) -> CoreResult<()> {
        if page < 1 || page > self.pages {
            return Err(CoreError::InvalidInput(format!(
                "page number out of bounds: the document has {} pages",
                self.pages
            )));
        }
        Ok(())
    }

    /// Renders page `page` (1-based) at `dpi`, already chosen by the caller
    /// (see [`export_dpi`]), and gives the RGB samples to `f`. The samples are
    /// freed when `f` returns.
    pub fn render_rgb<R>(
        &self,
        page: u32,
        dpi: u32,
        f: impl FnOnce(RgbView<'_>) -> CoreResult<R>,
    ) -> CoreResult<R> {
        self.check_page(page)?;
        let loaded = self.doc.load_page(page as i32 - 1).map_err(|e| mupdf_error("loading page", e))?;
        let bounds = loaded.bounds().map_err(|e| mupdf_error("page bounds", e))?;
        let (w_pt, h_pt) = ((bounds.x1 - bounds.x0) as f64, (bounds.y1 - bounds.y0) as f64);
        let scale = dpi as f32 / 72.0;
        check_memory(w_pt * scale as f64, h_pt * scale as f64)?;
        let pixmap = loaded
            .to_pixmap(&Matrix::new_scale(scale, scale), &Colorspace::device_rgb(), false, true)
            .map_err(|e| mupdf_error("rendering page", e))?;
        if pixmap.n() != 3 {
            return Err(CoreError::Internal(format!("unexpected pixmap with {} components", pixmap.n())));
        }
        f(RgbView {
            width: pixmap.width(),
            height: pixmap.height(),
            stride: pixmap.stride().max(0) as usize,
            samples: pixmap.samples(),
            dpi,
        })
    }

    /// Renders page `page` (1-based).
    pub fn render(&self, page: u32, dpi: u32, hint: QualityHint) -> CoreResult<RenderedPage> {
        if page < 1 || page > self.pages {
            return Err(CoreError::InvalidInput(format!(
                "page number out of bounds: the document has {} pages",
                self.pages
            )));
        }
        let loaded = self.doc.load_page(page as i32 - 1).map_err(|e| mupdf_error("loading page", e))?;
        let bounds = loaded.bounds().map_err(|e| mupdf_error("page bounds", e))?;
        let (w_pt, h_pt) = ((bounds.x1 - bounds.x0) as f64, (bounds.y1 - bounds.y0) as f64);
        let actual = effective_dpi(w_pt, h_pt, dpi, hint);
        let scale = actual as f32 / 72.0;
        check_memory(w_pt * scale as f64, h_pt * scale as f64)?;
        let pixmap = loaded
            .to_pixmap(&Matrix::new_scale(scale, scale), &Colorspace::device_rgb(), false, true)
            .map_err(|e| mupdf_error("rendering page", e))?;
        let (width, height) = (pixmap.width(), pixmap.height());
        let png = encode_png(width, height, pixmap.n() as usize, pixmap.stride(), pixmap.samples())?;
        Ok(RenderedPage { width, height, dpi: actual, png })
    }
}

/// Large pages need a few times their pixel size in memory (pixmap, the
/// encoder's copy); refuse early rather than let the machine swap.
fn check_memory(width_px: f64, height_px: f64) -> CoreResult<()> {
    let pixels = width_px * height_px;
    if pixels < BIG_RENDER_PIXELS {
        return Ok(());
    }
    let needed = (pixels * 3.0 * 2.0) as u64 + RESERVE_BYTES;
    let available = SystemMemory::new().available_bytes();
    if available < needed {
        return Err(CoreError::InsufficientMemory { needed_bytes: needed, available_bytes: available });
    }
    Ok(())
}

fn encode_png(width: u32, height: u32, n: usize, stride: isize, samples: &[u8]) -> CoreResult<Vec<u8>> {
    if n != 3 {
        return Err(CoreError::Internal(format!("unexpected pixmap with {n} components")));
    }
    let row = width as usize * 3;
    let stride = stride.max(0) as usize;
    let mut packed;
    let data: &[u8] = if stride == row {
        samples
    } else {
        packed = Vec::with_capacity(row * height as usize);
        for y in 0..height as usize {
            packed.extend_from_slice(&samples[y * stride..y * stride + row]);
        }
        &packed
    };
    let mut out = Vec::with_capacity(data.len() / 4);
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        // Previews are shown once and thrown away: speed over size.
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| CoreError::Internal(format!("png encode: {e}")))?;
        writer
            .write_image_data(data)
            .map_err(|e| CoreError::Internal(format!("png encode: {e}")))?;
    }
    Ok(out)
}

struct Request {
    path: PathBuf,
    page: u32,
    dpi: u32,
    hint: QualityHint,
    reply: Sender<CoreResult<RenderedPage>>,
}

/// What a worker remembers about the file it has open: if the file changed on
/// disk the cached document is dropped.
#[derive(PartialEq)]
struct FileStamp {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

impl FileStamp {
    fn of(path: &Path) -> CoreResult<Self> {
        let meta = std::fs::metadata(path).map_err(|e| CoreError::io(path, e))?;
        Ok(Self { path: path.to_path_buf(), len: meta.len(), modified: meta.modified().ok() })
    }
}

/// Two render threads and a queue. Cheap to keep around for the whole run of
/// the app; the threads stop when the service is dropped.
pub struct RenderService {
    jobs: Mutex<Option<Sender<Request>>>,
    stopping: Arc<AtomicBool>,
    workers: Mutex<Vec<thread::JoinHandle<()>>>,
}

impl RenderService {
    pub fn new() -> Self {
        Self::with_workers(WORKERS)
    }

    pub fn with_workers(count: usize) -> Self {
        let (tx, rx) = mpsc::channel::<Request>();
        let rx = Arc::new(Mutex::new(rx));
        let stopping = Arc::new(AtomicBool::new(false));
        let workers = (0..count.max(1))
            .map(|i| {
                let rx = Arc::clone(&rx);
                let stopping = Arc::clone(&stopping);
                thread::Builder::new()
                    .name(format!("dokuwu-render-{i}"))
                    .spawn(move || worker(rx, stopping))
                    .expect("cannot start render thread")
            })
            .collect();
        Self { jobs: Mutex::new(Some(tx)), stopping, workers: Mutex::new(workers) }
    }

    /// Renders one page and waits for it. Call from a blocking thread.
    pub fn render(&self, path: &Path, page: u32, dpi: u32, hint: QualityHint) -> CoreResult<RenderedPage> {
        let (reply, answer) = mpsc::channel();
        let request = Request { path: path.to_path_buf(), page, dpi, hint, reply };
        {
            let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
            let sender = jobs
                .as_ref()
                .ok_or_else(|| CoreError::Internal("the render service has stopped".into()))?;
            sender
                .send(request)
                .map_err(|_| CoreError::Internal("the render service has stopped".into()))?;
        }
        answer
            .recv()
            .map_err(|_| CoreError::Internal("the render thread stopped before answering".into()))?
    }

    /// Stops the threads after the page being rendered. Safe to call twice.
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.jobs.lock().unwrap_or_else(|e| e.into_inner()).take();
        let handles: Vec<_> = self.workers.lock().unwrap_or_else(|e| e.into_inner()).drain(..).collect();
        for handle in handles {
            let _ = handle.join();
        }
    }
}

impl Default for RenderService {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for RenderService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn worker(rx: Arc<Mutex<Receiver<Request>>>, stopping: Arc<AtomicBool>) {
    enable_icc();
    let mut open: Option<(FileStamp, RenderDocument)> = None;
    loop {
        let request = {
            let queue = rx.lock().unwrap_or_else(|e| e.into_inner());
            match queue.recv() {
                Ok(request) => request,
                Err(_) => return,
            }
        };
        if stopping.load(Ordering::SeqCst) {
            return;
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            render_cached(&mut open, &request)
        }))
        .unwrap_or_else(|_| {
            open = None;
            Err(CoreError::Internal("rendering stopped unexpectedly".into()))
        });
        let _ = request.reply.send(result);
    }
}

fn render_cached(open: &mut Option<(FileStamp, RenderDocument)>, request: &Request) -> CoreResult<RenderedPage> {
    let stamp = FileStamp::of(&request.path)?;
    let reuse = matches!(open, Some((cached, _)) if *cached == stamp);
    if !reuse {
        // Drop the old document first: only one file stays open per worker.
        *open = None;
        let doc = RenderDocument::open(&request.path)?;
        *open = Some((stamp, doc));
    }
    match open {
        Some((_, doc)) => doc.render(request.page, request.dpi, request.hint),
        None => Err(CoreError::Internal("no document".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a4_at_72_dpi_keeps_its_size() {
        assert_eq!(effective_dpi(595.0, 842.0, 72, QualityHint::Auto), 72);
    }

    #[test]
    fn a_big_page_is_scaled_to_the_hint() {
        // 1500 x 1000 pt at 300 dpi would be 6250 px; auto allows 2048 px.
        let dpi = effective_dpi(1500.0, 1000.0, 300, QualityHint::Auto);
        assert!((MIN_DPI..300).contains(&dpi), "{dpi}");
        let px = 1500.0 * dpi as f64 / 72.0;
        assert!(px <= 2048.0, "{px}");
    }

    #[test]
    fn the_dpi_never_drops_below_the_floor() {
        assert_eq!(effective_dpi(14400.0, 14400.0, 72, QualityHint::Low), MIN_DPI);
    }

    #[test]
    fn the_pixel_ceiling_holds_even_when_the_hint_allows_more() {
        let dpi = effective_dpi(14400.0, 14400.0, 600, QualityHint::High);
        let side = 14400.0 * dpi as f64 / 72.0;
        assert!(side * side <= MAX_PIXELS, "{side}");
    }

    #[test]
    fn hints_parse_and_default_to_auto() {
        assert_eq!(QualityHint::parse("low"), QualityHint::Low);
        assert_eq!(QualityHint::parse("high"), QualityHint::High);
        assert_eq!(QualityHint::parse("whatever"), QualityHint::Auto);
    }
}
