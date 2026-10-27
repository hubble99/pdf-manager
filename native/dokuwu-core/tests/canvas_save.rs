//! Stamping Canvas annotations onto a PDF (`ops::canvas_save`). The cases follow
//! the tests of the Python route this replaced (`test_edit_canvas*.py` in 1.10),
//! judged on what the saved page shows.

mod common;

use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::Engine;
use common::{decode, write_pdf, Decoded, PageSpec};
use dokuwu_core::job::JobContext;
use dokuwu_core::ops::canvas_save::{save_canvas_bytes, SaveOptions, SaveReport};
use dokuwu_core::ops::font_library::FontLibrary;
use dokuwu_core::ops::pdf_render::{QualityHint, RenderDocument};
use dokuwu_core::CoreResult;
use serde_json::{json, Value};

const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];
const WHITE: [u8; 3] = [255, 255, 255];

// ---------------------------------------------------------------- helpers

fn blank_pdf(dir: &tempfile::TempDir, width: f32, height: f32, rotate: i32) -> PathBuf {
    let mut page = PageSpec::new(width, height, "");
    page.rotate = rotate;
    write_pdf(dir, "input.pdf", &[page], None)
}

fn save_with(dir: &tempfile::TempDir, source: &Path, annotations: &Value, fonts: Option<&FontLibrary>) -> CoreResult<SaveReport> {
    std::fs::create_dir_all(dir.path().join("out")).unwrap();
    let options = SaveOptions { output_dir: dir.path().join("out"), output_name: Some("result".into()), fonts };
    save_canvas_bytes(source, annotations.to_string().as_bytes(), &options, &JobContext::detached())
}

fn save(dir: &tempfile::TempDir, source: &Path, annotations: &Value) -> CoreResult<SaveReport> {
    save_with(dir, source, annotations, None)
}

fn render(path: &Path, page: u32, dpi: u32) -> Decoded {
    let doc = RenderDocument::open(path).unwrap();
    decode(&doc.render(page, dpi, QualityHint::Auto).unwrap().png)
}

fn text_of(path: &Path, page: i32) -> String {
    let doc = mupdf::Document::open(path.to_str().unwrap()).unwrap();
    let page = doc.load_page(page).unwrap();
    let text = page.to_text_page(mupdf::TextPageFlags::empty()).unwrap().to_text().unwrap();
    text.replace('\u{a0}', " ")
}

fn near(color: [u8; 3], expected: [u8; 3]) -> bool {
    color.iter().zip(expected).all(|(c, e)| (*c as i32 - e as i32).abs() <= 40)
}

/// Pixel box (x0, y0, x1, y1) of everything darker than mid grey.
fn ink_box(img: &Decoded) -> Option<(u32, u32, u32, u32)> {
    let mut found: Option<(u32, u32, u32, u32)> = None;
    for y in 0..img.height {
        for x in 0..img.width {
            if img.pixel(x, y)[0] < 128 {
                found = Some(match found {
                    None => (x, y, x, y),
                    Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
                });
            }
        }
    }
    found
}

fn ink(img: &Decoded) -> usize {
    (0..img.height).flat_map(|y| (0..img.width).map(move |x| (x, y))).filter(|&(x, y)| img.pixel(x, y)[0] < 128).count()
}

fn count_images(path: &Path) -> usize {
    let bytes = std::fs::read(path).unwrap();
    let text = String::from_utf8_lossy(&bytes);
    text.matches("/Subtype/Image").count() + text.matches("/Subtype /Image").count()
}

// ---------------------------------------------------------------- images

fn quadrant_pixels(width: u32, height: u32) -> image::RgbImage {
    let mut img = image::RgbImage::from_pixel(width, height, image::Rgb(WHITE));
    for y in 0..height {
        for x in 0..width {
            if x < width / 2 && y < height / 2 {
                img.put_pixel(x, y, image::Rgb(RED));
            } else if x >= width / 2 && y >= height / 2 {
                img.put_pixel(x, y, image::Rgb(BLUE));
            }
        }
    }
    img
}

fn quadrant(format: image::ImageFormat) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    quadrant_pixels(200, 100).write_to(&mut out, format).unwrap();
    out.into_inner()
}

