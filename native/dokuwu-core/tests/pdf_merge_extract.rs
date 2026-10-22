//! Merge PDF and Extract pages (`ops::pdf_merge`, `ops::pdf_extract`).
//!
//! The PDFs are built here with the things that make copying pages hard:
//! attributes inherited from the page tree (page size, rotation, fonts),
//! rotated pages, a crop box away from the origin, a media box that does not
//! start at 0,0, and annotations that point back at pages. A copied page must
//! render exactly like the original.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use dokuwu_core::job::{CancelToken, JobContext};
use dokuwu_core::ops::pdf_extract::{extract, ExtractMode, ExtractOptions};
use dokuwu_core::ops::pdf_merge::{classify, describe, inspect, merge, MergeOptions};
use dokuwu_core::ops::pdf_render::RenderDocument;
use mupdf::pdf::PdfDocument;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf-compress").join(name)
}

/// A PDF of `count` pages tagged `tag`. Page sizes, rotation and fonts come
/// from the page tree for most pages; page 2 is rotated, page 3 has its own
/// media box and an off-centre crop box, page 4 has a media box that does not
/// start at the origin and is rotated the other way. Page 1 has a web link, a
/// link to page 2, a highlight with a pop-up, and a sticky note.
fn rich_pdf(tag: &str, count: usize) -> Vec<u8> {
    let mut objects: Vec<String> = Vec::new();
    // 1 catalog, 2 page tree, 3 font, 4 URI link, 5 page link, 6 highlight, 7 popup, 8 note; pages follow.
    let first = 9;
    objects.push("<< /Type /Catalog /Pages 2 0 R >>".into());
    let kids: Vec<String> = (0..count).map(|i| format!("{} 0 R", first + i * 2)).collect();
    objects.push(format!(
        "<< /Type /Pages /Kids [{}] /Count {count} /MediaBox [0 0 300 200] /Rotate 0 /Resources << /Font << /F1 3 0 R >> >> >>",
        kids.join(" ")
    ));
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into());
    objects.push(format!(
        "<< /Type /Annot /Subtype /Link /Rect [10 10 100 30] /Border [0 0 0] /A << /S /URI /URI (https://example.org/{tag}) >> /P {first} 0 R >>"
    ));
    objects.push(format!(
        "<< /Type /Annot /Subtype /Link /Rect [10 40 100 60] /Border [0 0 0] /Dest [{} 0 R /Fit] /P {first} 0 R >>",
        first + 2
    ));
    objects.push(format!(
        "<< /Type /Annot /Subtype /Highlight /Rect [20 100 120 124] /QuadPoints [20 124 120 124 20 100 120 100] /C [1 1 0] /Popup 7 0 R /P {first} 0 R /T (note) >>"
    ));
    objects.push(format!("<< /Type /Annot /Subtype /Popup /Rect [200 100 280 180] /Parent 6 0 R /P {first} 0 R >>"));
    objects.push(format!(
        "<< /Type /Annot /Subtype /Text /Rect [250 150 270 170] /Contents (sticky) /C [1 0 0] /Name /Note /P {first} 0 R >>"
    ));
    for i in 0..count {
        let n = i + 1;
        let content = format!(
            "{:.2} {:.2} 0.2 rg {} {} 60 40 re f BT /F1 18 Tf {} {} Td ({tag} page {n}) Tj ET",
            (n as f32 * 0.37) % 1.0,
            (n as f32 * 0.61) % 1.0,
            if n == 4 { 120 } else { 30 },
            if n == 4 { 120 } else { 30 },
            if n == 4 { 120 } else { 20 },
            if n == 4 { 170 } else { 100 },
        );
        let mut dict = format!("<< /Type /Page /Parent 2 0 R /Contents {} 0 R", first + i * 2 + 1);
        match n % 5 {
            2 => dict.push_str(" /Rotate 90"),
            3 => dict.push_str(" /MediaBox [0 0 400 300] /CropBox [50 40 350 260]"),
            4 => dict.push_str(" /MediaBox [100 100 400 300] /Rotate 270"),
            _ => {}
        }
        if n == 1 {
            dict.push_str(" /Annots [4 0 R 5 0 R 6 0 R 7 0 R 8 0 R]");
        }
        dict.push_str(" >>");
        objects.push(dict);
        objects.push(format!("<< /Length {} >>\nstream\n{}\nendstream", content.len(), content));
    }
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, body).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n", objects.len() + 1, xref).as_bytes());
    out
}

