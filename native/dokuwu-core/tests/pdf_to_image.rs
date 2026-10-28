//! PDF pages to images (`ops::pdf_to_image`). PDFs are built in the test; the
//! encrypted and damaged ones come from `tests/fixtures/pdf-compress/`.

mod common;

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use common::{write_pdf, PageSpec};
use dokuwu_core::job::{CancelToken, JobContext};
use dokuwu_core::ops::pdf_to_image::{pdf_to_images, ImageFormat, PdfToImageOptions};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf-compress").join(name)
}

fn options(dir: &Path, format: ImageFormat, dpi: u32, ranges: &str) -> PdfToImageOptions {
    PdfToImageOptions {
        format,
        dpi,
        page_ranges: ranges.to_string(),
        output_dir: dir.to_path_buf(),
        output_name: None,
    }
}

/// Page `n` (1-based) is `100 + 10 n` points wide and 200 high, with a black square.
fn pages(count: usize) -> Vec<PageSpec> {
    (1..=count)
        .map(|n| PageSpec::new(100.0 + 10.0 * n as f32, 200.0, "0 0 0 rg 10 10 50 50 re f"))
        .collect()
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

#[test]
fn one_page_becomes_a_plain_png_at_the_requested_dpi() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = write_pdf(&src, "doc.pdf", &pages(3), None);
    let report = pdf_to_images(&pdf, &options(out.path(), ImageFormat::Png, 144, "2"), &JobContext::detached()).unwrap();
    assert!(!report.is_zip);
    assert_eq!(report.pages, 1);
    assert_eq!(report.output_path, out.path().join("doc_page0002.png"));
    let img = image::open(&report.output_path).unwrap().to_rgb8();
    // 120 x 200 pt at 144 dpi.
    assert_eq!((img.width(), img.height()), (240, 400));
    // The square sits at the bottom left: x 10..60 pt, y 10..60 pt from the bottom.
    assert_eq!(img.get_pixel(60, 400 - 60).0, [0, 0, 0]);
    assert_eq!(img.get_pixel(200, 20).0, [255, 255, 255]);
    assert_eq!(names(out.path()), vec!["doc_page0002.png"]);
    assert_eq!(report.output_size_bytes, std::fs::metadata(&report.output_path).unwrap().len());
}

#[test]
fn several_pages_become_one_zip_in_page_order() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = write_pdf(&src, "report.pdf", &pages(12), None);
    let report = pdf_to_images(&pdf, &options(out.path(), ImageFormat::Png, 72, ""), &JobContext::detached()).unwrap();
    assert!(report.is_zip);
    assert_eq!(report.pages, 12);
    assert_eq!(report.output_path, out.path().join("report.zip"));
    let entries = zip_entries(&report.output_path);
    assert_eq!(entries.len(), 12);
    for (i, (name, data)) in entries.iter().enumerate() {
        let n = i as u32 + 1;
        assert_eq!(name, &format!("report_page{n:04}.png"));
        let img = image::load_from_memory(data).unwrap();
        assert_eq!((img.width(), img.height()), (100 + 10 * n, 200), "page {n}");
    }
    assert_eq!(names(out.path()), vec!["report.zip"]);
}

#[test]
fn a_page_selection_picks_only_those_pages() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = write_pdf(&src, "doc.pdf", &pages(6), None);
    let report = pdf_to_images(&pdf, &options(out.path(), ImageFormat::Png, 72, "5, 1-2"), &JobContext::detached()).unwrap();
    let names: Vec<String> = zip_entries(&report.output_path).into_iter().map(|e| e.0).collect();
    assert_eq!(names, vec!["doc_page0001.png", "doc_page0002.png", "doc_page0005.png"]);
}

#[test]
fn jpeg_and_webp_decode_and_keep_the_page_size() {
    let src = tempfile::tempdir().unwrap();
    let pdf = write_pdf(&src, "doc.pdf", &pages(1), None);
    for (format, ext) in [(ImageFormat::Jpeg, "jpeg"), (ImageFormat::Webp, "webp")] {
        let out = tempfile::tempdir().unwrap();
        let report = pdf_to_images(&pdf, &options(out.path(), format, 144, ""), &JobContext::detached()).unwrap();
        assert_eq!(report.output_path, out.path().join(format!("doc_page0001.{ext}")));
        let bytes = std::fs::read(&report.output_path).unwrap();
        let img = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert_eq!((img.width(), img.height()), (220, 400), "{ext}");
        // Lossy: the black square stays dark and the paper stays light.
        assert!(img.get_pixel(60, 340).0.iter().all(|&c| c < 40), "{ext}");
        assert!(img.get_pixel(200, 20).0.iter().all(|&c| c > 215), "{ext}");
    }
}