/// The JPEG with an Exif block that says "rotate 90 degrees clockwise to show" (orientation 6).
fn quadrant_jpeg_with_orientation_6() -> Vec<u8> {
    let jpeg = quadrant(image::ImageFormat::Jpeg);
    let mut exif = b"Exif\0\0".to_vec();
    exif.extend_from_slice(&[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]);
    exif.extend_from_slice(&[0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00]);
    exif.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
    let mut out = vec![0xff, 0xd8, 0xff, 0xe1];
    out.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&exif);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn data_url(raw: &[u8], mime: &str) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(raw))
}

fn corners(x: f64, y: f64, w: f64, h: f64, angle: f64) -> Value {
    let (sin, cos) = angle.to_radians().sin_cos();
    let points: Vec<Value> = [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]
        .iter()
        .map(|(px, py)| json!([x + px * cos - py * sin, y + px * sin + py * cos]))
        .collect();
    Value::Array(points)
}

fn image_object(x: f64, y: f64, w: f64, h: f64, angle: f64, opacity: f64, with_corners: bool) -> Value {
    let mut item = json!({
        "id": "obj1", "type": "image", "assetId": "img1",
        "x": x, "y": y, "width": w, "height": h, "angle": angle, "opacity": opacity,
    });
    if with_corners {
        item["vectorCorners"] = corners(x, y, w, h, angle);
    }
    item
}

fn image_page(objects: Vec<Value>, asset: &str, canvas: (f64, f64)) -> Value {
    json!({
        "image_b64": "", "canvas_width": canvas.0, "canvas_height": canvas.1,
        "native_objects": objects, "image_assets": { "img1": asset },
    })
}

fn png_url() -> String {
    data_url(&quadrant(image::ImageFormat::Png), "image/png")
}

/// Stamps `page` onto a blank page and renders it at 72 dpi.
fn stamped(page_json: Value, size: (f32, f32), rotate: i32) -> (tempfile::TempDir, PathBuf, Decoded) {
    let dir = tempfile::tempdir().unwrap();
    let source = blank_pdf(&dir, size.0, size.1, rotate);
    let report = save(&dir, &source, &json!([page_json])).unwrap();
    let img = render(&report.output_path, 1, 72);
    (dir, report.output_path, img)
}

#[test]
fn an_image_is_placed_at_its_position_and_size() {
    let (_dir, path, img) = stamped(image_page(vec![image_object(100.0, 50.0, 200.0, 100.0, 0.0, 1.0, true)], &png_url(), (400.0, 400.0)), (400.0, 400.0), 0);
    assert_eq!(count_images(&path), 1);
    assert!(near(img.pixel(150, 75), RED));
    assert!(near(img.pixel(250, 125), BLUE));
    assert!(near(img.pixel(250, 75), WHITE));
    assert!(near(img.pixel(90, 75), WHITE));
    assert!(near(img.pixel(310, 125), WHITE));
}

#[test]
fn an_image_scales_from_canvas_units_to_page_units() {
    // The canvas is twice the page, so every coordinate halves.
    let (_dir, _path, img) = stamped(image_page(vec![image_object(200.0, 100.0, 400.0, 200.0, 0.0, 1.0, true)], &png_url(), (800.0, 800.0)), (400.0, 400.0), 0);
    assert!(near(img.pixel(150, 75), RED));
    assert!(near(img.pixel(250, 125), BLUE));
}

#[test]
fn an_image_can_be_stretched() {
    let (_dir, _path, img) = stamped(image_page(vec![image_object(50.0, 50.0, 100.0, 300.0, 0.0, 1.0, true)], &png_url(), (400.0, 400.0)), (400.0, 400.0), 0);
    assert!(near(img.pixel(70, 100), RED));
    assert!(near(img.pixel(130, 300), BLUE));
    assert!(near(img.pixel(130, 100), WHITE));
}

#[test]
fn an_image_turns_clockwise_like_the_editor() {
    for with_corners in [true, false] {
        // A quarter turn clockwise around the top-left corner at (300, 100): the
        // red quadrant ends up right of x=250 and above y=200.
        let item = image_object(300.0, 100.0, 200.0, 100.0, 90.0, 1.0, with_corners);
        let (_dir, _path, img) = stamped(image_page(vec![item], &png_url(), (400.0, 400.0)), (400.0, 400.0), 0);
        assert!(near(img.pixel(275, 150), RED), "corners: {with_corners}");
        assert!(near(img.pixel(225, 250), BLUE), "corners: {with_corners}");
        assert!(near(img.pixel(225, 150), WHITE), "corners: {with_corners}");
    }
}

