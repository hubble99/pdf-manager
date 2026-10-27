//! End-to-end tests for Compress PDF on the fixtures in
//! `tests/fixtures/pdf-compress/` (built by `make_fixtures.py`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use dokuwu_core::job::{CancelToken, JobContext, ProgressSink};
use dokuwu_core::ops::pdf_compress::{
    compress_pdf, compress_pdf_with, probe_pdf, CompressOptions, PdfCompressReport,
};
use dokuwu_core::resources::{MemoryProbe, MIB};
use mupdf::pdf::PdfDocument;
use mupdf::{Colorspace, Document, Matrix};

// The working folders are named after the process id, so a test that checks
// none are left behind must not run while another test is compressing.
static WORK_DIRS: RwLock<()> = RwLock::new(());

fn shared() -> RwLockReadGuard<'static, ()> {
    WORK_DIRS.read().unwrap_or_else(|e| e.into_inner())
}

fn exclusive() -> RwLockWriteGuard<'static, ()> {
    WORK_DIRS.write().unwrap_or_else(|e| e.into_inner())
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf-compress").join(name)
}

fn run(name: &str, quality: u8) -> (tempfile::TempDir, PathBuf, PdfCompressReport) {
    run_with(name, CompressOptions::new(quality))
}

fn run_with(name: &str, options: CompressOptions) -> (tempfile::TempDir, PathBuf, PdfCompressReport) {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out.pdf");
    let report = compress_pdf(&fixture(name), &out, &options, &JobContext::detached()).unwrap();
    (dir, out, report)
}

struct Rendered {
    width: u32,
    height: u32,
    rgb: Vec<u8>,
}

impl Rendered {
    fn pixel(&self, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * self.width + x) * 3) as usize;
        [self.rgb[i], self.rgb[i + 1], self.rgb[i + 2]]
    }

    /// Mean absolute difference per channel, 0 to 255.
    fn distance(&self, other: &Rendered) -> f64 {
        assert_eq!((self.width, self.height), (other.width, other.height));
        let sum: u64 = self.rgb.iter().zip(&other.rgb).map(|(a, b)| a.abs_diff(*b) as u64).sum();
        sum as f64 / self.rgb.len() as f64
    }
}

fn render(path: &Path) -> Rendered {
    let doc = Document::open(path.to_str().unwrap()).unwrap();
    let page = doc.load_page(0).unwrap();
    let pix = page
        .to_pixmap(&Matrix::IDENTITY, &Colorspace::device_rgb(), false, false)
        .unwrap();
    let (w, h, n) = (pix.width(), pix.height(), pix.n() as usize);
    let samples = pix.samples();
    let stride = pix.stride() as usize;
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h as usize {
        for x in 0..w as usize {
            let i = y * stride + x * n;
            rgb.extend_from_slice(&samples[i..i + 3]);
        }
    }
    Rendered { width: w, height: h, rgb }
}

fn pages(path: &Path) -> i32 {
    Document::open(path.to_str().unwrap()).unwrap().page_count().unwrap()
}

/// (Filter, ColorSpace family) of every image object in the file.
fn image_objects(path: &Path) -> Vec<(String, String)> {
    let doc = PdfDocument::open(path.to_str().unwrap()).unwrap();
    let mut found = Vec::new();
    for xref in 1..doc.count_objects().unwrap() as i32 {
        let obj = doc.new_indirect(xref, 0).unwrap();
        if !obj.is_stream().unwrap() {
            continue;
        }
        let is_image = obj
            .get_dict("Subtype")
            .unwrap()
            .is_some_and(|s| s.is_name().unwrap() && s.as_name().unwrap() == b"Image");
        if !is_image {
            continue;
        }
        let filter = obj
            .get_dict("Filter")
            .unwrap()
            .map(|f| {
                if f.is_name().unwrap() {
                    String::from_utf8(f.as_name().unwrap()).unwrap()
                } else {
                    "array".into()
                }
            })
            .unwrap_or_default();
        let cs = obj.get_dict("ColorSpace").unwrap().unwrap();
        let family = if cs.is_name().unwrap() {
            String::from_utf8(cs.as_name().unwrap()).unwrap()
        } else {
            String::from_utf8(cs.get_array(0).unwrap().unwrap().as_name().unwrap()).unwrap()
        };
        found.push((filter, family));
    }
    found
}

