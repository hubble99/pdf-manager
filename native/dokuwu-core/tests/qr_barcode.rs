//! QR codes and barcodes through the public API.
//!
//! `fixtures/qr-barcode/reference.json` holds what the Python sidecar's
//! libraries (python-barcode, qrcode) produced for the same inputs. Generated
//! PNGs are also read back with `rxing`, which is what proves they scan.

use dokuwu_core::ops::barcode::{self, BarcodeKind};
use dokuwu_core::ops::qr;
use dokuwu_core::CoreError;
use rxing::BarcodeFormat;
use serde_json::Value;

fn reference() -> Value {
    let text = include_str!("fixtures/qr-barcode/reference.json");
    serde_json::from_str(text).unwrap()
}

fn kind_of(name: &str) -> BarcodeKind {
    BarcodeKind::parse(name).unwrap()
}

fn decode_png(bytes: &[u8], format: BarcodeFormat) -> String {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .unwrap()
        .to_luma8();
    let (w, h) = img.dimensions();
    rxing::helpers::detect_in_luma(img.into_raw(), w, h, Some(format))
        .unwrap_or_else(|e| panic!("not readable: {e}"))
        .getText()
        .to_owned()
}

fn invalid_message(err: CoreError) -> String {
    match err {
        CoreError::InvalidInput(message) => message,
        other => panic!("expected invalid input, got {other:?}"),
    }
}

fn pattern(modules: &[bool]) -> String {
    modules.iter().map(|m| if *m { '1' } else { '0' }).collect()
}

/// Inputs for which the new Code 128 encoder picks a different, equally valid,
/// symbol sequence than python-barcode (see `code128_choice_is_never_longer`):
/// python-barcode switches to set C for four digits in a row even when that
/// costs a second switch, the new encoder only when it saves a symbol.
const CODE128_DIFFERS: &[&str] = &["ABC-1234-xyz"];

#[test]
fn barcode_patterns_match_python_barcode() {
    for case in reference()["barcodes"].as_array().unwrap() {
        let (kind, content) = (
            case["type"].as_str().unwrap(),
            case["content"].as_str().unwrap(),
        );
        let encoded = barcode::encode(kind_of(kind), content).unwrap();
        if kind == "code128" && CODE128_DIFFERS.contains(&content) {
            continue;
        }
        assert_eq!(
            pattern(&encoded.modules),
            case["modules"].as_str().unwrap(),
            "{kind} {content:?}: add it to CODE128_DIFFERS only if it still scans"
        );
        assert_eq!(
            encoded.text,
            case["text"].as_str().unwrap(),
            "{kind} {content:?}"
        );
    }
}

#[test]
fn code128_choice_is_never_longer_than_python_barcode() {
    for case in reference()["barcodes"].as_array().unwrap() {
        if case["type"] != "code128" {
            continue;
        }
        let content = case["content"].as_str().unwrap();
        let ours = barcode::encode(BarcodeKind::Code128, content)
            .unwrap()
            .modules
            .len();
        let theirs = case["modules"].as_str().unwrap().len();
        assert!(
            ours <= theirs,
            "{content:?}: {ours} modules against {theirs}"
        );
    }
}

#[test]
fn png_size_matches_the_python_output() {
    for case in reference()["barcodes"].as_array().unwrap() {
        let (kind, content) = (
            case["type"].as_str().unwrap(),
            case["content"].as_str().unwrap(),
        );
        if kind == "code128" && CODE128_DIFFERS.contains(&content) {
            continue;
        }
        let png = barcode::generate(content, kind, "png").unwrap();
        let img = image::load_from_memory(&png.bytes).unwrap();
        let size = case["png_size"].as_array().unwrap();
        assert_eq!(
            (img.width() as i64, img.height() as i64),
            (size[0].as_i64().unwrap(), size[1].as_i64().unwrap()),
            "{kind} {content:?}"
        );
    }
}

#[test]
fn every_barcode_png_decodes_to_its_text() {
    for case in reference()["barcodes"].as_array().unwrap() {
        let (kind, content) = (
            case["type"].as_str().unwrap(),
            case["content"].as_str().unwrap(),
        );
        let format = match kind {
            "code128" => BarcodeFormat::CODE_128,
            "ean13" => BarcodeFormat::EAN_13,
            "ean8" => BarcodeFormat::EAN_8,
            _ => BarcodeFormat::CODE_39,
        };
        let png = barcode::generate(content, kind, "png").unwrap();
        assert_eq!(png.mime, "image/png");
        // The text under the bars; for Code 39 that includes the check character.
        let expected = case["text"].as_str().unwrap();
        assert_eq!(
            decode_png(&png.bytes, format),
            expected,
            "{kind} {content:?}"
        );
    }
}

