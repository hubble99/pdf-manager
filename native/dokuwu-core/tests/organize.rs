//! The Organize workspace (`ops::organize`): registering files, thumbnails,
//! and assembling a PDF from a list of page references.
//!
//! Every page is drawn with shapes that are not symmetric, so a mirrored,
//! turned or misplaced page cannot pass for the right one. Pages are compared
//! as rendered pixels.

mod common;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::{decode, write_pdf, PageSpec};
use dokuwu_core::job::{CancelToken, JobContext};
use dokuwu_core::ops::organize::{
    assemble, AssembleOptions, DocumentKind, OrganizeRegistry, PageRef, Source, MAX_DOCUMENTS,
};
use dokuwu_core::ops::pdf_render::{RenderDocument, RenderService};

fn leak(text: String) -> &'static str {
    Box::leak(text.into_boxed_str())
}

/// Page `n` of a document: a coloured block near the lower left, a thin bar
/// along the top, a block whose size depends on `n`. Nothing is symmetric.
fn marked(n: u32) -> PageSpec {
    let c = (n as f32 * 0.37) % 1.0;
    PageSpec::new(
        300.0,
        200.0,
        leak(format!(
            "{c:.2} 0.2 0.6 rg 20 20 {} 40 re f 0.1 0.6 0.2 rg 0 190 120 10 re f 0.8 0.1 0.1 rg 250 100 30 {} re f",
            40 + n * 10,
            20 + n * 5
        )),
    )
}

fn pdf_with(dir: &tempfile::TempDir, name: &str, count: u32) -> PathBuf {
    let pages: Vec<PageSpec> = (1..=count).map(marked).collect();
    write_pdf(dir, name, &pages, None)
}

fn render(path: &Path, page: u32) -> (u32, u32, Vec<u8>) {
    RenderDocument::open(path)
        .unwrap()
        .render_rgb(page, 72, |view| Ok((view.width, view.height, view.packed().into_owned())))
        .unwrap()
}

fn mirrored(width: u32, height: u32, rgb: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgb.len());
    for y in 0..height as usize {
        for x in (0..width as usize).rev() {
            let i = (y * width as usize + x) * 3;
            out.extend_from_slice(&rgb[i..i + 3]);
        }
    }
    out
}

fn page_count(path: &Path) -> u32 {
    RenderDocument::open(path).unwrap().page_count()
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> =
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

fn entry(source: &str, page: u32, rotation: i32, flip: bool) -> PageRef {
    PageRef { source: source.to_string(), page, rotation, flip }
}

fn options(dir: &Path) -> AssembleOptions {
    AssembleOptions { output_dir: dir.to_path_buf(), output_name: None, flush_after_bytes: None }
}

fn ctx() -> JobContext {
    JobContext::detached()
}

/// Registers `paths` and returns their handles and the sources for assembling.
fn registered(paths: &[&Path], refs: &[PageRef]) -> (OrganizeRegistry, Vec<String>, HashMap<String, Source>) {
    let registry = OrganizeRegistry::new();
    let ids: Vec<String> = paths.iter().map(|p| registry.open(p).unwrap().document_id).collect();
    // The refs name their sources by index; swap in the real handles.
    let real: Vec<PageRef> = refs
        .iter()
        .map(|r| PageRef { source: ids[r.source.parse::<usize>().unwrap()].clone(), ..r.clone() })
        .collect();
    let sources = registry.sources_for(&real).unwrap();
    (registry, ids, sources)
}

fn run(paths: &[&Path], refs: &[PageRef], out: &Path) -> PathBuf {
    let (_registry, ids, sources) = registered(paths, refs);
    let real: Vec<PageRef> = refs
        .iter()
        .map(|r| PageRef { source: ids[r.source.parse::<usize>().unwrap()].clone(), ..r.clone() })
        .collect();
    assemble(&sources, &real, &options(out), &ctx()).unwrap().output_path
}

/// A picture of four solid quadrants (red, green / blue, yellow) and a one
/// pixel white border, so mirroring and turning are visible.
fn write_picture(dir: &Path, name: &str, width: u32, height: u32) -> PathBuf {
    let mut img = image::RgbImage::from_pixel(width, height, image::Rgb([255, 255, 255]));
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let color = match (x < width / 2, y < height / 2) {
                (true, true) => [220, 30, 30],
                (false, true) => [30, 200, 40],
                (true, false) => [30, 40, 220],
                (false, false) => [230, 220, 30],
            };
            img.put_pixel(x, y, image::Rgb(color));
        }
    }
    let path = dir.join(name);
    img.save(&path).unwrap();
    path
}