#[test]
fn an_image_supports_any_rotation_angle() {
    let item = image_object(150.0, 100.0, 200.0, 100.0, 30.0, 1.0, true);
    let c = corners(150.0, 100.0, 200.0, 100.0, 30.0);
    let at = |u: f64, v: f64| {
        let p = |i: usize, k: usize| c[i][k].as_f64().unwrap();
        let x = p(0, 0) + (p(1, 0) - p(0, 0)) * u + (p(3, 0) - p(0, 0)) * v;
        let y = p(0, 1) + (p(1, 1) - p(0, 1)) * u + (p(3, 1) - p(0, 1)) * v;
        (x.round() as u32, y.round() as u32)
    };
    let (_dir, _path, img) = stamped(image_page(vec![item], &png_url(), (400.0, 400.0)), (400.0, 400.0), 0);
    let (rx, ry) = at(0.25, 0.25);
    let (bx, by) = at(0.75, 0.75);
    assert!(near(img.pixel(rx, ry), RED));
    assert!(near(img.pixel(bx, by), BLUE));
}

#[test]
fn image_opacity_blends_with_the_page() {
    let (_dir, _path, img) = stamped(image_page(vec![image_object(100.0, 50.0, 200.0, 100.0, 0.0, 0.5, true)], &png_url(), (400.0, 400.0)), (400.0, 400.0), 0);
    let [r, g, b] = img.pixel(150, 75);
    assert!(r > 230);
    assert!((100..160).contains(&g), "green {g}");
    assert!((100..160).contains(&b), "blue {b}");
}

#[test]
fn an_image_on_a_rotated_page_keeps_the_editor_position() {
    // The editor shows rotated pages upright; the saved page must match that view.
    let item = image_object(100.0, 50.0, 200.0, 100.0, 0.0, 1.0, true);
    let (_dir, _path, img) = stamped(image_page(vec![item], &png_url(), (400.0, 300.0)), (300.0, 400.0), 90);
    assert_eq!((img.width, img.height), (400, 300));
    assert!(near(img.pixel(150, 75), RED));
    assert!(near(img.pixel(250, 125), BLUE));
}

#[test]
fn webp_and_jpeg_images_are_embedded() {
    let webp = data_url(&quadrant(image::ImageFormat::WebP), "image/webp");
    let (_dir, path, img) = stamped(image_page(vec![image_object(100.0, 50.0, 200.0, 100.0, 0.0, 1.0, true)], &webp, (400.0, 400.0)), (400.0, 400.0), 0);
    assert_eq!(count_images(&path), 1);
    assert!(near(img.pixel(150, 75), RED));

    // A plain JPEG goes into the PDF as it is.
    let jpeg = quadrant(image::ImageFormat::Jpeg);
    let (_dir, path, img) = stamped(image_page(vec![image_object(100.0, 50.0, 200.0, 100.0, 0.0, 1.0, true)], &data_url(&jpeg, "image/jpeg"), (400.0, 400.0)), (400.0, 400.0), 0);
    assert!(near(img.pixel(150, 75), RED));
    let output = std::fs::read(&path).unwrap();
    assert!(output.windows(jpeg.len()).any(|w| w == jpeg.as_slice()), "the JPEG bytes should be stored untouched");
}

#[test]
fn jpeg_exif_orientation_matches_the_browser_view() {
    // Orientation 6 means "turn 90 degrees clockwise to show". Browsers apply it,
    // so the editor shows a 100x200 image with the red quadrant at the top right.
    let raw = quadrant_jpeg_with_orientation_6();
    let (_dir, _path, img) = stamped(image_page(vec![image_object(100.0, 100.0, 100.0, 200.0, 0.0, 1.0, true)], &data_url(&raw, "image/jpeg"), (400.0, 400.0)), (400.0, 400.0), 0);
    assert!(near(img.pixel(175, 150), RED));
    assert!(near(img.pixel(125, 250), BLUE));
}