fn write_rich(dir: &Path, name: &str, tag: &str, count: usize) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, rich_pdf(tag, count)).unwrap();
    path
}

/// Page `page` (1-based) rendered at 72 dpi: width, height, packed RGB.
fn render(path: &Path, page: u32) -> (u32, u32, Vec<u8>) {
    RenderDocument::open(path)
        .unwrap()
        .render_rgb(page, 72, |view| Ok((view.width, view.height, view.packed().into_owned())))
        .unwrap()
}

fn page_count(path: &Path) -> u32 {
    RenderDocument::open(path).unwrap().page_count()
}

/// The numbers of the annotations on page `page` (1-based), as subtype names.
fn annotation_subtypes(path: &Path, page: i32) -> Vec<String> {
    let doc = PdfDocument::open(path.to_str().unwrap()).unwrap();
    let page = doc.find_page(page - 1).unwrap();
    let Some(annots) = page.get_dict("Annots").unwrap() else { return Vec::new() };
    let annots = annots.resolve().unwrap().unwrap();
    (0..annots.len().unwrap() as i32)
        .map(|i| {
            let annot = annots.get_array(i).unwrap().unwrap().resolve().unwrap().unwrap();
            String::from_utf8(annot.get_dict("Subtype").unwrap().unwrap().as_name().unwrap()).unwrap()
        })
        .collect()
}

fn merge_options(dir: &Path) -> MergeOptions {
    MergeOptions { skip_invalid: false, output_dir: dir.to_path_buf(), output_name: None, flush_after_bytes: None }
}

fn extract_options(dir: &Path, mode: ExtractMode, ranges: &str) -> ExtractOptions {
    ExtractOptions {
        mode,
        page_ranges: ranges.to_string(),
        output_dir: dir.to_path_buf(),
        output_name: None,
        flush_after_bytes: None,
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

fn zip_entries(path: &Path) -> Vec<(String, Vec<u8>)> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    (0..archive.len())
        .map(|i| {
            let mut f = archive.by_index(i).unwrap();
            let mut data = Vec::new();
            f.read_to_end(&mut data).unwrap();
            (f.name().unwrap().to_string(), data)
        })
        .collect()
}

fn ctx() -> JobContext {
    JobContext::detached()
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

#[test]
fn merged_pages_render_like_the_originals() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = write_rich(src.path(), "a.pdf", "A", 5);
    let b = write_rich(src.path(), "b.pdf", "B", 4);
    let report = merge(&[a.clone(), b.clone()], &merge_options(out.path()), &ctx()).unwrap();

    assert_eq!(report.output_path, out.path().join("merged_output.pdf"));
    assert_eq!((report.total_pages, report.merged_files), (9, 2));
    assert!(report.skipped.is_empty());
    assert_eq!(report.output_size_bytes, std::fs::metadata(&report.output_path).unwrap().len());
    assert_eq!(names(out.path()), ["merged_output.pdf"]);

    assert_eq!(page_count(&report.output_path), 9);
    for page in 1..=5 {
        assert_eq!(render(&report.output_path, page), render(&a, page), "A page {page}");
    }
    for page in 1..=4 {
        assert_eq!(render(&report.output_path, 5 + page), render(&b, page), "B page {page}");
    }
}

#[test]
fn rotation_and_crop_boxes_survive() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = write_rich(src.path(), "a.pdf", "A", 5);
    let b = write_rich(src.path(), "b.pdf", "B", 5);
    let report = merge(&[a, b], &merge_options(out.path()), &ctx()).unwrap();
    // 300x200; rotated 90 gives 200x300; own media box with an off-centre crop
    // box gives the crop box size 300x220; origin-shifted media box rotated 270 gives 200x300.
    let sizes: Vec<(u32, u32)> = (1..=4).map(|p| { let (w, h, _) = render(&report.output_path, p); (w, h) }).collect();
    assert_eq!(sizes, [(300, 200), (200, 300), (300, 220), (200, 300)]);
}