#[test]
fn code128_handles_mixed_content_and_control_characters() {
    for content in [
        "Dokuwu-2026",
        "a1b2c3d4e5",
        "12345678901",
        "0000",
        "x\ty",
        "Line1\nLine2",
        "~!@#$%^&*()_+{}|:\"<>?",
        "99a99",
        "1",
        "12",
        &"9".repeat(300),
        &"AbC1".repeat(60),
    ] {
        let png = barcode::generate(content, "code128", "png").unwrap();
        let decoded = decode_png(&png.bytes, BarcodeFormat::CODE_128);
        assert_eq!(decoded, content, "{content:?}");
    }
}

#[test]
fn ean13_with_twelve_digits_gets_its_check_digit() {
    let encoded = barcode::encode(BarcodeKind::Ean13, "590123412345").unwrap();
    assert_eq!(encoded.text, "5901234123457");
    let svg = String::from_utf8(
        barcode::generate("590123412345", "ean13", "svg")
            .unwrap()
            .bytes,
    )
    .unwrap();
    assert!(svg.contains(">5901234123457</text>"));
}

#[test]
fn ean_check_digit_must_be_right_when_given() {
    let err = barcode::generate("5901234123450", "ean13", "png").unwrap_err();
    assert_eq!(
        invalid_message(err),
        "The check digit of this EAN-13 is wrong, it should be 7."
    );
    let err = barcode::generate("96385070", "ean8", "png").unwrap_err();
    assert_eq!(
        invalid_message(err),
        "The check digit of this EAN-8 is wrong, it should be 4."
    );
    assert!(barcode::generate("5901234123457", "ean13", "png").is_ok());
    assert!(barcode::generate("96385074", "ean8", "svg").is_ok());
}

#[test]
fn validation_messages_match_the_python_version() {
    let msg = |content: &str, kind: &str, format: &str| {
        invalid_message(barcode::generate(content, kind, format).unwrap_err())
    };
    assert_eq!(msg("", "code128", "png"), "Content cannot be empty.");
    assert_eq!(msg("   ", "code128", "png"), "Content cannot be empty.");
    assert_eq!(
        msg("1234567890", "ean13", "png"),
        "EAN-13 requires exactly 12 or 13 numeric digits."
    );
    assert_eq!(
        msg("12345678901234", "ean13", "png"),
        "EAN-13 requires exactly 12 or 13 numeric digits."
    );
    assert_eq!(
        msg("59012341234a", "ean13", "png"),
        "EAN-13 requires exactly 12 or 13 numeric digits."
    );
    assert_eq!(
        msg("123456", "ean8", "png"),
        "EAN-8 requires exactly 7 or 8 numeric digits."
    );
    assert_eq!(msg("abc", "qr", "png"), "Unsupported barcode type: qr");
    assert_eq!(msg("abc", "code128", "gif"), "Unsupported format: gif");
    assert_eq!(
        msg("abc é", "code128", "png"),
        "The following characters are not valid for Code 128: é"
    );
    assert_eq!(
        msg("a@b", "code39", "png"),
        "The following characters are not valid for Code 39: @"
    );
    assert_eq!(
        msg(&"1".repeat(1001), "code128", "png"),
        "Content is too long for a barcode."
    );
}

#[test]
fn type_and_format_names_ignore_case_and_ean_ignores_surrounding_spaces() {
    let upper = barcode::generate(" 590123412345 ", "EAN13", "PNG").unwrap();
    let lower = barcode::generate("590123412345", "ean13", "png").unwrap();
    assert_eq!(upper.bytes, lower.bytes);
}

#[test]
fn barcode_svg_is_plain_valid_markup() {
    let svg = barcode::generate("A<&>B", "code128", "svg").unwrap();
    assert_eq!(svg.mime, "image/svg+xml");
    let text = String::from_utf8(svg.bytes).unwrap();
    assert!(text.starts_with("<?xml"));
    assert!(text.contains("xmlns=\"http://www.w3.org/2000/svg\""));
    assert!(!text.contains("svg:"));
    assert!(text.contains("<rect x="));
    assert!(text.contains(">A&lt;&amp;&gt;B</text>"));
    // The viewBox is in millimetres: 10 pt is 3.528 of them, not "10pt" (13 units).
    assert!(text.contains("font-size=\"3.528\""));
    assert!(text.trim_end().ends_with("</svg>"));
}