/// The raw stream of every image object, in file order.
fn image_streams(path: &Path) -> Vec<Vec<u8>> {
    let doc = PdfDocument::open(path.to_str().unwrap()).unwrap();
    let mut streams = Vec::new();
    for xref in 1..doc.count_objects().unwrap() as i32 {
        let obj = doc.new_indirect(xref, 0).unwrap();
        let is_image = obj.is_stream().unwrap()
            && obj.get_dict("Subtype").unwrap().is_some_and(|s| s.is_name().unwrap() && s.as_name().unwrap() == b"Image");
        if is_image {
            streams.push(obj.read_raw_stream().unwrap());
        }
    }
    streams
}

#[test]
fn rgb_photo_becomes_a_small_jpeg_that_still_looks_the_same() {
    let _guard = shared();
    let (_dir, out, report) = run("photo.pdf", 70);
    assert_eq!(report.images_found, 1);
    assert_eq!(report.images_recompressed, 1);
    assert!(!report.kept_original);
    assert!(report.size_after * 5 < report.size_before, "{report:?}");
    assert_eq!(report.size_after, fs::metadata(&out).unwrap().len());
    assert_eq!(pages(&out), 1);
    assert!(render(&out).distance(&render(&fixture("photo.pdf"))) < 6.0);
    assert_eq!(image_objects(&out), vec![("DCTDecode".into(), "DeviceRGB".into())]);
}

#[test]
fn grey_photo_stays_grey() {
    let _guard = shared();
    let (_dir, out, report) = run("gray.pdf", 60);
    assert_eq!(report.images_recompressed, 1);
    assert_eq!(image_objects(&out), vec![("DCTDecode".into(), "DeviceGray".into())]);
    assert!(render(&out).distance(&render(&fixture("gray.pdf"))) < 6.0);
}

#[test]
fn a_high_quality_jpeg_is_re_encoded_smaller() {
    let _guard = shared();
    let (_dir, _out, report) = run("jpeg-source.pdf", 50);
    assert_eq!(report.images_recompressed, 1);
    assert!(report.size_after < report.size_before / 2, "{report:?}");
}

#[test]
fn lower_quality_gives_a_smaller_file() {
    let _guard = shared();
    let (_a, _, low) = run("photo.pdf", 20);
    let (_b, _, high) = run("photo.pdf", 90);
    assert!(low.size_after < high.size_after, "{low:?} vs {high:?}");
}

#[test]
fn transparent_corners_stay_transparent() {
    let _guard = shared();
    let (_dir, out, report) = run("transparent.pdf", 30);
    assert_eq!(report.images_found, 1, "the soft mask is not a picture of its own");
    assert_eq!(report.images_recompressed, 1);
    let before = render(&fixture("transparent.pdf"));
    let after = render(&out);
    // Black sits under the fully transparent corners; they must stay page-white.
    assert_eq!(before.pixel(14, 14), [255, 255, 255]);
    assert_eq!(after.pixel(14, 14), [255, 255, 255]);
    let (b, a) = (before.pixel(150, 150), after.pixel(150, 150));
    let diff: i32 = b.iter().zip(&a).map(|(x, y)| (*x as i32 - *y as i32).abs()).sum();
    assert!(diff < 160, "centre moved by {diff}");
}

#[test]
fn pictures_jpeg_cannot_carry_are_left_exactly_as_they_are() {
    let _guard = shared();
    for name in ["stencil.pdf", "indexed.pdf", "cmyk.pdf"] {
        let (_dir, out, report) = run(name, 30);
        assert_eq!(report.images_found, 0, "{name}");
        assert_eq!(render(&out).distance(&render(&fixture(name))), 0.0, "{name}");
        let before = image_objects(&fixture(name));
        let after = image_objects(&out);
        assert_eq!(before, after, "{name}");
    }
}

#[test]
fn an_icc_profile_survives() {
    let _guard = shared();
    let (_dir, out, report) = run("icc.pdf", 50);
    assert_eq!(report.images_recompressed, 1);
    assert_eq!(image_objects(&out), vec![("DCTDecode".into(), "ICCBased".into())]);
}

