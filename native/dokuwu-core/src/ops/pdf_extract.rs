//! Extract pages from a PDF.
//!
//! Four ways to write the selection:
//!
//! - `combine`: one PDF with the pages in the order typed (`3,1-2` gives 3, 1, 2);
//! - `separate_page`: one PDF per page, in a ZIP;
//! - `separate_range`: one PDF per comma-separated range, in a ZIP;
//! - `split_all`: one PDF per page of the whole document, in a ZIP (the ranges
//!   are ignored).
//!
//! Each output is its own document, built from a shared copy map (see
//! [`pdf_graft`](super::pdf_graft)) and handed to the ZIP before the next one is
//! started, so memory holds one output at a time, whatever the number of pages.
//! `combine` flushes through a temporary file like Merge when the selection is
//! large. Encrypted documents are refused.
//!
//! The result is written as a `.part` file and renamed to a free name when
//! complete; cancelling or a failure removes it.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use mupdf::pdf::{PdfDocument, PdfWriteOptions};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;
use crate::ops::naming::{create_part, sanitize_stem, PartGuard};
use crate::ops::page_ranges;
use crate::ops::pdf_graft::{graft_page, internal, open, path_str, save_error, Spill};
use crate::ops::zip_stream::ZipWriter;
use crate::ops::pdf_merge::flush_budget;
use crate::resources::SystemMemory;

pub const STAGE_PAGES: &str = "pages";
pub const STAGE_SAVING: &str = "saving";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractMode {
    Combine,
    SeparatePage,
    SeparateRange,
    SplitAll,
}

impl ExtractMode {
    pub fn is_zip(self) -> bool {
        self != ExtractMode::Combine
    }
}

#[derive(Debug, Clone)]
pub struct ExtractOptions {
    pub mode: ExtractMode,
    /// `1-3,5,7-9`; ignored by `split_all`.
    pub page_ranges: String,
    pub output_dir: PathBuf,
    /// File name without extension; `extracted_<input name>` when empty.
    pub output_name: Option<String>,
    /// For `combine`: bytes of input to copy before the pages so far are saved
    /// to a temporary file and reopened. `None` picks a share of the free memory
    /// (256 MiB to 1 GiB); tests set it low to exercise the flush.
    pub flush_after_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractReport {
    pub output_path: PathBuf,
    pub output_size_bytes: u64,
    /// Pages written, over all output files.
    pub pages_extracted: u32,
    /// PDFs in the output: 1 for `combine`, the ZIP's entries otherwise.
    pub files: u32,
    pub is_zip: bool,
    pub duration_ms: u64,
}

pub fn extract(input: &Path, options: &ExtractOptions, ctx: &JobContext) -> CoreResult<ExtractReport> {
    let budget = options.flush_after_bytes.unwrap_or_else(|| flush_budget(&SystemMemory::new()));
    let started = Instant::now();
    if !options.output_dir.is_dir() {
        return Err(CoreError::NotFound { path: options.output_dir.clone() });
    }
    ctx.check_cancelled()?;
    let size = fs::metadata(input).map_err(|e| CoreError::io(input, e))?.len();
    let source = open(input).map_err(|e| CoreError::InvalidInput(format!("Cannot open PDF: {e}")))?;
    if source.needs_password().map_err(|e| internal("password check", e))? {
        return Err(CoreError::PasswordRequired);
    }
    let total = source.page_count().map_err(|e| internal("page count", e))?.max(0) as u32;
    if total == 0 {
        return Err(CoreError::InvalidInput("the document has no pages".into()));
    }

    // 1-based groups; one output per group, except `combine` which joins them.
    let groups: Vec<Vec<u32>> = match options.mode {
        ExtractMode::SplitAll => (1..=total).map(|p| vec![p]).collect(),
        ExtractMode::SeparatePage => {
            let mut pages: Vec<u32> = page_ranges::parse_groups(&options.page_ranges, total)?.into_iter().flatten().collect();
            pages.sort_unstable();
            pages.dedup();
            pages.into_iter().map(|p| vec![p]).collect()
        }
        ExtractMode::Combine | ExtractMode::SeparateRange => page_ranges::parse_groups(&options.page_ranges, total)?,
    };

    let base = match options.output_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => sanitize_stem(name),
        None => {
            let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            format!("extracted_{}", sanitize_stem(&stem))
        }
    };
    let ext = if options.mode.is_zip() { "zip" } else { "pdf" };
    let (file, part) = create_part(&options.output_dir, &base, ext).map_err(|e| CoreError::io(&options.output_dir, e))?;
    let guard = PartGuard::new(part.clone());

    let (pages_extracted, files) = if options.mode == ExtractMode::Combine {
        drop(file);
        let pages = combine(&source, size, total, &groups, &part, &options.output_dir, &base, ctx, budget)?;
        (pages, 1)
    } else {
        write_zip(&source, &groups, options.mode, &base, file, &part, ctx)?
    };
    drop(source);
    ctx.check_cancelled()?;

