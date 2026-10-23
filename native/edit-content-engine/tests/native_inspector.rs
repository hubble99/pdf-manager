//! The native inspector's strict gate: what it reads, and what it refuses.
//!
//! The inspector must be at least as strict as the pypdf-based reader it
//! replaced (strict mode), so anything damaged, unusual or too large is
//! unsupported, and a proof it cannot make exactly is missing rather than guessed.

use edit_content_engine::native_inspector::inspect_bytes;
use serde_json::Value;
use std::io::Write;

/// Writes a PDF from numbered objects (object 1 is the catalog).
fn build(objects: &[String]) -> Vec<u8> {
    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = bytes.len();
    bytes.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(
        format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes(),
    );
    bytes
}

fn stream(data: &str, extra: &str) -> String {
    format!("<< /Length {} {extra} >>\nstream\n{data}\nendstream", data.len())
}

const HELVETICA: &str = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

fn page(content: String) -> Vec<u8> {
    build(&[
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
            .into(),
        content,
        HELVETICA.into(),
    ])
}

fn good() -> Vec<u8> {
    page(stream("BT /F1 12 Tf 30 100 Td (hi) Tj ET", ""))
}

fn inspect(bytes: Vec<u8>) -> Option<Value> {
    inspect_bytes(bytes).ok()
}

#[test]
fn a_plain_document_is_inspected_completely() {
    let value = inspect(good()).expect("supported");
    assert_eq!(value["schemaVersion"], "edit-content-resource-inspection/v1");
    assert_eq!(value["supported"], true);
    let page = &value["pages"][0];
    assert_eq!(page["fonts"][0]["resourceName"], "/F1");
    assert_eq!(page["fonts"][0]["glyphCoverage"]["status"], "proven");
    // (`markedContentProof` needs tagged content, which this page has none of.)
    for proof in ["textPaintSlots", "backdropContext", "imageResourceBindings"] {
        assert!(!page[proof].is_null(), "{proof} should be proven");
    }
}

#[test]
fn damaged_files_are_unsupported() {
    let good = good();
    assert!(inspect(Vec::new()).is_none());
    assert!(inspect(b"%PDF-1.4\n".to_vec()).is_none());
    assert!(inspect(good[..good.len() / 2].to_vec()).is_none(), "truncated");
    let mut broken = good.clone();
    let at = String::from_utf8_lossy(&broken).find("startxref").unwrap();
    broken.splice(at..at + 9, *b"startxreg");
    assert!(inspect(broken).is_none(), "no startxref");
    // The start of the cross-reference table points at the wrong place.
    let text = String::from_utf8_lossy(&good).into_owned();
    let xref = text.find("\nxref").unwrap() + 1;
    let moved = text.replacen(&format!("startxref\n{xref}"), &format!("startxref\n{}", xref + 3), 1);
    assert!(inspect(moved.into_bytes()).is_none(), "startxref off by three");
}

#[test]
fn encryption_and_unreadable_filters_are_unsupported() {
    let mut encrypted = good();
    let at = String::from_utf8_lossy(&encrypted).find("/Root 1 0 R").unwrap();
    encrypted.splice(at..at, b"/Encrypt << /Filter /Standard >> ".iter().copied());
    assert!(inspect(encrypted).is_none());
    // A content stream in a filter the reader does not implement makes that
    // proof missing, never a guess.
    let lzw = page(stream("BT /F1 12 Tf 30 100 Td (hi) Tj ET", "/Filter /LZWDecode"));
    let value = inspect(lzw).expect("fonts do not depend on the content stream");
    assert!(value["pages"][0]["textPaintSlots"].is_null());
    assert!(value["pages"][0]["imageResourceBindings"].is_null());
}

#[test]
fn inline_images_and_stray_operands_leave_proofs_missing() {
    for content in [
        "BT /F1 12 Tf 30 100 Td (hi) Tj ET\nBI /W 1 /H 1 /BPC 8 /CS /G ID x EI",
        "BT /F1 12 Tf 30 100 Td (hi) Tj ET 12",
        "BT /F1 12 Tf 30 100 Td (hi) Tj ET 1 0 R",
    ] {
        let value = inspect(page(stream(content, ""))).expect("supported");
        assert!(value["pages"][0]["textPaintSlots"].is_null(), "{content}");
        assert!(value["pages"][0]["imageResourceBindings"].is_null(), "{content}");
        assert!(!value["pages"][0]["fonts"].as_array().unwrap().is_empty());
    }
}

#[test]
fn page_tree_problems_are_unsupported() {
    // A kid that points back at its parent.
    let looped = build(&[
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [2 0 R] /Count 1 >>".into(),
    ]);
    assert!(inspect(looped).is_none());
    let no_type = build(&[
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /MediaBox [0 0 1 1] >>".into(),
    ]);
    assert!(inspect(no_type).is_none());
    let missing_root = b"%PDF-1.4\ntrailer\n<< /Size 1 >>\nstartxref\n0\n%%EOF\n".to_vec();
    assert!(inspect(missing_root).is_none());
}

#[test]
fn a_decoded_stream_over_the_limit_is_refused_and_one_under_it_is_not() {
    fn flate(size: usize) -> Vec<u8> {
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        let block = vec![b' '; 1 << 20];
        let mut left = size;
        while left > 0 {
            let part = left.min(block.len());
            encoder.write_all(&block[..part]).unwrap();
            left -= part;
        }
        encoder.finish().unwrap()
    }
    /// A document whose content stream is exactly `compressed`.
    fn consistent(compressed: &[u8]) -> Vec<u8> {
        let mut objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_vec(),
        ];
        let mut content = format!("<< /Length {} /Filter /FlateDecode >>\nstream\n", compressed.len()).into_bytes();
        content.extend_from_slice(compressed);
        content.extend_from_slice(b"\nendstream");
        objects.push(content);
        objects.push(HELVETICA.as_bytes().to_vec());
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
        bytes
    }
    let small = inspect(consistent(&flate(1 << 20))).expect("supported");
    assert!(!small["pages"][0]["textPaintSlots"].is_null());
    let huge = inspect(consistent(&flate(76_000_000))).expect("supported without the content proofs");
    assert!(huge["pages"][0]["textPaintSlots"].is_null());
    assert!(huge["pages"][0]["imageResourceBindings"].is_null());
}