fn close(a: [u8; 3], b: [u8; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| (*x as i32 - y as i32).abs() <= 14)
}

// ---------------------------------------------------------------------------
// Registering files
// ---------------------------------------------------------------------------

#[test]
fn a_pdf_is_registered_with_its_page_count() {
    let dir = tempfile::tempdir().unwrap();
    let path = pdf_with(&dir, "doc.pdf", 4);
    let registry = OrganizeRegistry::new();
    let doc = registry.open(&path).unwrap();
    assert_eq!((doc.name.as_str(), doc.kind, doc.page_count), ("doc.pdf", DocumentKind::Pdf, 4));
    assert!(!doc.document_id.is_empty());
    assert_eq!(registry.count(), 1);
    assert!(registry.release(&doc.document_id));
    assert!(!registry.release(&doc.document_id));
    assert_eq!(registry.count(), 0);
    assert!(path.exists(), "releasing a file never deletes it");
}

#[test]
fn a_picture_is_one_page() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_picture(dir.path(), "photo.png", 40, 20);
    let doc = OrganizeRegistry::new().open(&path).unwrap();
    assert_eq!((doc.kind, doc.page_count), (DocumentKind::Image, 1));
}

#[test]
fn files_that_cannot_be_organized_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let registry = OrganizeRegistry::new();
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf-compress");

    let protected = registry.open(&fixtures.join("encrypted.pdf")).unwrap_err();
    assert_eq!(protected.code(), "password_required");

    let broken = registry.open(&fixtures.join("not-a-pdf.pdf")).unwrap_err();
    assert_eq!(broken.code(), "invalid_input");

    let text = dir.path().join("notes.txt");
    std::fs::write(&text, "hello").unwrap();
    assert_eq!(registry.open(&text).unwrap_err().code(), "unsupported");

    let fake_image = dir.path().join("fake.png");
    std::fs::write(&fake_image, "not an image").unwrap();
    assert_eq!(registry.open(&fake_image).unwrap_err().code(), "invalid_input");

    assert_eq!(registry.open(&dir.path().join("missing.pdf")).unwrap_err().code(), "not_found");
    assert_eq!(registry.count(), 0);
}

#[test]
fn the_registry_forgets_the_least_recently_used_file_when_full() {
    let dir = tempfile::tempdir().unwrap();
    let path = pdf_with(&dir, "doc.pdf", 1);
    let registry = OrganizeRegistry::new();
    let render = RenderService::with_workers(1);
    let first = registry.open(&path).unwrap().document_id;
    let second = registry.open(&path).unwrap().document_id;
    // Using the first one makes the second the oldest.
    registry.thumbnails(&render, &first, 1, 1, 100).unwrap();
    for _ in 0..MAX_DOCUMENTS - 1 {
        registry.open(&path).unwrap();
    }
    assert_eq!(registry.count(), MAX_DOCUMENTS);
    registry.thumbnails(&render, &first, 1, 1, 100).unwrap();
    assert!(registry.thumbnails(&render, &second, 1, 1, 100).is_err(), "the oldest was evicted");
}