#[test]
fn a_taken_name_gets_a_number_and_nothing_is_overwritten() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = write_pdf(&src, "doc.pdf", &pages(1), None);
    let first = pdf_to_images(&pdf, &options(out.path(), ImageFormat::Png, 72, ""), &JobContext::detached()).unwrap();
    let second = pdf_to_images(&pdf, &options(out.path(), ImageFormat::Png, 72, ""), &JobContext::detached()).unwrap();
    assert_eq!(first.output_path, out.path().join("doc_page0001.png"));
    assert_eq!(second.output_path, out.path().join("doc_page0001 (1).png"));
}

#[test]
fn a_custom_name_is_made_safe() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = write_pdf(&src, "doc.pdf", &pages(2), None);
    let mut o = options(out.path(), ImageFormat::Png, 72, "");
    o.output_name = Some("Laporan: Q1/2025.zip".into());
    let report = pdf_to_images(&pdf, &o, &JobContext::detached()).unwrap();
    assert_eq!(report.output_path, out.path().join("Laporan_ Q1_2025.zip"));
}

#[test]
fn a_huge_sheet_is_lowered_to_the_pixel_ceiling_and_reported() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = write_pdf(&src, "poster.pdf", &[PageSpec::new(2000.0, 2000.0, "0 g 0 0 100 100 re f")], None);
    // 2000 pt at 300 dpi would be 8333 px square, 69 MP.
    let report = pdf_to_images(&pdf, &options(out.path(), ImageFormat::Jpeg, 300, ""), &JobContext::detached()).unwrap();
    assert_eq!(report.reduced_pages, vec![1]);
    let img = image::open(&report.output_path).unwrap();
    assert!(img.width() as u64 * img.height() as u64 <= 60_000_000);
    assert!(img.width() > 7000);
}

#[test]
fn bad_input_fails_with_a_clear_code_and_leaves_no_files() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = write_pdf(&src, "doc.pdf", &pages(2), None);
    let job = JobContext::detached();
    let code = |r: Result<_, dokuwu_core::CoreError>| match r {
        Ok(_) => "ok",
        Err(e) => e.code(),
    };
    assert_eq!(code(pdf_to_images(&pdf, &options(out.path(), ImageFormat::Png, 72, "9"), &job)), "invalid_input");
    assert_eq!(code(pdf_to_images(&pdf, &options(out.path(), ImageFormat::Png, 10, ""), &job)), "invalid_input");
    assert_eq!(code(pdf_to_images(&fixture("encrypted.pdf"), &options(out.path(), ImageFormat::Png, 72, ""), &job)), "password_required");
    assert_eq!(code(pdf_to_images(&fixture("not-a-pdf.pdf"), &options(out.path(), ImageFormat::Png, 72, ""), &job)), "invalid_input");
    assert_eq!(code(pdf_to_images(&src.path().join("nope.pdf"), &options(out.path(), ImageFormat::Png, 72, ""), &job)), "not_found");
    assert_eq!(code(pdf_to_images(&pdf, &options(&out.path().join("missing"), ImageFormat::Png, 72, ""), &job)), "not_found");
    assert!(names(out.path()).is_empty());
}

#[test]
fn cancelling_removes_the_partial_file() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = write_pdf(&src, "doc.pdf", &pages(40), None);
    let token = CancelToken::new();
    let cancel = token.clone();
    // Cancel as soon as the first page is reported.
    let sink: dokuwu_core::ProgressSink = std::sync::Arc::new(move |_, p| {
        if p.done >= 1 {
            cancel.cancel();
        }
    });
    let ctx = JobContext::new(1, token, Some(sink)).with_min_interval(std::time::Duration::ZERO);
    let err = pdf_to_images(&pdf, &options(out.path(), ImageFormat::Png, 150, ""), &ctx).unwrap_err();
    assert!(err.is_cancelled());
    assert!(names(out.path()).is_empty(), "{:?}", names(out.path()));
}

#[test]
fn progress_counts_pages_and_ends_at_the_total() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = write_pdf(&src, "doc.pdf", &pages(8), None);
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let store = std::sync::Arc::clone(&seen);
    let sink: dokuwu_core::ProgressSink = std::sync::Arc::new(move |_, p| store.lock().unwrap().push((p.stage.clone(), p.done, p.total)));
    let ctx = JobContext::new(1, CancelToken::new(), Some(sink));
    pdf_to_images(&pdf, &options(out.path(), ImageFormat::Png, 72, ""), &ctx).unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.first().unwrap(), &("pages".to_string(), 0, Some(8)));
    assert_eq!(seen.last().unwrap(), &("pages".to_string(), 8, Some(8)));
}

#[test]
fn a_zip_made_by_the_exporter_opens_with_a_plain_reader() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = write_pdf(&src, "doc.pdf", &pages(3), None);
    let report = pdf_to_images(&pdf, &options(out.path(), ImageFormat::Jpeg, 72, ""), &JobContext::detached()).unwrap();
    let bytes = std::fs::read(&report.output_path).unwrap();
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    assert_eq!(archive.len(), 3);
    for i in 0..3 {
        archive.by_index(i).unwrap().enclosed_name().unwrap();
    }
}
