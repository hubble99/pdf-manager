//! Compress PDF.
//!
//! Re-encodes the PDF's ordinary pictures as JPEG at the chosen quality and
//! rewrites the file with unused objects removed, duplicate streams merged (see
//! [`dedupe`]) and streams deflated. The result is never larger than the input: when nothing
//! gets smaller the original is copied unchanged.
//!
//! Dokuwu puts no limit on file size, so memory use does not follow it:
//!
//! - MuPDF opens the file lazily; objects and streams are read on demand.
//! - Images are decoded one at a time and encoded on a few worker threads. The
//!   number of workers comes from free RAM, and the bytes in flight are capped.
//! - Re-encoded streams are held by MuPDF until saved, so they are flushed to a
//!   working copy in batches (`save` with the incremental option, then reopen).
//!   Small files skip this and are saved once.
//! - A [`MemoryBrake`] pauses the job while the machine is short of memory.
//!
//! The output is written to `<name>.pdf.part` and renamed when complete, so a
//! failed or cancelled run leaves no output file.

mod dedupe;
mod image;

use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use mupdf::pdf::{PdfDocument, PdfWriteOptions};
use serde::Serialize;

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;
use crate::resources::{worker_count, MemoryBrake, MemoryProbe, SystemMemory, MIB};

use image::{ImageSpec, Scanned};

pub const MIN_QUALITY: u8 = 10;
pub const MAX_QUALITY: u8 = 95;

/// Memory left for the app and the rest of the system.
const RESERVE_BYTES: u64 = 512 * MIB;
/// Free memory below which the job waits before reading the next image.
const BRAKE_FLOOR_BYTES: u64 = 256 * MIB;
/// Typical peak of one encoder worker, used to size the pool.
const PER_WORKER_BYTES: u64 = 96 * MIB;
const MAX_WORKERS: usize = 8;
const COPY_CHUNK: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct CompressOptions {
    /// JPEG quality for re-encoded images, 10 to 95.
    pub quality: u8,
    /// Also clean up page content streams (merge pieces, drop redundant
    /// operators). The old engine did, so it is on by default.
    pub clean_content: bool,
    /// Override the batch size (bytes of re-encoded images held before a
    /// flush). `None` derives it from free memory. For tests and diagnostics.
    pub batch_bytes: Option<u64>,
    /// Override the worker count. For tests and diagnostics.
    pub max_workers: Option<usize>,
}