// ── QR ───────────────────────────────────────────────────────────────────────

/// Matrix of a PNG made with `size` px modules and the default border.
fn png_matrix(bytes: &[u8], size: usize) -> Vec<String> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .unwrap()
        .to_luma8();
    let side = img.width() as usize;
    assert_eq!(img.width(), img.height());
    assert_eq!(side % size, 0, "image is not a whole number of modules");
    let modules = side / size - 2 * qr::DEFAULT_BORDER as usize;
    (0..modules)
        .map(|row| {
            (0..modules)
                .map(|col| {
                    let x = (col + 4) * size;
                    let y = (row + 4) * size;
                    // Every pixel of a module has the same colour.
                    let first = img.get_pixel(x as u32, y as u32)[0];
                    for dy in 0..size {
                        for dx in 0..size {
                            assert_eq!(img.get_pixel((x + dx) as u32, (y + dy) as u32)[0], first);
                        }
                    }
                    if first < 128 {
                        '1'
                    } else {
                        '0'
                    }
                })
                .collect()
        })
        .collect()
}

fn decode_qr(bytes: &[u8]) -> String {
    decode_png(bytes, BarcodeFormat::QR_CODE)
}

/// The QR standard leaves the mask pattern to the encoder (it picks the one with
/// the lowest penalty); the two libraries score ties differently, so modules
/// can differ while the version, size and content are the same. What must match
/// is the size (same version) and that both read back as the same text.
#[test]
fn qr_versions_match_python_qrcode() {
    for case in reference()["qr"].as_array().unwrap() {
        let content = case["content"].as_str().unwrap();
        let level = case["level"].as_str().unwrap();
        let png = qr::generate(content, 5, level, "png", 4).unwrap();
        let ours = png_matrix(&png.bytes, 5);
        let expected = case["matrix"].as_array().unwrap();
        assert_eq!(
            ours.len(),
            expected.len(),
            "{content:?} level {level}: different version"
        );
        // The three finder patterns do not depend on the mask.
        for (row, expected_row) in ours.iter().zip(expected).take(7) {
            let expected_row = expected_row.as_str().unwrap();
            assert_eq!(row[..7], expected_row[..7]);
            assert_eq!(row[row.len() - 7..], expected_row[expected_row.len() - 7..]);
        }
        assert_eq!(decode_qr(&png.bytes), content);
    }
}

#[test]
fn qr_png_decodes_to_the_input_at_every_level_and_size() {
    for level in ["L", "M", "Q", "H", "q"] {
        for size in [1, 3, 10, 20] {
            let png = qr::generate("https://example.com", size, level, "png", 4).unwrap();
            assert_eq!(png.mime, "image/png");
            assert_eq!(
                decode_qr(&png.bytes),
                "https://example.com",
                "level {level} size {size}"
            );
        }
    }
}

#[test]
fn qr_png_modules_are_squares_of_the_box_size() {
    let png = qr::generate("https://example.com", 10, "M", "png", 4).unwrap();
    // Version 2 is 25 modules; with a 4 module border on each side: 33 modules.
    let img = image::load_from_memory(&png.bytes).unwrap();
    assert_eq!((img.width(), img.height()), (330, 330));
    let _ = png_matrix(&png.bytes, 10);
}

#[test]
fn qr_png_is_one_bit() {
    let png = qr::generate("hello", 4, "M", "png", 4).unwrap();
    let decoder = png::Decoder::new(std::io::Cursor::new(&png.bytes));
    let reader = decoder.read_info().unwrap();
    assert_eq!(reader.info().bit_depth, png::BitDepth::One);
}

#[test]
fn qr_keeps_non_ascii_text_as_utf8_bytes() {
    // UTF-8 bytes of these look like Shift JIS pairs; they must not become Kanji mode.
    for content in [
        "日本語のテキスト",
        "Ünïcödé — ✓ 😀",
        "café",
        "https://例え.jp/パス",
    ] {
        let png = qr::generate(content, 6, "M", "png", 4).unwrap();
        assert_eq!(decode_qr(&png.bytes), content);
    }
}