#[test]
fn a_file_that_changed_since_it_was_added_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = pdf_with(&dir, "doc.pdf", 2);
    let registry = OrganizeRegistry::new();
    let render = RenderService::with_workers(1);
    let id = registry.open(&path).unwrap().document_id;
    registry.thumbnails(&render, &id, 1, 2, 100).unwrap();

    pdf_with(&dir, "doc.pdf", 5);
    let err = registry.thumbnails(&render, &id, 1, 2, 100).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("changed on disk"), "{err}");

    std::fs::remove_file(&path).unwrap();
    assert_eq!(registry.thumbnails(&render, &id, 1, 2, 100).unwrap_err().code(), "not_found");
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

#[test]
fn thumbnails_are_rendered_at_the_requested_width() {
    let dir = tempfile::tempdir().unwrap();
    let path = pdf_with(&dir, "doc.pdf", 5);
    let registry = OrganizeRegistry::new();
    let render = RenderService::with_workers(2);
    let id = registry.open(&path).unwrap().document_id;

    let batch = registry.thumbnails(&render, &id, 2, 3, 150).unwrap();
    assert_eq!((batch.start, batch.total), (2, 5));
    assert_eq!(batch.pages.iter().map(|p| p.page).collect::<Vec<_>>(), [2, 3, 4]);
    for page in &batch.pages {
        // 300 x 200 pt at 150 px wide.
        assert_eq!((page.width, page.height), (150, 100));
        let png = decode(&page.png);
        assert_eq!((png.width, png.height), (150, 100));
    }
    // The last batch is short, and asking past the end of the document is an error.
    let tail = registry.thumbnails(&render, &id, 4, 48, 150).unwrap();
    assert_eq!(tail.pages.len(), 2);
    assert_eq!(registry.thumbnails(&render, &id, 6, 1, 150).unwrap_err().code(), "invalid_input");
}

#[test]
fn thumbnail_batches_and_widths_are_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let path = pdf_with(&dir, "doc.pdf", 2);
    let registry = OrganizeRegistry::new();
    let render = RenderService::with_workers(1);
    let id = registry.open(&path).unwrap().document_id;

    assert!(registry.thumbnails(&render, &id, 0, 1, 150).is_err());
    assert!(registry.thumbnails(&render, &id, 1, 0, 150).is_err());
    assert!(registry.thumbnails(&render, &id, 1, 49, 150).is_err());
    // Widths are clamped, not refused.
    assert_eq!(registry.thumbnails(&render, &id, 1, 1, 10).unwrap().pages[0].width, 48);
    assert_eq!(registry.thumbnails(&render, &id, 1, 1, 9000).unwrap().pages[0].width, 400);
}

#[test]
fn a_picture_thumbnail_keeps_its_proportions() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_picture(dir.path(), "photo.png", 400, 200);
    let registry = OrganizeRegistry::new();
    let render = RenderService::with_workers(1);
    let id = registry.open(&path).unwrap().document_id;

    let batch = registry.thumbnails(&render, &id, 1, 24, 100).unwrap();
    assert_eq!((batch.total, batch.pages.len()), (1, 1));
    let page = &batch.pages[0];
    assert_eq!((page.width, page.height), (100, 50));
    let png = decode(&page.png);
    assert!(close(png.pixel(25, 12), [220, 30, 30]));
    assert!(close(png.pixel(75, 38), [230, 220, 30]));
    assert_eq!(registry.thumbnails(&render, &id, 2, 1, 100).unwrap_err().code(), "invalid_input");
}

// ---------------------------------------------------------------------------
// Assembling
// ---------------------------------------------------------------------------

#[test]
fn the_list_decides_the_order_and_repeats_and_omissions_follow() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = pdf_with(&src, "a.pdf", 4);
    let b = pdf_with(&src, "b.pdf", 3);
    let refs = [entry("1", 3, 0, false), entry("0", 1, 0, false), entry("0", 4, 0, false), entry("1", 3, 0, false)];
    let output = run(&[&a, &b], &refs, out.path());

    assert_eq!(output, out.path().join("organized.pdf"));
    assert_eq!(page_count(&output), 4);
    assert_eq!(render(&output, 1), render(&b, 3));
    assert_eq!(render(&output, 2), render(&a, 1));
    assert_eq!(render(&output, 3), render(&a, 4));
    assert_eq!(render(&output, 4), render(&b, 3));
    assert_eq!(names(out.path()), ["organized.pdf"]);
}