#[test]
fn annotations_come_along_but_links_into_the_source_do_not() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = write_rich(src.path(), "a.pdf", "A", 3);
    let b = write_rich(src.path(), "b.pdf", "B", 3);
    assert_eq!(annotation_subtypes(&a, 1), ["Link", "Link", "Highlight", "Popup", "Text"]);
    let report = merge(&[a, b], &merge_options(out.path()), &ctx()).unwrap();
    // The web link, the highlight and the note stay; the page link and the
    // pop-up cannot.
    assert_eq!(annotation_subtypes(&report.output_path, 1), ["Link", "Highlight", "Text"]);
    assert_eq!(annotation_subtypes(&report.output_path, 4), ["Link", "Highlight", "Text"]);
    // And nothing from the source's page tree was dragged along: 6 pages, no more.
    assert_eq!(page_count(&report.output_path), 6);
    let doc = PdfDocument::open(report.output_path.to_str().unwrap()).unwrap();
    let uri = doc.find_page(0).unwrap().get_dict("Annots").unwrap().unwrap().resolve().unwrap().unwrap();
    let link = uri.get_array(0).unwrap().unwrap().resolve().unwrap().unwrap();
    let action = link.get_dict("A").unwrap().unwrap();
    assert_eq!(action.get_dict("URI").unwrap().unwrap().as_string().unwrap(), "https://example.org/A");
    assert!(link.get_dict("P").unwrap().is_none());
}

#[test]
fn shared_resources_are_copied_once_per_source() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = write_rich(src.path(), "a.pdf", "A", 40);
    let b = write_rich(src.path(), "b.pdf", "B", 40);
    let report = merge(&[a, b], &merge_options(out.path()), &ctx()).unwrap();
    let doc = PdfDocument::open(report.output_path.to_str().unwrap()).unwrap();
    // One Helvetica object per source, not one per page.
    let mut fonts = std::collections::HashSet::new();
    for page in 0..80 {
        let resources = doc.find_page(page).unwrap().get_dict_inheritable("Resources").unwrap().unwrap();
        let font = resources.get_dict("Font").unwrap().unwrap().get_dict("F1").unwrap().unwrap();
        fonts.insert(font.as_indirect().unwrap_or(-1));
    }
    assert!(fonts.len() <= 2, "{} font objects", fonts.len());
}

#[test]
fn the_name_is_never_taken_twice() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = write_rich(src.path(), "a.pdf", "A", 1);
    let b = write_rich(src.path(), "b.pdf", "B", 1);
    let mut options = merge_options(out.path());
    merge(&[a.clone(), b.clone()], &options, &ctx()).unwrap();
    let second = merge(&[a.clone(), b.clone()], &options, &ctx()).unwrap();
    assert_eq!(second.output_path, out.path().join("merged_output (1).pdf"));
    options.output_name = Some("Laporan: Q1.pdf".into());
    let named = merge(&[a, b], &options, &ctx()).unwrap();
    assert_eq!(named.output_path, out.path().join("Laporan_ Q1.pdf"));
}

#[test]
fn a_hopeless_list_is_refused_before_any_work() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = write_rich(src.path(), "a.pdf", "A", 1);
    let err = merge(std::slice::from_ref(&a), &merge_options(out.path()), &ctx()).unwrap_err();
    assert_eq!((err.code(), err.to_string().as_str()), ("invalid_input", "invalid input: At least 2 PDF files are required to merge."));
    let err = merge(&[a.clone(), a.clone()], &merge_options(&out.path().join("nope")), &ctx()).unwrap_err();
    assert_eq!(err.code(), "not_found");
    assert!(names(out.path()).is_empty());
}

#[test]
fn strict_mode_stops_at_the_first_unusable_file_and_writes_nothing() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = write_rich(src.path(), "a.pdf", "A", 2);

    let err = merge(&[a.clone(), fixture("not-a-pdf.pdf")], &merge_options(out.path()), &ctx()).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("Cannot open 'not-a-pdf.pdf'"), "{err}");

    let err = merge(&[a.clone(), fixture("encrypted.pdf")], &merge_options(out.path()), &ctx()).unwrap_err();
    assert!(err.to_string().contains("'encrypted.pdf' is encrypted and cannot be merged."), "{err}");

    let err = merge(&[a.clone(), src.path().join("gone.pdf")], &merge_options(out.path()), &ctx()).unwrap_err();
    assert_eq!(err.code(), "not_found");

    assert!(names(out.path()).is_empty(), "{:?}", names(out.path()));
}

