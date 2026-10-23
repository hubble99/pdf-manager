//! Page previews and PDF info (`ops::pdf_render`). Small PDFs are built in the
//! test; the encrypted and damaged files come from `tests/fixtures/pdf-compress/`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dokuwu_core::ops::pdf_render::{editor_dpi, pages_meta, pdf_info, QualityHint, RenderDocument, RenderService};
use dokuwu_core::CoreError;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf-compress").join(name)
}

struct PageSpec {
    media: [f32; 4],
    crop: Option<[f32; 4]>,
    rotate: i32,
    content: &'static str,
}

impl PageSpec {
    fn new(width: f32, height: f32, content: &'static str) -> Self {
        Self { media: [0.0, 0.0, width, height], crop: None, rotate: 0, content }
    }
}

/// A valid PDF with the given pages and an optional /Info title.
fn build_pdf(pages: &[PageSpec], title: Option<&str>) -> Vec<u8> {
    let mut objects: Vec<String> = Vec::new();
    // 1 catalog, 2 pages, 3 info, then (page, content) pairs.
    objects.push("<< /Type /Catalog /Pages 2 0 R >>".into());
    let kids: Vec<String> = (0..pages.len()).map(|i| format!("{} 0 R", 4 + i * 2)).collect();
    objects.push(format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages.len()));
    objects.push(match title {
        Some(t) => format!("<< /Title ({t}) /Author (Dokuwu) >>"),
        None => "<< >>".into(),
    });
    for (i, page) in pages.iter().enumerate() {
        let m = page.media;
        let mut dict = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [{} {} {} {}] /Rotate {} /Contents {} 0 R /Resources << >>",
            m[0], m[1], m[2], m[3], page.rotate, 5 + i * 2
        );
        if let Some(c) = page.crop {
            dict.push_str(&format!(" /CropBox [{} {} {} {}]", c[0], c[1], c[2], c[3]));
        }
        dict.push_str(" >>");
        objects.push(dict);
        objects.push(format!("<< /Length {} >>\nstream\n{}\nendstream", page.content.len(), page.content));
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
    out.extend_from_slice(
        format!("trailer\n<< /Size {} /Root 1 0 R /Info 3 0 R >>\nstartxref\n{}\n%%EOF\n", objects.len() + 1, xref).as_bytes(),
    );
    out
}

fn write_pdf(dir: &tempfile::TempDir, name: &str, pages: &[PageSpec], title: Option<&str>) -> PathBuf {
    let path = dir.path().join(name);
    std::fs::write(&path, build_pdf(pages, title)).unwrap();
    path
}

struct Decoded {
    width: u32,
    height: u32,
    rgb: Vec<u8>,
}

impl Decoded {
    fn pixel(&self, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * self.width + x) * 3) as usize;
        [self.rgb[i], self.rgb[i + 1], self.rgb[i + 2]]
    }
}

fn decode(png_bytes: &[u8]) -> Decoded {
    let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgb);
    buf.truncate(info.buffer_size());
    Decoded { width: info.width, height: info.height, rgb: buf }
}

fn render(path: &Path, page: u32, dpi: u32, hint: QualityHint) -> Decoded {
    let doc = RenderDocument::open(path).unwrap();
    let page = doc.render(page, dpi, hint).unwrap();
    let decoded = decode(&page.png);
    assert_eq!((decoded.width, decoded.height), (page.width, page.height));
    decoded
}

#[test]
fn an_a4_page_renders_at_its_size_on_white() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_pdf(&dir, "a4.pdf", &[PageSpec::new(595.0, 842.0, "0 0 0 rg 100 100 200 200 re f")], None);
    let img = render(&path, 1, 72, QualityHint::Auto);
    assert_eq!((img.width, img.height), (595, 842));
    assert_eq!(img.pixel(5, 5), [255, 255, 255]);
    // PDF y runs upward: the black square sits 100..300 from the bottom.
    assert_eq!(img.pixel(200, 842 - 200), [0, 0, 0]);
}

#[test]
fn a_rotated_page_renders_as_it_is_shown() {
    let dir = tempfile::tempdir().unwrap();
    let mut page = PageSpec::new(595.0, 842.0, "");
    page.rotate = 90;
    let path = write_pdf(&dir, "rot.pdf", &[page], None);
    let img = render(&path, 1, 72, QualityHint::Auto);
    assert_eq!((img.width, img.height), (842, 595));
}

#[test]
fn the_crop_box_decides_the_visible_area() {
    let dir = tempfile::tempdir().unwrap();
    let mut page = PageSpec::new(600.0, 800.0, "1 0 0 rg 100 100 300 400 re f");
    page.crop = Some([100.0, 100.0, 400.0, 500.0]);
    let path = write_pdf(&dir, "crop.pdf", &[page], None);
    let img = render(&path, 1, 72, QualityHint::Auto);
    assert_eq!((img.width, img.height), (300, 400));
    assert_eq!(img.pixel(150, 200), [255, 0, 0]);
}