#[test]
fn the_same_image_used_twice_is_stored_once() {
    let first = image_object(20.0, 20.0, 100.0, 50.0, 0.0, 1.0, true);
    let mut second = image_object(200.0, 200.0, 150.0, 75.0, 0.0, 1.0, true);
    second["id"] = json!("obj2");
    let (_dir, path, _img) = stamped(image_page(vec![first, second], &png_url(), (400.0, 400.0)), (400.0, 400.0), 0);
    assert_eq!(count_images(&path), 1);
}

#[test]
fn missing_or_broken_image_data_names_the_page() {
    let dir = tempfile::tempdir().unwrap();
    let source = blank_pdf(&dir, 400.0, 400.0, 0);

    let broken = image_page(vec![image_object(10.0, 10.0, 50.0, 50.0, 0.0, 1.0, true)], "data:image/png;base64,bm90IGFuIGltYWdl", (400.0, 400.0));
    let err = save(&dir, &source, &json!([broken])).unwrap_err();
    assert!(err.to_string().contains("page index 0"), "{err}");

    let mut missing = image_object(10.0, 10.0, 50.0, 50.0, 0.0, 1.0, true);
    missing["assetId"] = json!("unknown");
    let err = save(&dir, &source, &json!([image_page(vec![missing], &png_url(), (400.0, 400.0))])).unwrap_err();
    assert!(err.to_string().contains("no image data"), "{err}");
    // A failed save leaves no half-written file behind.
    let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("out")).map(|d| d.flatten().collect()).unwrap_or_default();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

// ---------------------------------------------------------------- whole page, shapes, text

#[test]
fn a_page_given_as_a_raster_string_is_saved() {
    let dir = tempfile::tempdir().unwrap();
    let source = blank_pdf(&dir, 100.0, 200.0, 0);
    // 1x1 black pixel PNG.
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    std::fs::create_dir_all(dir.path().join("out")).unwrap();
    let options = SaveOptions { output_dir: dir.path().join("out"), output_name: Some("test_edited_pdf".into()), fonts: None };
    let report = save_canvas_bytes(&source, json!([png]).to_string().as_bytes(), &options, &JobContext::detached()).unwrap();
    assert_eq!(report.pages, 1);
    assert!(report.output_path.file_name().unwrap().to_string_lossy().starts_with("test_edited_pdf"));
    assert!(report.output_path.extension().is_some_and(|e| e == "pdf"));
    // The pixel has an alpha channel, so it is stored with a soft mask image.
    assert!(count_images(&report.output_path) >= 1);
}

#[test]
fn supported_objects_are_stamped_as_vectors_and_text() {
    let dir = tempfile::tempdir().unwrap();
    let source = write_pdf(&dir, "input.pdf", &[PageSpec::new(200.0, 200.0, "0 0 0 RG 1 w 10 176 m 190 176 l S")], None);
    let annotations = json!([{
        "image_b64": "", "canvas_width": 200, "canvas_height": 200,
        "native_objects": [
            { "type": "rect", "x": 20, "y": 20, "width": 60, "height": 30, "angle": 45, "strokeColor": "#102030", "strokeWidth": 2, "fillColor": "#d0e0f0", "fillOpacity": 50 },
            { "type": "circle", "x": 40, "y": 40, "width": 80, "height": 40, "angle": 30, "vectorCorners": [[0, 0]], "strokeColor": "#0000ff", "strokeWidth": 2, "fillColor": "#d0d0ff", "fillOpacity": 75 },
            { "type": "line", "points": [20, 100, 120, 100], "angle": 30, "strokeColor": "#ff0000", "strokeWidth": 3 },
            { "type": "pen", "x": 0, "y": 0, "vectorPath": [["M", 20, 130], ["Q", 50, 110, 80, 130], ["L", 110, 120]], "strokeColor": "#008000", "strokeWidth": 2, "opacity": 1 },
            { "type": "text", "x": 20, "y": 160, "width": 140, "text": "Native vector text", "lines": ["Native vector text"],
              "fontFamily": "Arial", "fontSize": 12, "lineHeight": 1.16, "color": "#000000", "bold": false, "italic": false, "opacity": 1 },
        ],
    }]);
    // The circle's corners are not needed; drop the placeholder so the angle is used.
    let mut annotations = annotations;
    annotations[0]["native_objects"][1].as_object_mut().unwrap().remove("vectorCorners");
    let report = save(&dir, &source, &annotations).unwrap();
    assert_eq!(report.stamped_pages, 1);
    assert!(text_of(&report.output_path, 0).contains("Native vector text"));
    assert_eq!(count_images(&report.output_path), 0);

    let img = render(&report.output_path, 1, 72);
    assert!(near(img.pixel(100, 100), [255, 0, 0]) || near(img.pixel(70, 105), [255, 0, 0]) || (0..200).any(|x| near(img.pixel(x, 100), [255, 0, 0])), "the red line");
    // Somewhere inside the ellipse its fill shows.
    assert_ne!(img.pixel(80, 60), WHITE);
}