    let output_path = guard.publish(&options.output_dir, &base, ext).map_err(|e| CoreError::io(&options.output_dir, e))?;
    Ok(ExtractReport {
        output_size_bytes: fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0),
        output_path,
        pages_extracted,
        files,
        is_zip: options.mode.is_zip(),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn write_options() -> PdfWriteOptions {
    let mut write = PdfWriteOptions::default();
    write.set_garbage_level(4).set_compress(true);
    write
}

#[allow(clippy::too_many_arguments)]
fn combine(
    source: &PdfDocument,
    source_size: u64,
    total: u32,
    groups: &[Vec<u32>],
    part: &Path,
    dir: &Path,
    base: &str,
    ctx: &JobContext,
    budget: u64,
) -> CoreResult<u32> {
    let pages: Vec<u32> = groups.iter().flatten().copied().collect();
    let count = pages.len() as u64;
    // Bytes copied so far, estimated as the file's share taken by the selection.
    let per_page = source_size / total.max(1) as u64;
    let mut target = PdfDocument::new();
    let mut map = target.new_graft_map().map_err(|e| internal("copy map", e))?;
    let mut spill = Spill::new(dir, base);
    let mut held = 0u64;
    ctx.report(STAGE_PAGES, 0, Some(count));
    for (done, &page) in pages.iter().enumerate() {
        ctx.check_cancelled()?;
        graft_page(&mut target, &mut map, source, page as i32 - 1).map_err(|e| internal(&format!("cannot copy page {page}"), e))?;
        ctx.report(STAGE_PAGES, done as u64 + 1, Some(count));
        held += per_page;
        if held >= budget && done + 1 < pages.len() {
            target = spill.flush(target)?;
            // The old copy map points into the document that was just saved.
            map = target.new_graft_map().map_err(|e| internal("copy map", e))?;
            held = 0;
        }
    }
    ctx.check_cancelled()?;
    ctx.report(STAGE_SAVING, 0, None);
    target.save_with_options(path_str(part)?, write_options()).map_err(|e| save_error(part, e))?;
    drop(target);
    spill.clean();
    Ok(pages.len() as u32)
}

fn write_zip(
    source: &PdfDocument,
    groups: &[Vec<u32>],
    mode: ExtractMode,
    base: &str,
    file: File,
    part: &Path,
    ctx: &JobContext,
) -> CoreResult<(u32, u32)> {
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let total = groups.len() as u64;
    ctx.report(STAGE_PAGES, 0, Some(total));
    let mut used = HashSet::new();
    let mut pages_written = 0u32;
    for (done, group) in groups.iter().enumerate() {
        ctx.check_cancelled()?;
        let bytes = build_part(source, group)?;
        let name = unique_entry(&mut used, &entry_name(base, mode, group));
        zip.add(&name, &bytes).map_err(|e| CoreError::io(part, e))?;
        pages_written += group.len() as u32;
        ctx.report(STAGE_PAGES, done as u64 + 1, Some(total));
    }
    let mut out = zip.finish().map_err(|e| CoreError::io(part, e))?;
    out.flush().map_err(|e| CoreError::io(part, e))?;
    Ok((pages_written, groups.len() as u32))
}

/// One output PDF holding `pages` (1-based) of `source`, as bytes.
fn build_part(source: &PdfDocument, pages: &[u32]) -> CoreResult<Vec<u8>> {
    let mut target = PdfDocument::new();
    let mut map = target.new_graft_map().map_err(|e| internal("copy map", e))?;
    for &page in pages {
        graft_page(&mut target, &mut map, source, page as i32 - 1).map_err(|e| internal(&format!("cannot copy page {page}"), e))?;
    }
    let mut bytes = Vec::new();
    target.write_to_with_options(&mut bytes, write_options()).map_err(|e| internal("cannot write part", e))?;
    Ok(bytes)
}

/// `<base>_page0003.pdf` for single pages, `<base>_p3.pdf` or `<base>_p3-7.pdf`
/// for ranges (also what `split_all` gives).
fn entry_name(base: &str, mode: ExtractMode, group: &[u32]) -> String {
    match mode {
        ExtractMode::SeparatePage => format!("{base}_page{:04}.pdf", group[0]),
        _ if group.len() == 1 => format!("{base}_p{}.pdf", group[0]),
        _ => format!("{base}_p{}-{}.pdf", group[0], group[group.len() - 1]),
    }
}

/// Entries of a ZIP must be distinct to be extractable: `1,1` would otherwise
/// write the same name twice.
fn unique_entry(used: &mut HashSet<String>, name: &str) -> String {
    if used.insert(name.to_string()) {
        return name.to_string();
    }
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    (2..)
        .map(|n| format!("{stem} ({n}).{ext}"))
        .find(|candidate| used.insert(candidate.clone()))
        .expect("an unused name exists")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_names_follow_the_old_scheme() {
        assert_eq!(entry_name("doc", ExtractMode::SeparatePage, &[3]), "doc_page0003.pdf");
        assert_eq!(entry_name("doc", ExtractMode::SeparateRange, &[3]), "doc_p3.pdf");
        assert_eq!(entry_name("doc", ExtractMode::SeparateRange, &[3, 4, 5]), "doc_p3-5.pdf");
        assert_eq!(entry_name("doc", ExtractMode::SplitAll, &[12]), "doc_p12.pdf");
    }

    #[test]
    fn repeated_entries_get_numbers() {
        let mut used = HashSet::new();
        assert_eq!(unique_entry(&mut used, "a_p1.pdf"), "a_p1.pdf");
        assert_eq!(unique_entry(&mut used, "a_p1.pdf"), "a_p1 (2).pdf");
        assert_eq!(unique_entry(&mut used, "a_p1.pdf"), "a_p1 (3).pdf");
    }
}