#[test]
fn rotation_is_added_to_the_pages_own_rotation() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let mut turned = marked(1);
    turned.rotate = 90;
    let path = write_pdf(&src, "turned.pdf", &[marked(1), turned], None);
    let refs = [entry("0", 1, 90, false), entry("0", 2, 90, false), entry("0", 2, 270, false), entry("0", 1, 180, false)];
    let output = run(&[&path], &refs, out.path());

    let doc = mupdf::pdf::PdfDocument::open(output.to_str().unwrap()).unwrap();
    let rotations: Vec<i32> = (0..4).map(|i| doc.load_pdf_page(i).unwrap().rotation().unwrap()).collect();
    assert_eq!(rotations, [90, 180, 0, 180]);
    // The turn is real: page 1 turned a quarter is page 1's picture, rotated.
    let (w, h, _) = render(&output, 1);
    assert_eq!((w, h), (200, 300));
    let (w, h, _) = render(&output, 2);
    assert_eq!((w, h), (300, 200));
}

#[test]
fn a_mirrored_page_is_the_original_flipped_left_to_right() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let mut cropped = marked(2);
    cropped.media = [0.0, 0.0, 400.0, 300.0];
    cropped.crop = Some([50.0, 40.0, 350.0, 260.0]);
    let mut shifted = marked(3);
    shifted.media = [100.0, 100.0, 400.0, 300.0];
    let mut turned = marked(4);
    turned.rotate = 90;
    let path = write_pdf(&src, "doc.pdf", &[marked(1), cropped, shifted, turned], None);
    let refs: Vec<PageRef> = (1..=4).map(|p| entry("0", p, 0, true)).collect();
    let output = run(&[&path], &refs, out.path());

    for page in 1..=4 {
        let (w, h, rgb) = render(&path, page);
        let (ow, oh, orgb) = render(&output, page);
        assert_eq!((ow, oh), (w, h), "page {page} keeps its size");
        // The page's own rotation is applied after the mirror, so a page that
        // is rotated 90 is mirrored along its own (unrotated) horizontal axis,
        // which is the vertical axis on screen.
        let expected = if page == 4 { flipped_vertically(w, h, &rgb) } else { mirrored(w, h, &rgb) };
        assert!(orgb == expected, "page {page} is the mirror image");
    }
}

fn flipped_vertically(width: u32, height: u32, rgb: &[u8]) -> Vec<u8> {
    let row = width as usize * 3;
    (0..height as usize).rev().flat_map(|y| rgb[y * row..(y + 1) * row].to_vec()).collect()
}

#[test]
fn a_mirrored_and_turned_page_keeps_its_vector_content() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let path = pdf_with(&src, "doc.pdf", 1);
    let output = run(&[&path], &[entry("0", 1, 90, true)], out.path());

    // Mirror first, then a clockwise turn: the same pixels as turning the
    // mirrored render.
    let (w, h, rgb) = render(&path, 1);
    let flipped = mirrored(w, h, &rgb);
    let (ow, oh, orgb) = render(&output, 1);
    assert_eq!((ow, oh), (h, w));
    // A clockwise quarter turn sends (x, y) to (h - 1 - y, x).
    let mut expected = vec![0u8; flipped.len()];
    for y in 0..h as usize {
        for x in 0..w as usize {
            let from = (y * w as usize + x) * 3;
            let to = (x * h as usize + (h as usize - 1 - y)) * 3;
            expected[to..to + 3].copy_from_slice(&flipped[from..from + 3]);
        }
    }
    assert!(orgb == expected);
    // Not rasterised: the output stays small and has no image.
    let doc = mupdf::pdf::PdfDocument::open(output.to_str().unwrap()).unwrap();
    assert!(doc.load_pdf_page(0).unwrap().images().unwrap().is_empty());
}

