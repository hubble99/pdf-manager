//! Converts the sample PDFs in tests/fixtures/pdf-to-word and checks what
//! survives in the .docx. The samples are built by make_fixtures.py there.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use dokuwu_core::ops::pdf_to_word::{convert_pdf_to_docx, PdfToWordReport};
use dokuwu_core::{CancelToken, CoreError, JobContext};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf-to-word").join(name)
}

fn convert(name: &str) -> (PdfToWordReport, HashMap<String, Vec<u8>>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out.docx");
    let report = convert_pdf_to_docx(&fixture(name), &out, &JobContext::detached()).unwrap();
    assert_eq!(report.output_path, out);
    let files = read_zip(&std::fs::read(&out).unwrap());
    (report, files, dir)
}

fn document(files: &HashMap<String, Vec<u8>>) -> String {
    String::from_utf8(files["word/document.xml"].clone()).unwrap()
}

/// Text of the document with tags removed and tabs kept as `\t`.
fn plain_text(xml: &str) -> String {
    let xml = xml.replace("<w:tab/>", "\t").replace("</w:p>", "\n");
    let mut out = String::new();
    let mut in_tag = false;
    for c in xml.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
}

/// Minimal ZIP reader for the test: central directory, stored or deflated entries.
fn read_zip(data: &[u8]) -> HashMap<String, Vec<u8>> {
    let u16_at = |i: usize| u16::from_le_bytes([data[i], data[i + 1]]) as usize;
    let u32_at = |i: usize| u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]) as usize;
    let eocd = (0..data.len() - 21).rev().find(|&i| u32_at(i) == 0x0605_4b50).expect("end of central directory");
    let count = u16_at(eocd + 10);
    let mut p = u32_at(eocd + 16);
    let mut files = HashMap::new();
    for _ in 0..count {
        assert_eq!(u32_at(p), 0x0201_4b50, "central directory entry");
        let method = u16_at(p + 10);
        let crc = u32_at(p + 16) as u32;
        let csize = u32_at(p + 20);
        let usize = u32_at(p + 24);
        let name_len = u16_at(p + 28);
        let extra = u16_at(p + 30);
        let comment = u16_at(p + 32);
        let local = u32_at(p + 42);
        let name = String::from_utf8(data[p + 46..p + 46 + name_len].to_vec()).unwrap();
        assert_eq!(u32_at(local), 0x0403_4b50, "local header of {name}");
        assert_eq!(u32_at(local + 14) as u32, crc, "local CRC of {name}");
        let start = local + 30 + u16_at(local + 26) + u16_at(local + 28);
        let raw = &data[start..start + csize];
        let bytes = if method == 8 {
            let mut v = Vec::new();
            flate2::read::DeflateDecoder::new(raw).read_to_end(&mut v).unwrap();
            v
        } else {
            raw.to_vec()
        };
        assert_eq!(bytes.len(), usize, "size of {name}");
        assert_eq!(crc32fast::hash(&bytes), crc, "CRC of {name}");
        files.insert(name, bytes);
        p += 46 + name_len + extra + comment;
    }
    files
}

fn assert_package_parts(files: &HashMap<String, Vec<u8>>) {
    for part in ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels", "word/styles.xml", "word/settings.xml"] {
        assert!(files.contains_key(part), "missing {part}");
    }
    let xml = document(files);
    assert!(xml.ends_with("</w:sectPr></w:body></w:document>"), "body must end with the last section");
    // Every opened paragraph and table is closed.
    assert_eq!(xml.matches("<w:p>").count() + xml.matches("<w:p/>").count(), xml.matches("</w:p>").count() + xml.matches("<w:p/>").count());
    assert_eq!(xml.matches("<w:tbl>").count(), xml.matches("</w:tbl>").count());
    // Word rejects these, and MuPDF's own DOCX writer produced them.
    assert!(!xml.contains("<w:t xml:space=\"preserve\"><w:br"), "no elements inside w:t");
    assert!(!xml.contains(".000000\""), "sizes must be integers");
}

