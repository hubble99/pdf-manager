//! Merge PDFs into one.
//!
//! Files are opened by path, one at a time, and their pages are copied into a
//! new document (see [`pdf_graft`](super::pdf_graft) for how, and why not
//! MuPDF's own `insert_pdf`). Copied pages live in memory until the document is
//! saved, so after about a gigabyte of input (less on a small machine) the
//! document so far is saved to a temporary file in the output folder and
//! reopened from there: MuPDF reads a reopened file lazily, which hands the
//! memory back. Memory use is therefore bounded by that budget, not by the
//! total size of the inputs.
//!
//! The result is written as a `.part` file and renamed to a free name when
//! complete; cancelling or a failure removes it and every temporary file.
//!
//! Two policies, as before:
//!
//! - strict (`skip_invalid = false`): the first unusable file fails the merge;
//! - skipping (`skip_invalid = true`): unusable files are left out and reported.
//!
//! [`inspect`] and [`describe`] look at files without merging them, so the
//! workspace can show problems and page counts before the user commits.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use mupdf::pdf::{PdfDocument, PdfWriteOptions};
use serde::Serialize;

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;
use crate::ops::naming::{create_part, sanitize_stem, PartGuard};
use crate::ops::pdf_graft::{graft_page, internal, open, path_str, save_error, Spill};
use crate::resources::{MemoryProbe, SystemMemory, MIB};

/// Stage names used in progress reports.
pub const STAGE_FILES: &str = "files";
pub const STAGE_SAVING: &str = "saving";

const MIN_BUDGET: u64 = 256 * MIB;
const MAX_BUDGET: u64 = 1024 * MIB;

#[derive(Debug, Clone)]
pub struct MergeOptions {
    /// Leave unusable files out and report them instead of failing.
    pub skip_invalid: bool,
    pub output_dir: PathBuf,
    /// File name without extension; `merged_output` when empty.
    pub output_name: Option<String>,
    /// Bytes of input to copy before the merge so far is saved to a temporary
    /// file and reopened. `None` picks a share of the free memory (256 MiB to
    /// 1 GiB); tests set it low to exercise the flush.
    pub flush_after_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    /// Position of the file in the list that was passed in.
    pub index: usize,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    pub output_path: PathBuf,
    pub output_size_bytes: u64,
    pub total_pages: u32,
    pub merged_files: u32,
    pub skipped: Vec<SkippedFile>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub usable: u32,
    pub problems: Vec<SkippedFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Described {
    pub size_bytes: u64,
    /// `None` when the file cannot be read or is encrypted.
    pub pages: Option<u32>,
}

/// Why `path` cannot be merged, or `None` when it can.
pub fn classify(path: &Path) -> Option<&'static str> {
    classify_with(path).err()
}

fn classify_with(path: &Path) -> Result<PdfDocument, &'static str> {
    let is_pdf_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase().ends_with(".pdf"))
        .unwrap_or(false);
    if !is_pdf_name {
        return Err("not a PDF file");
    }
    if !path.exists() {
        return Err("file not found");
    }
    if !path.is_file() {
        return Err("not a file");
    }
    let doc = open(path).map_err(|_| "damaged or unreadable")?;
    if doc.needs_password().unwrap_or(true) {
        return Err("encrypted");
    }
    match doc.page_count() {
        Ok(n) if n >= 1 => Ok(doc),
        Ok(_) => Err("no pages"),
        Err(_) => Err("damaged or unreadable"),
    }
}

/// Classifies every file without merging anything.
pub fn inspect(paths: &[PathBuf], ctx: &JobContext) -> CoreResult<Inspection> {
    let mut usable = 0;
    let mut problems = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        ctx.check_cancelled()?;
        match classify_with(path) {
            Ok(_) => usable += 1,
            Err(reason) => problems.push(SkippedFile { index, reason: reason.to_string() }),
        }
    }
    Ok(Inspection { usable, problems })
}

/// Size and page count of every file, in order.
pub fn describe(paths: &[PathBuf], ctx: &JobContext) -> CoreResult<Vec<Described>> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        ctx.check_cancelled()?;
        let Ok(meta) = fs::metadata(path) else {
            out.push(Described { size_bytes: 0, pages: None });
            continue;
        };
        let pages = open(path)
            .ok()
            .filter(|doc| !doc.needs_password().unwrap_or(true))
            .and_then(|doc| doc.page_count().ok())
            .map(|n| n.max(0) as u32);
        out.push(Described { size_bytes: meta.len(), pages });
    }
    Ok(out)
}

/// How many bytes of input may be copied before the document is flushed.
pub fn flush_budget(probe: &dyn MemoryProbe) -> u64 {
    (probe.available_bytes() / 4).clamp(MIN_BUDGET, MAX_BUDGET)
}