#[test]
fn pictures_become_pages_of_their_own_size() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let photo = write_picture(src.path(), "photo.png", 80, 40);
    let output = run(
        &[&photo],
        &[entry("0", 1, 0, false), entry("0", 1, 90, false), entry("0", 1, 0, true), entry("0", 1, 270, true)],
        out.path(),
    );

    assert_eq!(page_count(&output), 4);
    let red = [220, 30, 30];
    let green = [30, 200, 40];
    let blue = [30, 40, 220];
    let yellow = [230, 220, 30];
    let sample = |page: u32, fx: f32, fy: f32| {
        let (w, h, rgb) = render(&output, page);
        let (x, y) = ((w as f32 * fx) as u32, (h as f32 * fy) as u32);
        let i = ((y * w + x) * 3) as usize;
        ((w, h), [rgb[i], rgb[i + 1], rgb[i + 2]])
    };
    // As is: red top left, yellow bottom right, one pixel per point.
    let (size, top_left) = sample(1, 0.25, 0.25);
    assert_eq!(size, (80, 40));
    assert!(close(top_left, red));
    assert!(close(sample(1, 0.75, 0.75).1, yellow));
    // Turned clockwise: the top left goes to the top right; the sheet is 40 x 80.
    let (size, top_right) = sample(2, 0.75, 0.25);
    assert_eq!(size, (40, 80));
    assert!(close(top_right, red));
    // Mirrored: red moves to the top right, green to the top left.
    assert!(close(sample(3, 0.75, 0.25).1, red));
    assert!(close(sample(3, 0.25, 0.25).1, green));
    // Mirrored (green, red / yellow, blue), then turned 270 clockwise, which is a
    // quarter counter-clockwise: the right column becomes the top row.
    let (size, _) = sample(4, 0.5, 0.5);
    assert_eq!(size, (40, 80));
    assert!(close(sample(4, 0.25, 0.25).1, red), "mirrored then turned 270");
    assert!(close(sample(4, 0.75, 0.25).1, blue));
    assert!(close(sample(4, 0.25, 0.75).1, green));
    assert!(close(sample(4, 0.75, 0.75).1, yellow));
}

#[test]
fn pdfs_and_pictures_can_be_mixed() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = pdf_with(&src, "doc.pdf", 2);
    let photo = write_picture(src.path(), "photo.png", 60, 30);
    let output = run(&[&doc, &photo], &[entry("1", 1, 0, false), entry("0", 2, 0, false), entry("1", 1, 0, false)], out.path());
    assert_eq!(page_count(&output), 3);
    assert_eq!(render(&output, 2), render(&doc, 2));
    assert_eq!(render(&output, 1).0, 60);
}

#[test]
fn an_output_never_replaces_a_file_and_takes_the_given_name() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = pdf_with(&src, "doc.pdf", 1);
    std::fs::write(out.path().join("my plan.pdf"), b"old").unwrap();
    let refs = [entry("0", 1, 0, false)];
    let (_registry, ids, sources) = registered(&[&doc], &refs);
    let real = [entry(&ids[0], 1, 0, false)];
    let mut opts = options(out.path());
    opts.output_name = Some("my plan.pdf".to_string());
    let report = assemble(&sources, &real, &opts, &ctx()).unwrap();

    assert_eq!(report.output_path, out.path().join("my plan (1).pdf"));
    assert_eq!(report.pages, 1);
    assert_eq!(report.output_size_bytes, std::fs::metadata(&report.output_path).unwrap().len());
    assert_eq!(std::fs::read(out.path().join("my plan.pdf")).unwrap(), b"old");
    assert_eq!(names(out.path()), ["my plan (1).pdf", "my plan.pdf"]);
}