#[test]
fn skipping_mode_leaves_out_unusable_files_and_says_which() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = write_rich(src.path(), "a.pdf", "A", 2);
    let b = write_rich(src.path(), "b.pdf", "B", 3);
    let text = src.path().join("notes.txt");
    std::fs::write(&text, "hello").unwrap();
    let list = vec![
        a.clone(),
        fixture("not-a-pdf.pdf"),
        fixture("encrypted.pdf"),
        src.path().join("gone.pdf"),
        text,
        b.clone(),
    ];
    let mut options = merge_options(out.path());
    options.skip_invalid = true;
    let report = merge(&list, &options, &ctx()).unwrap();
    assert_eq!((report.total_pages, report.merged_files), (5, 2));
    let skipped: Vec<(usize, &str)> = report.skipped.iter().map(|s| (s.index, s.reason.as_str())).collect();
    assert_eq!(
        skipped,
        [(1, "damaged or unreadable"), (2, "encrypted"), (3, "file not found"), (4, "not a PDF file")]
    );
    assert_eq!(render(&report.output_path, 3), render(&b, 1));

    // Fewer than two left: refused, nothing written.
    let err = merge(&[a, fixture("encrypted.pdf")], &options, &ctx()).unwrap_err();
    assert_eq!(err.to_string(), "invalid input: Fewer than 2 files can be merged after skipping the reported problems.");
    assert_eq!(names(out.path()), ["merged_output.pdf"]);
}

#[test]
fn a_pdf_with_an_owner_password_only_merges() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = write_rich(src.path(), "a.pdf", "A", 1);
    let report = merge(&[a, fixture("owner-only.pdf")], &merge_options(out.path()), &ctx()).unwrap();
    assert_eq!(report.merged_files, 2);
    assert_eq!(report.total_pages, 1 + page_count(&fixture("owner-only.pdf")));
}

#[test]
fn inspect_and_describe_report_every_file() {
    let src = tempfile::tempdir().unwrap();
    let a = write_rich(src.path(), "a.pdf", "A", 7);
    let list = vec![a.clone(), fixture("not-a-pdf.pdf"), fixture("encrypted.pdf"), src.path().join("gone.pdf")];
    assert_eq!(classify(&a), None);
    assert_eq!(classify(&fixture("encrypted.pdf")), Some("encrypted"));

    let inspection = inspect(&list, &ctx()).unwrap();
    assert_eq!(inspection.usable, 1);
    let problems: Vec<(usize, &str)> = inspection.problems.iter().map(|p| (p.index, p.reason.as_str())).collect();
    assert_eq!(problems, [(1, "damaged or unreadable"), (2, "encrypted"), (3, "file not found")]);

    let described = describe(&list, &ctx()).unwrap();
    assert_eq!(described[0].pages, Some(7));
    assert_eq!(described[0].size_bytes, std::fs::metadata(&a).unwrap().len());
    assert_eq!(described[1].pages, None);
    assert!(described[1].size_bytes > 0);
    assert_eq!(described[2].pages, None);
    assert_eq!((described[3].size_bytes, described[3].pages), (0, None));
}

#[test]
fn flushing_through_a_temporary_file_gives_the_same_result() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let files: Vec<PathBuf> = (0..5).map(|i| write_rich(src.path(), &format!("f{i}.pdf"), &format!("F{i}"), 6)).collect();
    let mut options = merge_options(out.path());
    options.flush_after_bytes = Some(1); // flush after every file
    let report = merge(&files, &options, &ctx()).unwrap();
    assert_eq!(report.total_pages, 30);
    for (i, file) in files.iter().enumerate() {
        for page in 1..=6 {
            assert_eq!(render(&report.output_path, i as u32 * 6 + page), render(file, page), "file {i} page {page}");
        }
    }
    // Only the result is left: no `.part` or temporary file.
    assert_eq!(names(out.path()), ["merged_output.pdf"]);
}