fn track_page(spacing: i32) -> Value {
    json!({
        "image_b64": "", "canvas_width": 300, "canvas_height": 120,
        "native_objects": [{
            "type": "text", "x": 20, "y": 20, "width": 120, "text": "TRACK", "lines": ["TRACK"],
            "fontFamily": "Arial", "fontSize": 20, "letterSpacing": spacing, "lineHeight": 1.16,
            "color": "#000000", "bold": false, "italic": false, "opacity": 1,
        }],
    })
}

#[test]
fn letter_spacing_moves_letters_without_scaling_glyphs() {
    let dir = tempfile::tempdir().unwrap();
    let pages: Vec<PageSpec> = (0..3).map(|_| PageSpec::new(300.0, 120.0, "")).collect();
    let source = write_pdf(&dir, "input.pdf", &pages, None);
    let report = save(&dir, &source, &json!([track_page(-100), track_page(0), track_page(500)])).unwrap();

    let mut widths = Vec::new();
    let mut heights = Vec::new();
    for index in 0..3 {
        assert_eq!(text_of(&report.output_path, index).replace(['\n', ' '], ""), "TRACK");
        let img = render(&report.output_path, index as u32 + 1, 288);
        let (x0, y0, x1, y1) = ink_box(&img).expect("ink");
        widths.push((x1 - x0) as f64 / 4.0);
        heights.push((y1 - y0) as f64 / 4.0);
    }
    assert!(widths[0] < widths[1] && widths[1] < widths[2], "{widths:?}");
    assert!((widths[1] - widths[0] - 8.0).abs() < 1.0, "{widths:?}");
    assert!((widths[2] - widths[1] - 40.0).abs() < 1.0, "{widths:?}");
    assert!((heights[0] - heights[1]).abs() < heights[1] * 0.02, "{heights:?}");
    assert!((heights[2] - heights[1]).abs() < heights[1] * 0.02, "{heights:?}");
}

#[test]
fn malformed_annotation_files_are_refused_with_the_old_messages() {
    let dir = tempfile::tempdir().unwrap();
    let source = blank_pdf(&dir, 100.0, 200.0, 0);
    let options = SaveOptions { output_dir: dir.path().join("out"), output_name: None, fonts: None };
    let run = |bytes: &[u8]| save_canvas_bytes(&source, bytes, &options, &JobContext::detached()).unwrap_err();

    let err = run(b"[{");
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("Invalid annotations JSON at line"), "{err}");

    let err = run(b"{}");
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("Annotations JSON must be an array with one entry per PDF page."), "{err}");
}

#[test]
fn the_old_content_edit_payload_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let source = write_pdf(&dir, "input.pdf", &[PageSpec::new(200.0, 200.0, "")], None);
    let annotations = json!([{
        "canvas_width": 200, "canvas_height": 200,
        "native_objects": [{
            "id": "legacy-native-text", "type": "content_edit", "rect": [18, 28, 150, 46], "text": "Replacement",
            "lines": [{ "origin": [20, 40], "size": 12 }],
            "style": { "fontFamily": "Arial", "fontSize": 12, "bold": false, "italic": false, "color": "#000000" },
        }],
    }]);
    let err = save(&dir, &source, &annotations).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().to_lowercase().contains("selectable text editing is unavailable"), "{err}");
}

// ---------------------------------------------------------------- source transforms and weights

fn upright_text_item(letter_spacing: i32) -> Value {
    json!({
        "type": "text", "text": "CANVASTEST", "x": 40, "y": 40, "width": 180, "fontSize": 18,
        "letterSpacing": letter_spacing, "color": "#ff0000", "angle": 0,
    })
}