#[test]
fn a_bad_list_is_refused_before_anything_is_written() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = pdf_with(&src, "doc.pdf", 2);
    let (_registry, ids, sources) = registered(&[&doc], &[entry("0", 1, 0, false)]);
    let id = ids[0].as_str();

    let fail = |refs: Vec<PageRef>| -> String {
        let err = assemble(&sources, &refs, &options(out.path()), &ctx()).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert!(names(out.path()).is_empty(), "nothing is left behind");
        err.to_string()
    };
    assert!(fail(vec![]).contains("no pages"));
    assert!(fail(vec![entry(id, 3, 0, false)]).contains("page 3"));
    assert!(fail(vec![entry(id, 0, 0, false)]).contains("page 0"));
    assert!(fail(vec![entry(id, 1, 360, false)]).contains("rotation"));
    assert!(fail(vec![entry(id, 1, -90, false)]).contains("rotation"));
    assert!(fail(vec![entry(id, 1, 45, false)]).contains("rotation"));
    assert!(fail(vec![entry("gone", 1, 0, false)]).contains("no longer available"));
    // The first valid entry does not excuse a later bad one.
    assert!(fail(vec![entry(id, 1, 0, false), entry(id, 9, 0, false)]).contains("Page entry 2"));
}

#[test]
fn cancelling_removes_the_partial_file() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let doc = pdf_with(&src, "doc.pdf", 3);
    let (_registry, ids, sources) = registered(&[&doc], &[entry("0", 1, 0, false)]);
    let refs: Vec<PageRef> = (1..=3).map(|p| entry(&ids[0], p, 0, false)).collect();

    let token = CancelToken::new();
    token.cancel();
    let cancelled = JobContext::new(1, token, None);
    let err = assemble(&sources, &refs, &options(out.path()), &cancelled).unwrap_err();
    assert!(err.is_cancelled());
    assert!(names(out.path()).is_empty());

    // Cancelled part way: after the first page is reported.
    let token = CancelToken::new();
    let stopper = token.clone();
    let sink: dokuwu_core::job::ProgressSink = Arc::new(move |_, p| {
        if p.done >= 1 && p.stage == "pages" {
            stopper.cancel();
        }
    });
    let ctx = JobContext::new(2, token, Some(sink)).with_min_interval(std::time::Duration::ZERO);
    let err = assemble(&sources, &refs, &options(out.path()), &ctx).unwrap_err();
    assert!(err.is_cancelled());
    assert!(names(out.path()).is_empty(), "{:?}", names(out.path()));
}

#[test]
fn flushing_to_disk_part_way_gives_the_same_pages() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = pdf_with(&src, "a.pdf", 6);
    let b = pdf_with(&src, "b.pdf", 6);
    let photo = write_picture(src.path(), "photo.png", 50, 50);
    let refs: Vec<PageRef> = (1..=6)
        .flat_map(|p| [entry("0", p, 0, p % 2 == 0), entry("1", 7 - p, 90, false), entry("2", 1, 0, false)])
        .collect();
    let (_registry, ids, sources) = registered(&[&a, &b, &photo], &refs);
    let real: Vec<PageRef> =
        refs.iter().map(|r| PageRef { source: ids[r.source.parse::<usize>().unwrap()].clone(), ..r.clone() }).collect();

    let plain_dir = tempfile::tempdir().unwrap();
    let plain = assemble(&sources, &real, &options(plain_dir.path()), &ctx()).unwrap().output_path;
    let mut flush = options(out.path());
    flush.flush_after_bytes = Some(1);
    let flushed = assemble(&sources, &real, &flush, &ctx()).unwrap().output_path;

    assert_eq!(page_count(&flushed), 18);
    assert_eq!(names(out.path()), ["organized.pdf"], "temporary files are gone");
    for page in 1..=18 {
        assert!(render(&plain, page) == render(&flushed, page), "page {page}");
    }
}