#[test]
fn progress_counts_files_then_saving() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let files: Vec<PathBuf> = (0..3).map(|i| write_rich(src.path(), &format!("f{i}.pdf"), "F", 1)).collect();
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: dokuwu_core::ProgressSink = {
        let seen = Arc::clone(&seen);
        Arc::new(move |_, p| seen.lock().unwrap().push((p.stage.clone(), p.done, p.total)))
    };
    let ctx = JobContext::new(1, CancelToken::new(), Some(sink)).with_min_interval(std::time::Duration::ZERO);
    merge(&files, &merge_options(out.path()), &ctx).unwrap();
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.first().unwrap(), &("files".to_string(), 0, Some(3)));
    assert!(seen.contains(&("files".to_string(), 3, Some(3))));
    assert_eq!(seen.last().unwrap().0, "saving");
}

#[test]
fn cancelling_removes_every_trace() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let files: Vec<PathBuf> = (0..4).map(|i| write_rich(src.path(), &format!("f{i}.pdf"), "F", 3)).collect();

    // Before the start.
    let token = CancelToken::new();
    token.cancel();
    let err = merge(&files, &merge_options(out.path()), &JobContext::new(1, token, None)).unwrap_err();
    assert!(err.is_cancelled());

    // After the second file, with a flush after each.
    let token = CancelToken::new();
    let sink: dokuwu_core::ProgressSink = {
        let token = token.clone();
        Arc::new(move |_, p| {
            if p.stage == "files" && p.done == 2 {
                token.cancel();
            }
        })
    };
    let ctx = JobContext::new(1, token, Some(sink)).with_min_interval(std::time::Duration::ZERO);
    let mut options = merge_options(out.path());
    options.flush_after_bytes = Some(1);
    let err = merge(&files, &options, &ctx).unwrap_err();
    assert!(err.is_cancelled());
    assert!(names(out.path()).is_empty(), "{:?}", names(out.path()));
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

#[test]
fn combine_keeps_the_order_that_was_typed() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = write_rich(src.path(), "report.pdf", "R", 6);
    let report = extract(&doc, &extract_options(out.path(), ExtractMode::Combine, "5, 1-2, 5"), &ctx()).unwrap();
    assert_eq!(report.output_path, out.path().join("extracted_report.pdf"));
    assert_eq!((report.pages_extracted, report.files, report.is_zip), (4, 1, false));
    assert_eq!(page_count(&report.output_path), 4);
    for (i, page) in [5, 1, 2, 5].into_iter().enumerate() {
        assert_eq!(render(&report.output_path, i as u32 + 1), render(&doc, page), "output page {}", i + 1);
    }
    assert_eq!(names(out.path()), ["extracted_report.pdf"]);
}

#[test]
fn combine_through_a_temporary_file_matches() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = write_rich(src.path(), "report.pdf", "R", 12);
    let mut options = extract_options(out.path(), ExtractMode::Combine, "1-12");
    options.flush_after_bytes = Some(1);
    let report = extract(&doc, &options, &ctx()).unwrap();
    assert_eq!(report.pages_extracted, 12);
    for page in 1..=12 {
        assert_eq!(render(&report.output_path, page), render(&doc, page), "page {page}");
    }
    assert_eq!(names(out.path()), ["extracted_report.pdf"]);
}

#[test]
fn separate_page_writes_one_pdf_per_distinct_page() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = write_rich(src.path(), "report.pdf", "R", 6);
    let report = extract(&doc, &extract_options(out.path(), ExtractMode::SeparatePage, "4, 2-3, 2"), &ctx()).unwrap();
    assert_eq!(report.output_path, out.path().join("extracted_report.zip"));
    assert_eq!((report.pages_extracted, report.files, report.is_zip), (3, 3, true));
    let entries = zip_entries(&report.output_path);
    let entry_names: Vec<&str> = entries.iter().map(|e| e.0.as_str()).collect();
    assert_eq!(entry_names, ["extracted_report_page0002.pdf", "extracted_report_page0003.pdf", "extracted_report_page0004.pdf"]);
    for ((name, bytes), page) in entries.iter().zip([2u32, 3, 4]) {
        let path = out.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(page_count(&path), 1);
        assert_eq!(render(&path, 1), render(&doc, page), "{name}");
    }
}