fn red_pixels(img: &Decoded) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    for y in 0..img.height {
        for x in 0..img.width {
            let [r, g, b] = img.pixel(x, y);
            if r > 150 && g < 100 && b < 100 {
                out.push((x, y));
            }
        }
    }
    out
}

#[test]
fn text_ignores_the_source_pages_transform_and_rotation() {
    // Source content: some ink, and optionally a vertical flip left active at
    // the end of the content stream, as some PDF producers do.
    for rotation in [0, 90, 180, 270] {
        for flip_y in [false, true] {
            for spacing in [0, 150] {
                let content: &'static str = Box::leak(
                    format!(
                        "{}0 0 0 RG 1 w 20 300 m 260 240 l S 0 0 0 rg 20 380 100 10 re f",
                        if flip_y { "1 0 0 -1 0 400 cm\n" } else { "" }
                    )
                    .into_boxed_str(),
                );
                let dir = tempfile::tempdir().unwrap();
                let mut spec = PageSpec::new(300.0, 400.0, content);
                spec.rotate = rotation;
                let source = write_pdf(&dir, "source.pdf", &[spec], None);
                let before = render(&source, 1, 72);

                let annotations = json!([{
                    "canvas_width": before.width, "canvas_height": before.height,
                    "native_objects": [upright_text_item(spacing)],
                }]);
                let report = save(&dir, &source, &annotations).unwrap();
                let after = render(&report.output_path, 1, 72);
                assert_eq!((after.width, after.height), (before.width, before.height));

                // The oracle: the same text on a plain upright page of the same size.
                let clean_dir = tempfile::tempdir().unwrap();
                let clean = write_pdf(&clean_dir, "clean.pdf", &[PageSpec::new(before.width as f32, before.height as f32, "")], None);
                let expected = render(&save(&clean_dir, &clean, &annotations).unwrap().output_path, 1, 72);
                let wanted = red_pixels(&expected);
                assert!(!wanted.is_empty());
                // A flipped source moves the glyph outlines by a fraction of a pixel,
                // which can turn a few edge pixels either way.
                let got = red_pixels(&after);
                let differing = got.iter().filter(|p| !wanted.contains(p)).count() + wanted.iter().filter(|p| !got.contains(p)).count();
                assert!(differing * 50 <= wanted.len(), "{differing} of {} pixels differ: rotation {rotation} flip {flip_y} spacing {spacing}", wanted.len());
                assert!(text_of(&report.output_path, 0).replace([' ', '\n'], "").contains("CANVASTEST"));
                assert_eq!(count_images(&report.output_path), 0);

                // Outside the text the page looks exactly as before.
                for y in 0..before.height {
                    for x in 0..before.width {
                        if (35..235).contains(&x) && (35..80).contains(&y) {
                            continue;
                        }
                        assert_eq!(after.pixel(x, y), before.pixel(x, y), "({x},{y}) rotation {rotation} flip {flip_y}");
                    }
                }
            }
        }
    }
}

fn weight_page(overrides: Value) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let source = write_pdf(&dir, "input.pdf", &[PageSpec::new(300.0, 120.0, "")], None);
    let mut item = json!({
        "type": "text", "x": 20, "y": 30, "text": "Weight Hamburg", "lines": ["Weight Hamburg"],
        "fontFamily": "Arial", "fontSize": 32, "fontWeight": 400, "width": 260,
    });
    for (key, value) in overrides.as_object().unwrap() {
        item[key] = value.clone();
    }
    let annotations = json!([{ "canvas_width": 300, "canvas_height": 120, "native_objects": [item] }]);
    let path = save(&dir, &source, &annotations).unwrap().output_path;
    (dir, path)
}

#[test]
fn synthetic_weights_get_progressively_heavier() {
    let mut inks = Vec::new();
    for (weight, em) in [(400, 0.0), (450, 0.01), (500, 0.02), (550, 0.03)] {
        let (_dir, path) = weight_page(json!({ "fontWeight": weight, "fontFaceWeight": 400, "syntheticStrokeEm": em }));
        inks.push(ink(&render(&path, 1, 96)));
    }
    assert!(inks.windows(2).all(|w| w[0] < w[1]), "{inks:?}");
}