#[test]
fn a_picture_used_on_many_pages_is_one_object() {
    let _guard = shared();
    let (_dir, out, report) = run("shared.pdf", 50);
    assert_eq!(report.images_found, 1);
    assert_eq!(report.pages, 3);
    assert_eq!(pages(&out), 3);
}

/// A PDF whose three pages each carry their own copy of the same picture (as
/// Canva writes them), plus one different picture.
fn duplicated_pictures_pdf(path: &Path) {
    fn noise(seed: u32) -> Vec<u8> {
        let mut x = seed;
        (0..64 * 64 * 3)
            .map(|_| {
                x = x.wrapping_mul(1664525).wrapping_add(1013904223);
                (x >> 24) as u8
            })
            .collect()
    }
    let picture = |data: &[u8]| {
        let mut bytes = format!(
            "<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length {} >>\nstream\n",
            data.len()
        )
        .into_bytes();
        bytes.extend_from_slice(data);
        bytes.extend_from_slice(b"\nendstream");
        bytes
    };
    let same = noise(1);
    let mut objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>".to_vec(),
    ];
    // Pages 3-5 use pictures 6, 7, 8 (identical) and 9 (different, on the last page).
    for (page, image) in [(0, 6), (1, 7), (2, 8)] {
        let extra = if page == 2 { " /Im9 9 0 R" } else { "" };
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im{image} {image} 0 R{extra} >> >> /Contents {} 0 R >>",
                10 + page
            )
            .into_bytes(),
        );
    }
    for _ in 0..3 {
        objects.push(picture(&same));
    }
    objects.push(picture(&noise(2)));
    for (page, image) in [(0, 6), (1, 7), (2, 8)] {
        let extra = if page == 2 { " q 50 0 0 50 120 20 cm /Im9 Do Q" } else { "" };
        let content = format!("q 80 0 0 80 20 100 cm /Im{image} Do Q{extra}");
        objects.push(format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()).into_bytes());
    }
    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        bytes.extend_from_slice(object);
        bytes.extend_from_slice(b"\nendobj\n");
    }
    let xref = bytes.len();
    bytes.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(
        format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes(),
    );
    fs::write(path, bytes).unwrap();
}

#[test]
fn copies_of_the_same_picture_are_merged_into_one() {
    let _guard = shared();
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("copies.pdf");
    duplicated_pictures_pdf(&input);
    let out = dir.path().join("out.pdf");
    let report = compress_pdf(&input, &out, &CompressOptions::new(50), &JobContext::detached()).unwrap();
    // One copy of the repeated picture and the different one are all that is left.
    assert_eq!(report.images_found, 2);
    assert_eq!(image_streams(&out).len(), 2);
    assert_eq!(pages(&out), 3);
    // Every page still shows its picture.
    let before = Document::open(input.to_str().unwrap()).unwrap();
    let after = Document::open(out.to_str().unwrap()).unwrap();
    for index in 0..3 {
        let draw = |doc: &Document| {
            let page = doc.load_page(index).unwrap();
            let pixmap = page.to_pixmap(&Matrix::new(1.0, 0.0, 0.0, 1.0, 0.0, 0.0), &Colorspace::device_rgb(), false, false).unwrap();
            pixmap.samples().to_vec()
        };
        let (a, b) = (draw(&before), draw(&after));
        let mean = a.iter().zip(&b).map(|(x, y)| x.abs_diff(*y) as u64).sum::<u64>() as f64 / a.len() as f64;
        assert!(mean < 12.0, "page {index} changed by {mean}");
    }
}

#[test]
fn worker_count_does_not_change_the_result() {
    let _guard = shared();
    let mut one = CompressOptions::new(60);
    one.max_workers = Some(1);
    let mut four = CompressOptions::new(60);
    four.max_workers = Some(4);
    let (_a, out_a, ra) = run_with("many.pdf", one);
    let (_b, out_b, rb) = run_with("many.pdf", four);
    assert_eq!(ra.images_recompressed, 6);
    assert_eq!(rb.images_recompressed, 6);
    // The trailer carries a fresh random /ID per save, which can change the
    // deflated size by a byte, so compare content and allow a few bytes.
    assert!(ra.size_after.abs_diff(rb.size_after) <= 16, "{} vs {}", ra.size_after, rb.size_after);
    assert_eq!(render(&out_a).distance(&render(&out_b)), 0.0);
    assert_eq!(image_streams(&out_a), image_streams(&out_b));
}