#[test]
fn separate_range_writes_one_pdf_per_range() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = write_rich(src.path(), "report.pdf", "R", 8);
    let mut options = extract_options(out.path(), ExtractMode::SeparateRange, "7, 2-4, 7");
    options.output_name = Some("bagian".into());
    let report = extract(&doc, &options, &ctx()).unwrap();
    assert_eq!(report.output_path, out.path().join("bagian.zip"));
    assert_eq!((report.pages_extracted, report.files), (5, 3));
    let entries = zip_entries(&report.output_path);
    let entry_names: Vec<&str> = entries.iter().map(|e| e.0.as_str()).collect();
    assert_eq!(entry_names, ["bagian_p7.pdf", "bagian_p2-4.pdf", "bagian_p7 (2).pdf"]);
    let tmp = out.path().join("check.pdf");
    std::fs::write(&tmp, &entries[1].1).unwrap();
    assert_eq!(page_count(&tmp), 3);
    for page in 1..=3 {
        assert_eq!(render(&tmp, page), render(&doc, page + 1));
    }
}

#[test]
fn split_all_ignores_the_ranges() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = write_rich(src.path(), "report.pdf", "R", 5);
    let report = extract(&doc, &extract_options(out.path(), ExtractMode::SplitAll, "not even checked"), &ctx()).unwrap();
    assert_eq!((report.pages_extracted, report.files), (5, 5));
    let names: Vec<String> = zip_entries(&report.output_path).into_iter().map(|e| e.0).collect();
    assert_eq!(names, ["extracted_report_p1.pdf", "extracted_report_p2.pdf", "extracted_report_p3.pdf", "extracted_report_p4.pdf", "extracted_report_p5.pdf"]);
}

#[test]
fn bad_input_is_refused_and_leaves_nothing() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = write_rich(src.path(), "report.pdf", "R", 4);
    for ranges in ["", "0", "5", "3-2", "1-9", "a", "1;2"] {
        let err = extract(&doc, &extract_options(out.path(), ExtractMode::Combine, ranges), &ctx()).unwrap_err();
        assert_eq!(err.code(), "invalid_input", "{ranges:?}");
    }
    let err = extract(&fixture("encrypted.pdf"), &extract_options(out.path(), ExtractMode::SplitAll, ""), &ctx()).unwrap_err();
    assert_eq!(err.code(), "password_required");
    let err = extract(&fixture("not-a-pdf.pdf"), &extract_options(out.path(), ExtractMode::Combine, "1"), &ctx()).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    let err = extract(&src.path().join("gone.pdf"), &extract_options(out.path(), ExtractMode::Combine, "1"), &ctx()).unwrap_err();
    assert_eq!(err.code(), "not_found");
    let err = extract(&doc, &extract_options(&out.path().join("nope"), ExtractMode::Combine, "1"), &ctx()).unwrap_err();
    assert_eq!(err.code(), "not_found");
    assert!(names(out.path()).is_empty(), "{:?}", names(out.path()));
}

#[test]
fn cancelling_an_extract_removes_the_partial_zip() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = write_rich(src.path(), "report.pdf", "R", 10);
    let token = CancelToken::new();
    let sink: dokuwu_core::ProgressSink = {
        let token = token.clone();
        Arc::new(move |_, p| {
            if p.stage == "pages" && p.done == 4 {
                token.cancel();
            }
        })
    };
    let ctx = JobContext::new(1, token, Some(sink)).with_min_interval(std::time::Duration::ZERO);
    let err = extract(&doc, &extract_options(out.path(), ExtractMode::SplitAll, ""), &ctx).unwrap_err();
    assert!(err.is_cancelled());
    assert!(names(out.path()).is_empty(), "{:?}", names(out.path()));
}

#[test]
fn a_big_split_keeps_every_page_intact() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = write_rich(src.path(), "big.pdf", "Big", 120);
    let report = extract(&doc, &extract_options(out.path(), ExtractMode::SplitAll, ""), &ctx()).unwrap();
    assert_eq!(report.files, 120);
    let entries = zip_entries(&report.output_path);
    assert_eq!(entries.len(), 120);
    for (i, (name, bytes)) in entries.iter().enumerate().step_by(7) {
        let path = out.path().join("check.pdf");
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(render(&path, 1), render(&doc, i as u32 + 1), "{name}");
    }
}