#[test]
fn a_big_sheet_is_scaled_down_to_the_hint() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_pdf(&dir, "sheet.pdf", &[PageSpec::new(1500.0, 1000.0, "0 g 0 0 100 100 re f")], None);
    let doc = RenderDocument::open(&path).unwrap();
    let low = doc.render(1, 300, QualityHint::Low).unwrap();
    let auto = doc.render(1, 300, QualityHint::Auto).unwrap();
    let high = doc.render(1, 300, QualityHint::High).unwrap();
    assert!((900..=1030).contains(&low.width), "{}", low.width);
    assert!((1900..=2060).contains(&auto.width), "{}", auto.width);
    assert!((3900..=4110).contains(&high.width), "{}", high.width);
}

#[test]
fn the_dpi_floor_wins_over_the_hint_for_a_poster() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_pdf(&dir, "poster.pdf", &[PageSpec::new(5669.0, 4000.0, "0 g 0 0 100 100 re f")], None);
    let doc = RenderDocument::open(&path).unwrap();
    let page = doc.render(1, 300, QualityHint::Low).unwrap();
    assert_eq!(page.dpi, 36);
    assert!((2800..=2850).contains(&page.width), "{}", page.width);
}

#[test]
fn cmyk_colour_is_converted_with_icc_not_with_the_plain_formula() {
    // Pure cyan: the plain formula gives (0, 255, 255); a colour-managed
    // conversion gives the deeper cyan a viewer shows, with less green.
    let dir = tempfile::tempdir().unwrap();
    let path = write_pdf(&dir, "cmyk.pdf", &[PageSpec::new(100.0, 100.0, "1 0 0 0 k 0 0 100 100 re f")], None);
    let img = render(&path, 1, 72, QualityHint::Auto);
    let [r, g, b] = img.pixel(50, 50);
    assert!(g < 230, "green {g} looks like the plain CMYK formula");
    assert!(b > 150 && r < 100, "unexpected cyan {r},{g},{b}");
}

#[test]
fn a_page_outside_the_document_is_invalid_input() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_pdf(&dir, "two.pdf", &[PageSpec::new(100.0, 100.0, ""), PageSpec::new(100.0, 100.0, "")], None);
    let doc = RenderDocument::open(&path).unwrap();
    assert_eq!(doc.page_count(), 2);
    for page in [0, 3] {
        let err = doc.render(page, 72, QualityHint::Auto).unwrap_err();
        assert_eq!(err.code(), "invalid_input", "{err}");
        assert!(err.to_string().contains("2 pages"), "{err}");
    }
}

#[test]
fn an_encrypted_pdf_asks_for_a_password() {
    let err = RenderDocument::open(&fixture("encrypted.pdf")).err().unwrap();
    assert!(matches!(err, CoreError::PasswordRequired));
    let info = pdf_info(&fixture("encrypted.pdf")).unwrap();
    assert!(info.encrypted);
    assert_eq!(info.pages, 0);
}

#[test]
fn an_owner_password_only_pdf_still_previews() {
    let doc = RenderDocument::open(&fixture("owner-only.pdf")).unwrap();
    assert!(doc.page_count() >= 1);
    doc.render(1, 72, QualityHint::Low).unwrap();
}

#[test]
fn damaged_and_missing_files_are_reported() {
    assert_eq!(RenderDocument::open(&fixture("not-a-pdf.pdf")).err().unwrap().code(), "invalid_input");
    assert_eq!(RenderDocument::open(&fixture("nope.pdf")).err().unwrap().code(), "not_found");
    assert_eq!(pdf_info(&fixture("nope.pdf")).unwrap_err().code(), "not_found");
}

#[test]
fn info_reports_pages_size_and_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_pdf(&dir, "titled.pdf", &[PageSpec::new(100.0, 100.0, ""), PageSpec::new(50.0, 50.0, "")], Some("Annual report"));
    let info = pdf_info(&path).unwrap();
    assert_eq!(info.pages, 2);
    assert!(!info.encrypted);
    assert_eq!(info.size_bytes, std::fs::metadata(&path).unwrap().len());
    assert_eq!(info.metadata.title, "Annual report");
    assert_eq!(info.metadata.author, "Dokuwu");
    assert!(info.metadata.format.starts_with("PDF"), "{}", info.metadata.format);
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["metadata"]["creationDate"], "");
}

#[test]
fn a_photo_fixture_renders_through_the_service() {
    let service = RenderService::new();
    let page = service.render(&fixture("photo.pdf"), 1, 72, QualityHint::Low).unwrap();
    assert!(page.width > 0 && page.height > 0);
    assert_eq!(decode(&page.png).width, page.width);
}