/// Batches are flushed to a working copy with incremental saves. Forcing a
/// flush after every picture must give the same pictures as a single save.
#[test]
fn flushing_in_batches_gives_the_same_result() {
    let _guard = exclusive();
    let (_a, direct, rd) = run("many.pdf", 60);
    let mut tiny = CompressOptions::new(60);
    tiny.batch_bytes = Some(1);
    tiny.max_workers = Some(2);
    let (_b, staged, rs) = run_with("many.pdf", tiny);
    assert_eq!(rs.images_recompressed, 6);
    assert!(rd.size_after.abs_diff(rs.size_after) <= 16, "{} vs {}", rd.size_after, rs.size_after);
    assert_eq!(pages(&staged), pages(&direct));
    assert_eq!(render(&staged).distance(&render(&direct)), 0.0);
    assert_eq!(image_objects(&staged), image_objects(&direct));
    assert!(leftover_work_dirs().is_empty(), "working folder not removed");
}

fn leftover_work_dirs() -> Vec<PathBuf> {
    let prefix = format!("dokuwu-compress-{}-", std::process::id());
    fs::read_dir(std::env::temp_dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&prefix)))
        .collect()
}

#[test]
fn structure_cleanup_shrinks_a_pdf_without_pictures() {
    let _guard = shared();
    let (_dir, out, report) = run("text-plain.pdf", 70);
    assert_eq!(report.images_found, 0);
    assert!(report.size_after * 4 < report.size_before, "{report:?}");
    assert_eq!(pages(&out), 3);
    assert_eq!(render(&out).distance(&render(&fixture("text-plain.pdf"))), 0.0);
}

#[test]
fn a_file_that_cannot_shrink_is_returned_unchanged() {
    let _guard = shared();
    let (_dir, out, report) = run("tiny.pdf", 70);
    assert!(report.kept_original);
    assert_eq!(report.reduction_pct, 0.0);
    assert_eq!(report.size_after, report.size_before);
    assert_eq!(fs::read(&out).unwrap(), fs::read(fixture("tiny.pdf")).unwrap());
}

#[test]
fn an_existing_output_is_replaced_only_by_a_complete_file() {
    let _guard = shared();
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out.pdf");
    fs::write(&out, b"old").unwrap();
    compress_pdf(&fixture("photo.pdf"), &out, &CompressOptions::new(50), &JobContext::detached()).unwrap();
    assert!(fs::read(&out).unwrap().starts_with(b"%PDF"));
    assert!(!dir.path().join("out.pdf.part").exists());
}

/// (stage, done, total) of one progress report.
type Step = (String, u64, Option<u64>);

#[test]
fn progress_reports_scanning_images_and_saving() {
    let _guard = shared();
    let stages: Arc<std::sync::Mutex<Vec<Step>>> = Default::default();
    let seen = stages.clone();
    let sink: ProgressSink = Arc::new(move |_, p| {
        seen.lock().unwrap().push((p.stage.clone(), p.done, p.total));
    });
    let ctx = JobContext::new(1, CancelToken::new(), Some(sink)).with_min_interval(std::time::Duration::ZERO);
    let dir = tempfile::tempdir().unwrap();
    compress_pdf(&fixture("many.pdf"), &dir.path().join("o.pdf"), &CompressOptions::new(50), &ctx).unwrap();
    let stages = stages.lock().unwrap();
    let image_steps: Vec<_> = stages.iter().filter(|s| s.0 == "images").collect();
    assert_eq!(image_steps.first().unwrap().1, 0);
    assert_eq!(image_steps.last().unwrap(), &&("images".to_string(), 6, Some(6)));
    assert!(stages.iter().any(|s| s.0 == "saving"));
    // Image progress never goes backwards.
    assert!(image_steps.windows(2).all(|w| w[0].1 <= w[1].1));
}

