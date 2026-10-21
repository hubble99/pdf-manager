//! PDF to Word (.docx).
//!
//! MuPDF reads each page (characters with font and position, images, vector
//! lines); [`layout`] rebuilds paragraphs, headings, lists, tables, columns and
//! image placement from that geometry; [`docx`] writes the Word package.
//!
//! The work is one page at a time: memory holds one page's content plus the
//! file handles, whatever the page count. Cancel is checked between pages.
//! The output is written to `<name>.docx.part` and renamed when complete, so a
//! failed or cancelled run never leaves a half-written .docx behind.
//!
//! Known limits (reported to the user where it matters):
//! - scanned pages have no text to extract; they come out as pictures (no OCR);
//! - tables without border lines become tab-aligned paragraphs;
//! - headers and footers become ordinary paragraphs at the top and bottom;
//! - text that Word sets wider than the PDF font can push lines onto the next
//!   page, because fonts are substituted when the PDF's font is not installed.

mod docx;
mod extract;
mod layout;
mod model;

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;

pub use docx::word_font;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfToWordReport {
    pub output_path: PathBuf,
    pub output_size_bytes: u64,
    pub pages: usize,
    /// 1-based numbers of pages that had no text layer (scans or pictures of
    /// text); their text is not editable in Word.
    pub pages_without_text: Vec<usize>,
    /// Pages whose scan picture was dropped because an invisible OCR text
    /// layer was used instead.
    pub ocr_layer_pages: Vec<usize>,
    pub tables: usize,
    pub images: usize,
    pub duration_ms: u64,
}

/// Converts `input` (a PDF) into a .docx at `output`. An existing file at
/// `output` is replaced only after the new one is complete.
pub fn convert_pdf_to_docx(input: &Path, output: &Path, ctx: &JobContext) -> CoreResult<PdfToWordReport> {
    let started = Instant::now();
    if !input.is_file() {
        return Err(CoreError::NotFound { path: input.to_path_buf() });
    }
    let input_str = input
        .to_str()
        .ok_or_else(|| CoreError::InvalidInput(format!("path is not valid Unicode: {}", input.display())))?;
    ctx.report("opening", 0, None);
    let doc = mupdf::Document::open(input_str).map_err(|e| CoreError::InvalidInput(format!("cannot open PDF: {e}")))?;
    if !doc.is_pdf() {
        return Err(CoreError::InvalidInput(format!("not a PDF: {}", input.display())));
    }
    if doc.needs_password().map_err(|e| extract::mupdf_error("password check", e))? {
        return Err(CoreError::PasswordRequired);
    }
    let page_count = doc.page_count().map_err(|e| extract::mupdf_error("page count", e))?.max(0) as usize;
    if page_count == 0 {
        return Err(CoreError::InvalidInput("the PDF has no pages".into()));
    }

    let part = part_path(output);
    let mut writer = docx::DocxWriter::create(&part)?;
    let result = (|| -> CoreResult<PdfToWordReport> {
        let mut report = PdfToWordReport { pages: page_count, ..PdfToWordReport::default() };
        ctx.report("page", 0, Some(page_count as u64));
        for i in 0..page_count {
            ctx.check_cancelled()?;
            let page = doc.load_page(i as i32).map_err(|e| extract::mupdf_error("loading page", e))?;
            let model = extract::read_page(&page)?;
            drop(page);
            let layout = layout::layout_page(&model);
            if !layout.has_text {
                report.pages_without_text.push(i + 1);
            }
            if model.has_invisible_text && model.images.iter().any(|im| im.bbox.area() >= 0.45 * model.width * model.height) {
                report.ocr_layer_pages.push(i + 1);
            }
            report.tables += layout.tables;
            report.images += layout.images;
            let images: Vec<model::EncodedImage> = model.images.into_iter().map(|im| im.image).collect();
            writer.write_page(&layout, &images, &model.fonts)?;
            ctx.report("page", (i + 1) as u64, Some(page_count as u64));
        }
        ctx.check_cancelled()?;
        ctx.report("saving", 0, None);
        Ok(report)
    })();

    match result {
        Ok(mut report) => {
            let title = input.file_stem().and_then(|s| s.to_str()).unwrap_or("Document");
            if let Err(e) = writer.finish(title) {
                let _ = std::fs::remove_file(&part);
                return Err(e);
            }
            if let Err(e) = replace_file(&part, output) {
                let _ = std::fs::remove_file(&part);
                return Err(e);
            }
            report.output_path = output.to_path_buf();
            report.output_size_bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
            report.duration_ms = started.elapsed().as_millis() as u64;
            Ok(report)
        }
        Err(e) => {
            writer.abandon();
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

fn part_path(output: &Path) -> PathBuf {
    let mut name = output.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    output.with_file_name(name)
}

fn replace_file(from: &Path, to: &Path) -> CoreResult<()> {
    // On Windows, rename does not replace an existing file.
    if to.exists() {
        std::fs::remove_file(to).map_err(|e| CoreError::io(to, e))?;
    }
    std::fs::rename(from, to).map_err(|e| CoreError::io(to, e))
}

/// A free name in `dir` for `stem.docx`: `stem.docx`, then `stem (1).docx`, ...
pub fn unique_output_path(dir: &Path, stem: &str) -> PathBuf {
    let stem = sanitize_stem(stem);
    let first = dir.join(format!("{stem}.docx"));
    if !first.exists() {
        return first;
    }
    (1..10_000)
        .map(|n| dir.join(format!("{stem} ({n}).docx")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// Removes characters Windows does not allow in file names.
pub fn sanitize_stem(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    let trimmed = trimmed.strip_suffix(".docx").map(str::to_string).unwrap_or(trimmed);
    if trimmed.is_empty() {
        "document".into()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_are_made_safe() {
        assert_eq!(sanitize_stem("a/b:c?"), "a_b_c_");
        assert_eq!(sanitize_stem("report.docx"), "report");
        assert_eq!(sanitize_stem("  "), "document");
        assert_eq!(sanitize_stem("name. "), "name");
    }

    #[test]
    fn unique_path_skips_existing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("x.docx"), b"").unwrap();
        assert_eq!(unique_output_path(dir.path(), "x"), dir.path().join("x (1).docx"));
        assert_eq!(unique_output_path(dir.path(), "y"), dir.path().join("y.docx"));
    }

    #[test]
    fn part_path_appends_suffix() {
        assert_eq!(part_path(Path::new("/tmp/a.docx")), PathBuf::from("/tmp/a.docx.part"));
    }
}