#[test]
fn many_threads_can_ask_the_service_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let pages: Vec<PageSpec> = (0..12).map(|_| PageSpec::new(200.0, 300.0, "0 g 10 10 50 50 re f")).collect();
    let path = write_pdf(&dir, "twelve.pdf", &pages, None);
    let service = Arc::new(RenderService::new());
    let handles: Vec<_> = (1..=12u32)
        .map(|page| {
            let service = Arc::clone(&service);
            let path = path.clone();
            std::thread::spawn(move || service.render(&path, page, 72, QualityHint::Low).unwrap())
        })
        .collect();
    for handle in handles {
        let page = handle.join().unwrap();
        assert_eq!((page.width, page.height), (200, 300));
    }
}

#[test]
fn a_file_that_changes_on_disk_is_opened_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_pdf(&dir, "edit.pdf", &[PageSpec::new(100.0, 100.0, "")], None);
    let service = RenderService::with_workers(1);
    assert_eq!(service.render(&path, 1, 72, QualityHint::Auto).unwrap().width, 100);
    // Same name, different content and length.
    std::fs::write(&path, build_pdf(&[PageSpec::new(300.0, 100.0, "0 g 0 0 10 10 re f"), PageSpec::new(10.0, 10.0, "")], Some("x"))).unwrap();
    assert_eq!(service.render(&path, 1, 72, QualityHint::Auto).unwrap().width, 300);
    assert!(service.render(&path, 2, 72, QualityHint::Auto).is_ok());
}

#[test]
fn errors_from_the_service_keep_their_codes() {
    let service = RenderService::with_workers(1);
    assert_eq!(service.render(&fixture("encrypted.pdf"), 1, 72, QualityHint::Auto).unwrap_err().code(), "password_required");
    assert_eq!(service.render(&fixture("nope.pdf"), 1, 72, QualityHint::Auto).unwrap_err().code(), "not_found");
    // A failed request does not stop the worker.
    assert!(service.render(&fixture("photo.pdf"), 1, 72, QualityHint::Low).is_ok());
}

#[test]
fn a_stopped_service_answers_with_an_error() {
    let service = RenderService::with_workers(1);
    service.shutdown();
    assert_eq!(service.render(&fixture("photo.pdf"), 1, 72, QualityHint::Low).unwrap_err().code(), "internal");
}


#[test]
fn editor_dpi_clamps_and_keeps_pages_under_the_pixel_ceiling() {
    assert_eq!(editor_dpi(595.0, 842.0, 10), 72);
    assert_eq!(editor_dpi(595.0, 842.0, 200), 200);
    assert_eq!(editor_dpi(595.0, 842.0, 9999), 500);
    // 14400 x 14400 pt at 500 dpi is far over 60 megapixels.
    let dpi = editor_dpi(14400.0, 14400.0, 500);
    let side = 14400.0 * dpi as f64 / 72.0;
    assert!(dpi < 500 && side * side <= 60_000_000.0, "{dpi}");
}

#[test]
fn pages_meta_gives_every_page_size_as_rendered() {
    let dir = tempfile::tempdir().unwrap();
    let mut rotated = PageSpec::new(300.0, 500.0, "");
    rotated.rotate = 90;
    let mut cropped = PageSpec::new(612.0, 792.0, "");
    cropped.crop = Some([10.0, 20.0, 310.0, 420.0]);
    let path = write_pdf(&dir, "mixed.pdf", &[PageSpec::new(595.0, 842.0, ""), rotated, cropped], None);

    let meta = pages_meta(&path, 200).unwrap();
    assert_eq!(meta.total, 3);
    assert_eq!((meta.pages[0].index, meta.pages[2].index), (0, 2));
    assert_eq!((meta.pages[1].width_pt, meta.pages[1].height_pt), (500.0, 300.0));
    assert_eq!((meta.pages[2].width_pt, meta.pages[2].height_pt), (300.0, 400.0));

    // The announced pixel size is what a render at that dpi produces.
    let doc = RenderDocument::open(&path).unwrap();
    for page in &meta.pages {
        let rendered = doc.render_editor(page.index + 1, 200).unwrap();
        assert_eq!((rendered.width, rendered.height, rendered.dpi), (page.width, page.height, page.dpi));
    }
}

#[test]
fn editor_renders_go_through_the_shared_service() {
    let service = RenderService::new();
    let low = service.render_editor(&fixture("photo.pdf"), 1, 72).unwrap();
    let high = service.render_editor(&fixture("photo.pdf"), 1, 200).unwrap();
    assert_eq!((low.dpi, high.dpi), (72, 200));
    assert!(high.width > low.width);
    assert_eq!(&high.png[..8], b"\x89PNG\r\n\x1a\n");
    assert!(matches!(service.render_editor(&fixture("photo.pdf"), 99, 200), Err(CoreError::InvalidInput(_))));
    assert!(matches!(service.render_editor(&fixture("encrypted.pdf"), 1, 200), Err(CoreError::PasswordRequired)));
}

#[test]
fn pages_meta_refuses_a_protected_pdf() {
    assert!(matches!(pages_meta(&fixture("encrypted.pdf"), 200), Err(CoreError::PasswordRequired)));
}