#[test]
fn cancelling_leaves_no_output_and_no_partial_file() {
    let _guard = shared();
    let token = CancelToken::new();
    let trigger = token.clone();
    let sink: ProgressSink = Arc::new(move |_, p| {
        if p.stage == "images" && p.done >= 2 {
            trigger.cancel();
        }
    });
    let ctx = JobContext::new(1, token, Some(sink)).with_min_interval(std::time::Duration::ZERO);
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("o.pdf");
    let mut options = CompressOptions::new(50);
    options.max_workers = Some(1);
    let err = compress_pdf(&fixture("many.pdf"), &out, &options, &ctx).unwrap_err();
    assert!(err.is_cancelled(), "{err}");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn cancelling_a_staged_run_removes_the_working_copy() {
    let _guard = exclusive();
    let token = CancelToken::new();
    let trigger = token.clone();
    let sink: ProgressSink = Arc::new(move |_, p| {
        if p.stage == "images" && p.done >= 1 {
            trigger.cancel();
        }
    });
    let ctx = JobContext::new(1, token, Some(sink)).with_min_interval(std::time::Duration::ZERO);
    let dir = tempfile::tempdir().unwrap();
    let mut options = CompressOptions::new(50);
    options.batch_bytes = Some(1);
    let err = compress_pdf(&fixture("many.pdf"), &dir.path().join("o.pdf"), &options, &ctx).unwrap_err();
    assert!(err.is_cancelled());
    assert!(leftover_work_dirs().is_empty());
}

#[test]
fn a_password_protected_pdf_is_refused() {
    let _guard = shared();
    let dir = tempfile::tempdir().unwrap();
    let err = compress_pdf(
        &fixture("encrypted.pdf"),
        &dir.path().join("o.pdf"),
        &CompressOptions::new(50),
        &JobContext::detached(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "password_required");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn a_permission_only_pdf_opens_and_compresses() {
    let _guard = shared();
    // Owner password only: no password is needed to open it.
    assert!(!probe_pdf(&fixture("owner-only.pdf")).unwrap().encrypted);
    let (_dir, out, report) = run("owner-only.pdf", 50);
    assert!(report.size_after < report.size_before);
    assert_eq!(pages(&out), 1);
}

#[test]
fn bad_input_gets_clear_errors() {
    let _guard = shared();
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("o.pdf");
    let options = CompressOptions::new(50);
    let ctx = JobContext::detached();
    assert_eq!(compress_pdf(&fixture("not-a-pdf.pdf"), &out, &options, &ctx).unwrap_err().code(), "invalid_input");
    assert_eq!(compress_pdf(&fixture("missing.pdf"), &out, &options, &ctx).unwrap_err().code(), "not_found");
    assert_eq!(compress_pdf(dir.path(), &out, &options, &ctx).unwrap_err().code(), "invalid_input");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

struct FixedMemory(u64);

impl MemoryProbe for FixedMemory {
    fn available_bytes(&self) -> u64 {
        self.0
    }
    fn total_bytes(&self) -> u64 {
        16 * 1024 * MIB
    }
}

/// With almost no memory to spare a picture is left as it is instead of being
/// decoded, and the file is still produced.
#[test]
fn pictures_too_big_for_free_memory_are_skipped() {
    let _guard = shared();
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("o.pdf");
    // Just above the brake's floor of 256 MiB: nothing is left to decode into.
    let tight = Arc::new(FixedMemory(256 * MIB + 1));
    let report = compress_pdf_with(
        &fixture("many.pdf"),
        &out,
        &CompressOptions::new(50),
        &JobContext::detached(),
        tight,
    )
    .unwrap();
    assert_eq!(report.images_found, 6);
    assert_eq!(report.images_recompressed, 0);
    assert_eq!(pages(&out), 6);
}

#[test]
fn probe_reports_size_pages_and_protection() {
    let _guard = shared();
    let p = probe_pdf(&fixture("shared.pdf")).unwrap();
    assert_eq!(p.pages, 3);
    assert!(!p.encrypted);
    assert_eq!(p.size_bytes, fs::metadata(fixture("shared.pdf")).unwrap().len());
    assert!(probe_pdf(&fixture("encrypted.pdf")).unwrap().encrypted);
    assert_eq!(probe_pdf(&fixture("missing.pdf")).unwrap_err().code(), "not_found");
}