#[test]
fn text_paragraphs_headings_lists_and_underline() {
    let (report, files, _dir) = convert("text.pdf");
    assert_package_parts(&files);
    assert_eq!(report.pages, 2);
    assert!(report.pages_without_text.is_empty());
    let xml = document(&files);
    let text = plain_text(&xml);
    // Wrapped lines are joined into one paragraph.
    assert!(text.contains("continues long enough to wrap over several lines, so the converter must join the lines back into one paragraph instead of breaking it"), "{text}");
    assert!(xml.contains(r#"<w:pStyle w:val="Heading1"/>"#));
    assert!(xml.contains(r#"<w:pStyle w:val="Heading2"/>"#));
    assert!(text.contains("•\tFirst bullet point"));
    assert!(xml.contains(r#"<w:u w:val="single"/>"#), "underline drawn as a line");
    assert!(xml.contains("<w:b/>") && xml.contains("<w:i/>"));
    // Two pages, two sections, the second starting on a new page.
    assert_eq!(xml.matches("<w:sectPr>").count(), 2);
    assert!(xml.contains(r#"<w:type w:val="nextPage"/>"#));
}

#[test]
fn two_columns_become_a_column_section() {
    let (_, files, _dir) = convert("columns.pdf");
    let xml = document(&files);
    assert!(xml.contains(r#"<w:cols w:num="2""#), "column section");
    assert!(xml.contains(r#"<w:br w:type="column"/>"#));
    let text = plain_text(&xml);
    // Reading order: all of the left column, then the right.
    let p5 = text.find("COLUMN-PARA-5").unwrap();
    let p6 = text.find("COLUMN-PARA-6").unwrap();
    assert!(p5 < p6);
    for i in 1..=8 {
        assert_eq!(text.matches(&format!("COLUMN-PARA-{i}.")).count(), 1);
    }
}

#[test]
fn ruled_table_becomes_word_table_and_borderless_uses_tabs() {
    let (report, files, _dir) = convert("table.pdf");
    assert_eq!(report.tables, 1);
    let xml = document(&files);
    assert_eq!(xml.matches("<w:tbl>").count(), 1);
    assert_eq!(xml.matches("<w:tr>").count(), 10);
    assert!(xml.contains(r#"<w:gridSpan w:val="3"/>"#), "merged 'Grand total' cell");
    let text = plain_text(&xml);
    for cell in ["Unit price", "Product 8", "96.00", "306.00", "Grand total"] {
        assert_eq!(text.matches(cell).count(), 1, "{cell}");
    }
    assert!(text.contains("Name\tRole\tCity"));
    assert!(text.contains("Budi\tDesigner\tSurabaya"));
}

#[test]
fn images_are_embedded_in_place_as_png_or_jpeg() {
    let (report, files, _dir) = convert("images.pdf");
    assert_eq!(report.images, 2);
    let media: Vec<_> = files.keys().filter(|k| k.starts_with("word/media/")).collect();
    assert_eq!(media.len(), 2);
    assert!(media.iter().all(|m| m.ends_with(".png") || m.ends_with(".jpeg")));
    let xml = document(&files);
    assert_eq!(xml.matches("<wp:inline").count(), 2);
    assert!(xml.contains("<wp:extent cx="), "images carry their size");
    // Captions after the pictures are kept, in order.
    let text = plain_text(&xml);
    let a = text.find("A photo-like image follows.").unwrap();
    let f1 = text.find("Figure 1: blue picture.").unwrap();
    let f2 = text.find("Figure 2: red picture.").unwrap();
    assert!(a < f1 && f1 < f2);
    // Picture between intro and caption.
    let first_pic = xml.find("<wp:inline").unwrap();
    assert!(xml.find("A photo-like").unwrap() < first_pic && first_pic < xml.find("Figure 1").unwrap());
}

#[test]
fn soft_masked_letterhead_is_not_black() {
    // The picture's colour data is black; only its soft mask shapes the logo.
    let (report, files, _dir) = convert("letterhead.pdf");
    assert_eq!(report.images, 1);
    let name = files.keys().find(|k| k.starts_with("word/media/")).unwrap();
    let decoder = png::Decoder::new(std::io::Cursor::new(&files[name]));
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgba, "transparency must survive");
    let px: Vec<&[u8]> = buf[..info.buffer_size()].chunks_exact(4).collect();
    let clear = px.iter().filter(|p| p[3] == 0).count();
    let blue = px.iter().filter(|p| p[3] == 255 && p[2] > 100 && p[0] < 60).count();
    assert!(clear * 3 > px.len(), "background stays transparent, not black");
    assert!(blue > 100, "the logo keeps its colour");
}

#[test]
fn mixed_page_keeps_everything() {
    let (report, files, _dir) = convert("mixed.pdf");
    assert_eq!((report.pages, report.tables, report.images), (2, 1, 1));
    let text = plain_text(&document(&files));
    for s in ["Mixed layout", "Results", "Revenue", "140", "Appendix", "ACME Corp · Internal", "Page 2"] {
        assert!(text.contains(s), "{s}");
    }
    // The page-2 footer sits near the bottom of the page: its space before must not be capped.
    let xml = document(&files);
    let before = xml.rfind("Page 2").map(|i| &xml[..i]).and_then(|h| h.rfind("w:before=\"")).map(|i| &xml[i + 10..]).unwrap();
    let before: u32 = before[..before.find('"').unwrap()].parse().unwrap();
    assert!(before > 12000, "footer spacing {before}");
}

#[test]
fn scanned_page_is_reported_and_kept_as_picture() {
    let (report, files, _dir) = convert("scanned.pdf");
    assert_eq!(report.pages_without_text, vec![1]);
    assert_eq!(files.keys().filter(|k| k.starts_with("word/media/")).count(), 1);
}

#[test]
fn word_export_keeps_lists_table_photo_and_title_rule() {
    let (report, files, _dir) = convert("word-export.pdf");
    assert_eq!(report.tables, 1);
    let xml = document(&files);
    let text = plain_text(&xml);
    assert!(text.contains("1.\tReduce manual work"));
    assert!(text.contains("A red, bold sentence follows the plain text."));
    assert!(xml.contains(r#"<w:color w:val="C02020"/>"#), "red text keeps its colour");
    assert!(xml.contains("<w:pBdr>"), "rule under the title");
    assert!(files.keys().any(|k| k.ends_with(".jpeg")), "photo stays JPEG");
}

#[test]
fn password_protected_pdf_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let err = convert_pdf_to_docx(&fixture("protected.pdf"), &dir.path().join("x.docx"), &JobContext::detached()).unwrap_err();
    assert!(matches!(err, CoreError::PasswordRequired), "{err}");
    assert_eq!(err.code(), "password_required");
}

#[test]
fn missing_input_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let err = convert_pdf_to_docx(&dir.path().join("nope.pdf"), &dir.path().join("x.docx"), &JobContext::detached()).unwrap_err();
    assert_eq!(err.code(), "not_found");
}

#[test]
fn cancelled_job_leaves_no_files() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("x.docx");
    let token = CancelToken::new();
    token.cancel();
    let ctx = JobContext::new(1, token, None);
    let err = convert_pdf_to_docx(&fixture("mixed.pdf"), &out, &ctx).unwrap_err();
    assert!(err.is_cancelled());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "no partial output");
}

#[test]
fn existing_output_is_replaced_only_when_done() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("x.docx");
    std::fs::write(&out, b"old").unwrap();
    convert_pdf_to_docx(&fixture("text.pdf"), &out, &JobContext::detached()).unwrap();
    assert!(std::fs::metadata(&out).unwrap().len() > 1000);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}