#[test]
fn qr_uses_the_smallest_version_and_reports_overflow() {
    let small = qr::generate("a", 1, "L", "png", 0).unwrap();
    assert_eq!(image::load_from_memory(&small.bytes).unwrap().width(), 21);
    let big = "x".repeat(2953);
    assert!(qr::generate(&big, 1, "L", "png", 4).is_ok());
    let err = qr::generate(&"x".repeat(2954), 1, "L", "png", 4).unwrap_err();
    assert_eq!(invalid_message(err), "Content is too long for a QR code.");
    let err = qr::generate(&"日".repeat(1000), 1, "L", "png", 4).unwrap_err();
    assert_eq!(invalid_message(err), "Content is too long for a QR code.");
}

#[test]
fn qr_validation_messages() {
    let msg = |content: &str, size, level: &str, format: &str, border| {
        invalid_message(qr::generate(content, size, level, format, border).unwrap_err())
    };
    assert_eq!(msg("", 10, "M", "png", 4), "Content cannot be empty.");
    assert_eq!(msg("  \n ", 10, "M", "png", 4), "Content cannot be empty.");
    assert_eq!(msg("a", 10, "M", "bmp", 4), "Unsupported format: bmp");
    assert_eq!(msg("a", 0, "M", "png", 4), "Size must be between 1 and 20.");
    assert_eq!(
        msg("a", 21, "M", "png", 4),
        "Size must be between 1 and 20."
    );
    assert_eq!(
        msg("a", 10, "X", "png", 4),
        "Unsupported error correction level: X"
    );
    assert_eq!(
        msg("a", 10, "M", "png", 51),
        "Border must be at most 50 modules."
    );
}

#[test]
fn qr_svg_is_plain_rects_that_rebuild_the_matrix() {
    let case = &reference()["qr"][0];
    let svg = qr::generate(case["content"].as_str().unwrap(), 10, "M", "svg", 4).unwrap();
    assert_eq!(svg.mime, "image/svg+xml");
    let text = String::from_utf8(svg.bytes).unwrap();
    assert!(text.contains("xmlns=\"http://www.w3.org/2000/svg\""));
    assert!(!text.contains("svg:"), "no namespace prefixes");
    assert!(text.contains("width=\"33mm\" height=\"33mm\" viewBox=\"0 0 33 33\""));

    let content = case["content"].as_str().unwrap();
    let expected = png_matrix(&qr::generate(content, 3, "M", "png", 4).unwrap().bytes, 3);
    let side = expected.len();
    let mut rebuilt = vec![vec!['0'; side]; side];
    let attr = |tag: &str, name: &str| -> usize {
        let key = format!("{name}=\"");
        let from = tag.find(&key).unwrap() + key.len();
        tag[from..].split('"').next().unwrap().parse().unwrap()
    };
    for tag in text.lines().filter(|l| l.starts_with("<rect x=")) {
        let (x, y, w) = (attr(tag, "x"), attr(tag, "y"), attr(tag, "width"));
        assert_eq!(attr(tag, "height"), 1);
        for col in x..x + w {
            rebuilt[y - 4][col - 4] = '1';
        }
    }
    let rebuilt: Vec<String> = rebuilt
        .into_iter()
        .map(|r| r.into_iter().collect())
        .collect();
    assert_eq!(rebuilt, expected, "SVG and PNG draw the same modules");
}

#[test]
fn qr_border_changes_the_image_size() {
    let none = qr::generate("hello", 2, "M", "png", 0).unwrap();
    let wide = qr::generate("hello", 2, "M", "png", 10).unwrap();
    let a = image::load_from_memory(&none.bytes).unwrap().width();
    let b = image::load_from_memory(&wide.bytes).unwrap().width();
    assert_eq!(b - a, 2 * 10 * 2);
}

#[test]
fn generation_is_fast_enough_to_run_on_every_keystroke() {
    let start = std::time::Instant::now();
    for _ in 0..20 {
        qr::generate("https://sbp.badanpangan.go.id", 10, "M", "png", 4).unwrap();
        barcode::generate("Dokuwu-2026", "code128", "png").unwrap();
    }
    // Debug build on a shared CI box; the release build is far quicker.
    assert!(start.elapsed().as_secs() < 10, "{:?}", start.elapsed());
}