impl CompressOptions {
    pub fn new(quality: u8) -> Self {
        Self { quality, clean_content: true, batch_bytes: None, max_workers: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfCompressReport {
    pub output_path: PathBuf,
    pub size_before: u64,
    pub size_after: u64,
    /// 0 when the file could not be made smaller.
    pub reduction_pct: f64,
    pub pages: u32,
    /// Pictures that were eligible for re-encoding.
    pub images_found: u32,
    /// Pictures actually replaced by a smaller JPEG.
    pub images_recompressed: u32,
    /// Eligible pictures that failed to decode or did not shrink.
    pub images_unchanged: u32,
    /// True when the result was not smaller and the original was copied.
    pub kept_original: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfProbe {
    pub size_bytes: u64,
    pub pages: u32,
    /// The PDF needs a password to open.
    pub encrypted: bool,
}

/// Size, page count and protection of a PDF, without reading its content.
pub fn probe_pdf(path: &Path) -> CoreResult<PdfProbe> {
    let size_bytes = file_size(path)?;
    let doc = open_pdf(path)?;
    let encrypted = is_encrypted(&doc)?;
    let pages = if encrypted { 0 } else { page_count(&doc) };
    Ok(PdfProbe { size_bytes, pages, encrypted })
}

pub fn compress_pdf(
    input: &Path,
    output: &Path,
    options: &CompressOptions,
    ctx: &JobContext,
) -> CoreResult<PdfCompressReport> {
    compress_pdf_with(input, output, options, ctx, Arc::new(SystemMemory::new()))
}

/// [`compress_pdf`] with a given source of memory figures (tests inject fakes).
pub fn compress_pdf_with(
    input: &Path,
    output: &Path,
    options: &CompressOptions,
    ctx: &JobContext,
    probe: Arc<dyn MemoryProbe>,
) -> CoreResult<PdfCompressReport> {
    if !(MIN_QUALITY..=MAX_QUALITY).contains(&options.quality) {
        return Err(CoreError::InvalidInput(format!(
            "quality must be between {MIN_QUALITY} and {MAX_QUALITY} (got {})",
            options.quality
        )));
    }
    let started = Instant::now();
    let size_before = file_size(input)?;
    ctx.report("opening", 0, None);

    let part = part_path(output);
    let result = run(input, output, &part, size_before, options, ctx, probe);
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    let mut report = result?;
    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

struct Counts {
    found: u32,
    recompressed: u32,
}

fn run(
    input: &Path,
    output: &Path,
    part: &Path,
    size_before: u64,
    options: &CompressOptions,
    ctx: &JobContext,
    probe: Arc<dyn MemoryProbe>,
) -> CoreResult<PdfCompressReport> {
    // Declared before `doc` so that, on an early return, the document is
    // dropped (and its file closed) before the working folder is removed;
    // Windows cannot delete a file that is still open.
    let mut work_dir: Option<WorkDir> = None;
    let mut doc = open_pdf(input)?;
    if is_encrypted(&doc)? {
        return Err(CoreError::PasswordRequired);
    }
    let pages = page_count(&doc);

    let batch_bytes = options.batch_bytes.unwrap_or_else(|| {
        (probe.available_bytes() / 32).clamp(32 * MIB, 128 * MIB)
    });
    // A file smaller than one batch can never hold more re-encoded data than a
    // batch, so it is edited in memory and saved once. A bigger one is edited
    // on a working copy that receives incremental saves.
    let mut working_file: Option<PathBuf> = None;
    if size_before >= batch_bytes {
        let work = WorkDir::create()?;
        let mut file = work.path("work.pdf");
        copy_file(input, &file, ctx)?;
        doc = open_pdf(&file)?;
        if !doc.can_be_saved_incrementally() {
            // A damaged file MuPDF had to repair: rewrite it once so later
            // batches can be appended to it.
            let rewritten = work.path("clean.pdf");
            doc.save_with_options(path_str(&rewritten)?, PdfWriteOptions::default())
                .map_err(|e| save_error("preparing a working copy", e))?;
            doc = open_pdf(&rewritten)?;
            let _ = fs::remove_file(&file);
            file = rewritten;
        }
        working_file = Some(file);
        work_dir = Some(work);
    }

    let merged = dedupe::merge_duplicate_streams(&doc, ctx)?;
    let mut candidates = find_candidates(&doc, ctx)?;
    candidates.retain(|spec| !merged.removed.contains(&spec.xref));
    let counts = recompress_images(
        &mut doc,
        &candidates,
        working_file.as_deref(),
        batch_bytes,
        options,
        ctx,
        &probe,
    )?;

    ctx.check_cancelled()?;
    ctx.report("saving", 0, None);
    let mut write = PdfWriteOptions::default();
    write
        .set_garbage_level(2)
        .set_compress(true)
        .set_compress_images(true)
        .set_compress_fonts(true)
        .set_clean(options.clean_content)
        .set_sanitize(options.clean_content);
    doc.save_with_options(path_str(part)?, write)
        .map_err(|e| save_error("writing the compressed PDF", e))?;
    drop(doc);
    drop(work_dir);
    ctx.check_cancelled()?;

    let size_after = file_size(part)?;
    let kept_original = size_after >= size_before;
    let final_size = if kept_original {
        // Nothing got smaller: hand back the original rather than a bigger file.
        copy_file(input, part, ctx)?;
        size_before
    } else {
        size_after
    };
    replace_file(part, output)?;
    ctx.report("saving", 1, Some(1));

    let reduction_pct = if kept_original || size_before == 0 {
        0.0
    } else {
        ((1.0 - final_size as f64 / size_before as f64) * 1000.0).round() / 10.0
    };
    Ok(PdfCompressReport {
        output_path: output.to_path_buf(),
        size_before,
        size_after: final_size,
        reduction_pct,
        pages,
        images_found: counts.found,
        images_recompressed: counts.recompressed,
        images_unchanged: counts.found - counts.recompressed,
        kept_original,
        duration_ms: 0,
    })
}

/// Walks every object once and returns the pictures worth re-encoding, in file
/// order. Soft masks are excluded: they are transparency data and must stay
/// exactly as they are.
fn find_candidates(doc: &PdfDocument, ctx: &JobContext) -> CoreResult<Vec<ImageSpec>> {
    let total = doc.count_objects().map_err(|e| mupdf_error("counting objects", e))? as u64;
    let mut specs = Vec::new();
    let mut masks = std::collections::HashSet::new();
    for xref in 1..total as i32 {
        if xref % 256 == 0 {
            ctx.check_cancelled()?;
            ctx.report("scanning", xref as u64, Some(total));
        }
        if let Scanned::Image { spec, soft_mask } = image::scan_object(doc, xref) {
            if let Some(m) = soft_mask {
                masks.insert(m);
            }
            if let Some(spec) = spec {
                specs.push(spec);
            }
        }
    }
    specs.retain(|s| !masks.contains(&s.xref));
    Ok(specs)
}

struct Job {
    spec: ImageSpec,
    samples: Vec<u8>,
    quality: u8,
}

struct Outcome {
    spec: ImageSpec,
    /// `Ok(None)`: encoded but not smaller. `Err`: could not be encoded.
    jpeg: Result<Option<Vec<u8>>, String>,
    held_bytes: u64,
}

fn recompress_images(
    doc: &mut PdfDocument,
    candidates: &[ImageSpec],
    working_file: Option<&Path>,
    batch_bytes: u64,
    options: &CompressOptions,
    ctx: &JobContext,
    probe: &Arc<dyn MemoryProbe>,
) -> CoreResult<Counts> {
    let found = candidates.len() as u32;
    let mut counts = Counts { found, recompressed: 0 };
    if candidates.is_empty() {
        return Ok(counts);
    }

    let workers = options
        .max_workers
        .unwrap_or_else(|| worker_count(probe.as_ref(), PER_WORKER_BYTES, RESERVE_BYTES, MAX_WORKERS))
        .max(1);
    // Cap on decoded bytes being worked on at once, whatever the worker count.
    let in_flight_cap = (probe.available_bytes() / 8).clamp(96 * MIB, 768 * MIB);
    let brake = MemoryBrake::new(probe.clone(), BRAKE_FLOOR_BYTES);
    let total = candidates.len() as u64;

    thread::scope(|scope| -> CoreResult<()> {
        let (job_tx, job_rx) = mpsc::channel::<Job>();
        let job_rx = Arc::new(Mutex::new(job_rx));
        let (out_tx, out_rx) = mpsc::channel::<Outcome>();
        for _ in 0..workers {
            let job_rx = job_rx.clone();
            let out_tx = out_tx.clone();
            scope.spawn(move || loop {
                let job = match job_rx.lock().unwrap_or_else(|e| e.into_inner()).recv() {
                    Ok(job) => job,
                    Err(_) => break,
                };
                let held_bytes = job.spec.sample_bytes() * 3 + job.spec.stored_len;
                let jpeg = catch_unwind(AssertUnwindSafe(|| {
                    image::encode_if_smaller(&job.samples, &job.spec, job.quality)
                }))
                .unwrap_or_else(|_| Err("encoder panicked".into()));
                drop(job.samples);
                if out_tx.send(Outcome { spec: job.spec, jpeg, held_bytes }).is_err() {
                    break;
                }
            });
        }
        drop(out_tx);

        let mut state = Pipeline {
            doc,
            counts: &mut counts,
            in_flight: 0,
            in_flight_bytes: 0,
            pending_bytes: 0,
            done: 0,
            total,
            ctx,
        };
        let result = (|| -> CoreResult<()> {
            ctx.report("images", 0, Some(total));
            for spec in candidates {
                ctx.check_cancelled()?;
                let est = spec.sample_bytes() * 3 + spec.stored_len;

                while state.in_flight > 0
                    && (state.in_flight >= workers || state.in_flight_bytes + est > in_flight_cap)
                {
                    state.receive_one(&out_rx)?;
                }
                if let Some(work) = working_file {
                    if state.pending_bytes >= batch_bytes {
                        state.drain(&out_rx)?;
                        state.flush(work)?;
                    }
                }

                brake.wait_for_headroom(ctx)?;
                // One picture too big for the memory that is left, even alone:
                // leave it as it is.
                if state.in_flight == 0 && est > probe.available_bytes().saturating_sub(BRAKE_FLOOR_BYTES) {
                    state.skip();
                    continue;
                }
                let samples = match state.read_samples(spec) {
                    Some(samples) => samples,
                    None => {
                        state.skip();
                        continue;
                    }
                };
                state.in_flight += 1;
                state.in_flight_bytes += est;
                if job_tx.send(Job { spec: *spec, samples, quality: options.quality }).is_err() {
                    return Err(CoreError::Internal("image workers stopped".into()));
                }
            }
            state.drain(&out_rx)
        })();
        drop(job_tx);
        result
    })?;
    Ok(counts)
}

struct Pipeline<'a> {
    doc: &'a mut PdfDocument,
    counts: &'a mut Counts,
    in_flight: usize,
    in_flight_bytes: u64,
    /// Bytes of re-encoded images MuPDF holds that are not saved yet.
    pending_bytes: u64,
    done: u64,
    total: u64,
    ctx: &'a JobContext,
}

impl Pipeline<'_> {
    fn skip(&mut self) {
        self.done += 1;
        self.ctx.report("images", self.done, Some(self.total));
    }

    /// Decoded samples of one picture, or `None` if it cannot be decoded to the
    /// size its dictionary promises.
    fn read_samples(&self, spec: &ImageSpec) -> Option<Vec<u8>> {
        let obj = self.doc.new_indirect(spec.xref, 0).ok()?;
        let samples = obj.read_stream().ok()?;
        (samples.len() as u64 == spec.sample_bytes()).then_some(samples)
    }

    fn receive_one(&mut self, out_rx: &mpsc::Receiver<Outcome>) -> CoreResult<()> {
        let outcome = out_rx
            .recv()
            .map_err(|_| CoreError::Internal("image workers stopped".into()))?;
        self.in_flight -= 1;
        self.in_flight_bytes = self.in_flight_bytes.saturating_sub(outcome.held_bytes);
        if let Ok(Some(jpeg)) = &outcome.jpeg {
            // A picture MuPDF cannot update is left as it was.
            if image::apply_jpeg(self.doc, outcome.spec.xref, jpeg).is_ok() {
                self.counts.recompressed += 1;
                self.pending_bytes += jpeg.len() as u64;
            }
        }
        self.skip();
        Ok(())
    }

    fn drain(&mut self, out_rx: &mpsc::Receiver<Outcome>) -> CoreResult<()> {
        while self.in_flight > 0 {
            self.receive_one(out_rx)?;
        }
        Ok(())
    }

    /// Appends the pending changes to the working copy and reopens it, which
    /// releases the memory MuPDF held for the new streams.
    fn flush(&mut self, work: &Path) -> CoreResult<()> {
        let mut options = PdfWriteOptions::default();
        options.set_incremental(true);
        self.doc
            .save_with_options(path_str(work)?, options)
            .map_err(|e| save_error("saving a batch", e))?;
        *self.doc = open_pdf(work)?;
        self.pending_bytes = 0;
        Ok(())
    }
}

// ── files ────────────────────────────────────────────────────────────────

fn open_pdf(path: &Path) -> CoreResult<PdfDocument> {
    PdfDocument::open(path_str(path)?).map_err(|e| CoreError::InvalidInput(format!("cannot open PDF: {e}")))
}

/// True when the PDF cannot be read without a password. A PDF that is only
/// permission-restricted (owner password, empty open password) opens as
/// usual, like it does in any viewer.
fn is_encrypted(doc: &PdfDocument) -> CoreResult<bool> {
    doc.needs_password().map_err(|e| mupdf_error("password check", e))
}

fn page_count(doc: &PdfDocument) -> u32 {
    doc.page_count().unwrap_or(0).max(0) as u32
}

fn mupdf_error(context: &str, err: mupdf::Error) -> CoreError {
    CoreError::Internal(format!("{context}: {err}"))
}

fn save_error(context: &str, err: mupdf::Error) -> CoreError {
    CoreError::Internal(format!("{context}: {err}"))
}

fn path_str(path: &Path) -> CoreResult<&str> {
    path.to_str()
        .ok_or_else(|| CoreError::InvalidInput(format!("path is not valid text: {}", path.display())))
}

fn file_size(path: &Path) -> CoreResult<u64> {
    let meta = fs::metadata(path).map_err(|e| CoreError::io(path, e))?;
    if !meta.is_file() {
        return Err(CoreError::InvalidInput(format!("not a file: {}", path.display())));
    }
    Ok(meta.len())
}

/// Copies in chunks so a big file can still be cancelled part way.
fn copy_file(from: &Path, to: &Path, ctx: &JobContext) -> CoreResult<()> {
    let mut src = File::open(from).map_err(|e| CoreError::io(from, e))?;
    let mut dst = File::create(to).map_err(|e| CoreError::io(to, e))?;
    let mut buf = vec![0u8; COPY_CHUNK];
    loop {
        ctx.check_cancelled()?;
        let n = match src.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(CoreError::io(from, e)),
        };
        dst.write_all(&buf[..n]).map_err(|e| CoreError::io(to, e))?;
    }
    dst.flush().map_err(|e| CoreError::io(to, e))
}

fn part_path(output: &Path) -> PathBuf {
    let mut name = output.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

fn replace_file(from: &Path, to: &Path) -> CoreResult<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // Some platforms refuse to rename over an existing file.
    let _ = fs::remove_file(to);
    fs::rename(from, to).map_err(|e| CoreError::io(to, e))
}

/// A scratch folder for the working copy, removed when dropped.
struct WorkDir(PathBuf);

static WORKDIR_SEQ: AtomicU64 = AtomicU64::new(0);

impl WorkDir {
    fn create() -> CoreResult<Self> {
        let dir = std::env::temp_dir().join(format!(
            "{}compress-{}-{}",
            crate::ops::housekeeping::SCRATCH_PREFIX,
            std::process::id(),
            WORKDIR_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
        Ok(Self(dir))
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        // A virus scanner or indexer can hold a freshly written file for a
        // moment on Windows, so retry briefly before giving up.
        for attempt in 0..10 {
            if fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                return;
            }
            if attempt < 9 {
                thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

/// Picks `<stem>.pdf` in `dir`, or `<stem> (1).pdf`, `<stem> (2).pdf`, ... if
/// that name is taken, so an existing file is never overwritten.
pub fn unique_output_path(dir: &Path, stem: &str) -> PathBuf {
    let stem = sanitize_stem(stem);
    let first = dir.join(format!("{stem}.pdf"));
    if !first.exists() {
        return first;
    }
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}).pdf")))
        .find(|p| !p.exists())
        .expect("an unused name exists")
}

fn sanitize_stem(stem: &str) -> String {
    let stem = stem.trim();
    let stem = stem
        .strip_suffix(".pdf")
        .or_else(|| stem.strip_suffix(".PDF"))
        .unwrap_or(stem);
    let cleaned: String = stem
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim().to_string();
    if cleaned.is_empty() {
        "compressed".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_path_appends_suffix() {
        assert_eq!(part_path(Path::new("/tmp/a.pdf")), PathBuf::from("/tmp/a.pdf.part"));
    }

    #[test]
    fn stems_are_cleaned() {
        assert_eq!(sanitize_stem("  report.pdf "), "report");
        assert_eq!(sanitize_stem("a/b:c"), "a_b_c");
        assert_eq!(sanitize_stem("..."), "compressed");
        assert_eq!(sanitize_stem(""), "compressed");
    }

    #[test]
    fn scratch_folder_name_is_recognised_by_housekeeping() {
        use crate::ops::housekeeping::SCRATCH_PREFIX;
        let work = WorkDir::create().unwrap();
        let name = work.0.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(SCRATCH_PREFIX));
        // The exit sweep selects folders by the process id in the name.
        assert_eq!(name.split('-').nth(2), Some(std::process::id().to_string().as_str()));
    }

    #[test]
    fn unique_path_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let first = unique_output_path(dir.path(), "x");
        assert_eq!(first, dir.path().join("x.pdf"));
        fs::write(&first, b"1").unwrap();
        let second = unique_output_path(dir.path(), "x");
        assert_eq!(second, dir.path().join("x (1).pdf"));
        fs::write(&second, b"2").unwrap();
        assert_eq!(unique_output_path(dir.path(), "x.pdf"), dir.path().join("x (2).pdf"));
    }

    #[test]
    fn quality_outside_range_is_rejected() {
        for q in [0, 9, 96, 255] {
            let err = compress_pdf(
                Path::new("missing.pdf"),
                Path::new("out.pdf"),
                &CompressOptions::new(q),
                &JobContext::detached(),
            )
            .unwrap_err();
            assert_eq!(err.code(), "invalid_input", "quality {q}");
        }
    }
}