#[test]
fn synthetic_weight_stays_real_selectable_text() {
    let (_dir, path) = weight_page(json!({ "fontWeight": 500, "fontFaceWeight": 400, "syntheticStrokeEm": 0.02 }));
    assert_eq!(text_of(&path, 0).trim(), "Weight Hamburg");
}

#[test]
fn synthetic_weight_follows_rotation_like_regular_text() {
    let turned = json!({ "angle": 90, "transformMatrix": [0, 1, -1, 0, 0, 0] });
    let (_a, plain) = weight_page(turned.clone());
    let mut thick_overrides = turned;
    thick_overrides["fontWeight"] = json!(500);
    thick_overrides["fontFaceWeight"] = json!(400);
    thick_overrides["syntheticStrokeEm"] = json!(0.02);
    let (_b, thick) = weight_page(thick_overrides);
    let (p, t) = (render(&plain, 1, 72), render(&thick, 1, 72));
    assert_eq!((p.width, p.height), (t.width, t.height));
    let (pb, tb) = (ink_box(&p).unwrap(), ink_box(&t).unwrap());
    for (a, b) in [(pb.0, tb.0), (pb.1, tb.1), (pb.2, tb.2), (pb.3, tb.3)] {
        assert!((a as i32 - b as i32).abs() <= 2, "{pb:?} vs {tb:?}");
    }
}

#[test]
fn missing_synthetic_fields_keep_the_old_behaviour() {
    let (_dir, path) = weight_page(json!({ "fontWeight": 400 }));
    assert_eq!(text_of(&path, 0).trim(), "Weight Hamburg");
}

#[test]
fn a_font_from_the_library_is_embedded_for_synthetic_weight() {
    let fonts = tempfile::tempdir().unwrap();
    let library = FontLibrary::new(fonts.path().join("fonts"));
    library.add(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fonts/RedHatMono-Regular.ttf")).unwrap();

    let dir = tempfile::tempdir().unwrap();
    let source = write_pdf(&dir, "input.pdf", &[PageSpec::new(300.0, 120.0, "")], None);
    let annotations = json!([{ "canvas_width": 300, "canvas_height": 120, "native_objects": [{
        "type": "text", "x": 20, "y": 30, "text": "Weight Hamburg", "lines": ["Weight Hamburg"],
        "fontFamily": "Red Hat Mono", "fontSize": 32, "fontWeight": 500, "fontFaceWeight": 400, "syntheticStrokeEm": 0.02, "width": 260,
    }] }]);
    let report = save_with(&dir, &source, &annotations, Some(&library)).unwrap();
    assert_eq!(text_of(&report.output_path, 0).trim(), "Weight Hamburg");
    let bytes = std::fs::read(&report.output_path).unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("RedHatMono"), "the font should be embedded");
}

#[test]
fn text_on_a_cropped_page_lines_up_with_the_visible_page() {
    let dir = tempfile::tempdir().unwrap();
    let mut spec = PageSpec::new(400.0, 300.0, "");
    spec.crop = Some([20.0, 20.0, 380.0, 270.0]);
    let cropped = write_pdf(&dir, "cropped.pdf", &[spec], None);
    let plain = write_pdf(&dir, "plain.pdf", &[PageSpec::new(360.0, 250.0, "")], None);
    let annotations = json!([{
        "canvas_width": 360, "canvas_height": 250,
        "native_objects": [{
            "type": "text", "x": 20, "y": 20, "width": 200, "text": "Hello", "lines": ["Hello"],
            "fontFamily": "Arial", "fontSize": 16, "color": "#000000",
        }, { "type": "rect", "x": 100, "y": 100, "width": 40, "height": 20, "strokeColor": "#000000", "strokeWidth": 2, "fillColor": "#ffff00", "fillOpacity": 100 }],
    }]);
    let a = render(&save(&dir, &cropped, &annotations).unwrap().output_path, 1, 72);
    let other = tempfile::tempdir().unwrap();
    let b = render(&save(&other, &plain, &annotations).unwrap().output_path, 1, 72);
    assert_eq!((a.width, a.height), (b.width, b.height));
    assert_eq!(ink_box(&a), ink_box(&b));
    assert_eq!(a.pixel(120, 110), b.pixel(120, 110));
}