pub fn merge(paths: &[PathBuf], options: &MergeOptions, ctx: &JobContext) -> CoreResult<MergeReport> {
    let budget = options.flush_after_bytes.unwrap_or_else(|| flush_budget(&SystemMemory::new()));
    let started = Instant::now();
    if paths.len() < 2 {
        return Err(CoreError::InvalidInput("At least 2 PDF files are required to merge.".into()));
    }
    if !options.output_dir.is_dir() {
        return Err(CoreError::NotFound { path: options.output_dir.clone() });
    }
    ctx.check_cancelled()?;

    let mut skipped: Vec<SkippedFile> = Vec::new();
    let mut queue: Vec<usize> = (0..paths.len()).collect();
    if options.skip_invalid {
        // Look at every file first, so a hopeless list fails before any work.
        let inspection = inspect(paths, ctx)?;
        if inspection.usable < 2 {
            return Err(CoreError::InvalidInput(if inspection.problems.is_empty() {
                "At least 2 PDF files are required to merge.".into()
            } else {
                "Fewer than 2 files can be merged after skipping the reported problems.".into()
            }));
        }
        queue.retain(|i| !inspection.problems.iter().any(|p| p.index == *i));
        skipped = inspection.problems;
    }

    let stem = match options.output_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => sanitize_stem(name),
        None => "merged_output".to_string(),
    };
    let (file, part) = create_part(&options.output_dir, &stem, "pdf").map_err(|e| CoreError::io(&options.output_dir, e))?;
    drop(file);
    let guard = PartGuard::new(part.clone());
    let mut spill = Spill::new(&options.output_dir, &stem);

    let mut target = PdfDocument::new();
    let total = queue.len() as u64;
    ctx.report(STAGE_FILES, 0, Some(total));
    let mut held = 0u64;
    let mut merged_files = 0u32;
    let mut done = 0u64;

    for (position, &index) in queue.iter().enumerate() {
        ctx.check_cancelled()?;
        let path = &paths[index];
        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        match copy_all_pages(&mut target, path) {
            Ok(()) => merged_files += 1,
            Err(failure) if options.skip_invalid => {
                let _ = failure;
                skipped.push(SkippedFile { index, reason: "could not be read while merging".into() });
            }
            Err(failure) => return Err(failure.into_error(path)),
        }
        done += 1;
        ctx.report(STAGE_FILES, done, Some(total));

        held += size;
        if held >= budget && position + 1 < queue.len() {
            ctx.check_cancelled()?;
            target = spill.flush(target)?;
            held = 0;
        }
    }
    if merged_files == 0 {
        return Err(CoreError::InvalidInput("None of the provided files could be merged.".into()));
    }

    ctx.check_cancelled()?;
    ctx.report(STAGE_SAVING, 0, None);
    let total_pages = target.page_count().map_err(|e| internal("page count", e))?.max(0) as u32;
    let mut write = PdfWriteOptions::default();
    write.set_garbage_level(4).set_compress(true);
    target.save_with_options(path_str(&part)?, write).map_err(|e| save_error(&part, e))?;
    // The temporary files are read by `target` until it is dropped.
    drop(target);
    spill.clean();
    ctx.check_cancelled()?;

    let output_path = guard.publish(&options.output_dir, &stem, "pdf").map_err(|e| CoreError::io(&options.output_dir, e))?;
    skipped.sort_by_key(|s| s.index);
    Ok(MergeReport {
        output_size_bytes: fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0),
        output_path,
        total_pages,
        merged_files,
        skipped,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Why one file could not be copied.
enum CopyFailure {
    NotFound,
    Encrypted,
    Unreadable(String),
}

impl CopyFailure {
    fn into_error(self, path: &Path) -> CoreError {
        let name = file_name(path);
        match self {
            CopyFailure::NotFound => CoreError::NotFound { path: path.to_path_buf() },
            CopyFailure::Encrypted => CoreError::InvalidInput(format!("'{name}' is encrypted and cannot be merged.")),
            CopyFailure::Unreadable(why) => CoreError::InvalidInput(format!("Cannot open '{name}': {why}")),
        }
    }
}

/// Copies every page of `path` to the end of `target`. A file that fails
/// part-way leaves no pages behind: the pages already added are taken out again
/// (their objects are dropped when the document is saved).
fn copy_all_pages(target: &mut PdfDocument, path: &Path) -> Result<(), CopyFailure> {
    if !path.exists() {
        return Err(CopyFailure::NotFound);
    }
    let source = open(path).map_err(|e| CopyFailure::Unreadable(e.to_string()))?;
    if source.needs_password().map_err(|e| CopyFailure::Unreadable(e.to_string()))? {
        return Err(CopyFailure::Encrypted);
    }
    let pages = source.page_count().map_err(|e| CopyFailure::Unreadable(e.to_string()))?;
    if pages < 1 {
        return Err(CopyFailure::Unreadable("the document has no pages".into()));
    }
    let before = target.page_count().map_err(|e| CopyFailure::Unreadable(e.to_string()))?;
    let mut map = target.new_graft_map().map_err(|e| CopyFailure::Unreadable(e.to_string()))?;
    for index in 0..pages {
        if let Err(e) = graft_page(target, &mut map, &source, index) {
            // Take back the pages already added from this file.
            for _ in 0..index {
                let _ = target.delete_page(before);
            }
            return Err(CopyFailure::Unreadable(e.to_string()));
        }
    }
    Ok(())
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}
