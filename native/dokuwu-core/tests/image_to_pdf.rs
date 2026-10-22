//! Images to PDF (`ops::image_to_pdf`). Test pictures have four coloured
//! quadrants so a wrong rotation, mirror or EXIF orientation shows up in the
//! rendered page.

mod common;

use std::path::{Path, PathBuf};

use common::decode;
use dokuwu_core::job::{CancelToken, JobContext};
use dokuwu_core::ops::image_to_pdf::{images_to_pdf, ImageInput, ImageToPdfOptions};
use dokuwu_core::ops::pdf_render::{pdf_info, QualityHint, RenderDocument};
use image::{ImageEncoder, Rgb, RgbImage};

const RED: [u8; 3] = [255, 0, 0];
const GREEN: [u8; 3] = [0, 200, 0];
const BLUE: [u8; 3] = [0, 0, 255];
const YELLOW: [u8; 3] = [255, 255, 0];

/// Grid of quadrant colours, rows top to bottom.
type Grid = [[[u8; 3]; 2]; 2];
const BASE: Grid = [[RED, GREEN], [BLUE, YELLOW]];

fn quadrants(w: u32, h: u32) -> RgbImage {
    RgbImage::from_fn(w, h, |x, y| {
        Rgb(BASE[(y >= h / 2) as usize][(x >= w / 2) as usize])
    })
}

fn flip_h(g: Grid) -> Grid {
    [[g[0][1], g[0][0]], [g[1][1], g[1][0]]]
}
fn flip_v(g: Grid) -> Grid {
    [g[1], g[0]]
}
fn turn_cw(g: Grid) -> Grid {
    [[g[1][0], g[0][0]], [g[1][1], g[0][1]]]
}
fn turns(g: Grid, quarter_turns: u16) -> Grid {
    (0..quarter_turns / 90).fold(g, |g, _| turn_cw(g))
}

#[derive(Clone, Copy, Debug)]
enum Kind {
    PngRgb,
    Bmp,
    Tiff,
    WebpLossless,
    Jpeg,
}

fn write_image(dir: &Path, name: &str, img: &RgbImage, kind: Kind) -> PathBuf {
    let path = dir.join(name);
    match kind {
        Kind::PngRgb => img.save_with_format(&path, image::ImageFormat::Png).unwrap(),
        Kind::Bmp => img.save_with_format(&path, image::ImageFormat::Bmp).unwrap(),
        Kind::Tiff => img.save_with_format(&path, image::ImageFormat::Tiff).unwrap(),
        Kind::WebpLossless => {
            let file = std::fs::File::create(&path).unwrap();
            image::codecs::webp::WebPEncoder::new_lossless(file)
                .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgb8)
                .unwrap();
        }
        Kind::Jpeg => {
            let file = std::fs::File::create(&path).unwrap();
            image::codecs::jpeg::JpegEncoder::new_with_quality(file, 98)
                .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgb8)
                .unwrap();
        }
    }
    path
}

/// Inserts an EXIF APP1 segment with the orientation tag after the JPEG's SOI.
fn with_exif_orientation(jpeg: &[u8], orientation: u8) -> Vec<u8> {
    let mut seg = Vec::new();
    seg.extend_from_slice(b"Exif\0\0");
    seg.extend_from_slice(b"II*\0\x08\0\0\0");
    seg.extend_from_slice(&1u16.to_le_bytes());
    seg.extend_from_slice(&0x0112u16.to_le_bytes());
    seg.extend_from_slice(&3u16.to_le_bytes());
    seg.extend_from_slice(&1u32.to_le_bytes());
    seg.extend_from_slice(&[orientation, 0, 0, 0]);
    seg.extend_from_slice(&0u32.to_le_bytes());
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend_from_slice(&(seg.len() as u16 + 2).to_be_bytes());
    out.extend_from_slice(&seg);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn input(path: &Path, rotation: u16, flip_h: bool) -> ImageInput {
    ImageInput { path: path.to_path_buf(), rotation, flip_h }
}

fn options(dir: &Path, page_size: &str) -> ImageToPdfOptions {
    ImageToPdfOptions { page_size: page_size.into(), output_dir: dir.to_path_buf(), output_name: None }
}

fn render(pdf: &Path, page: u32) -> common::Decoded {
    let doc = RenderDocument::open(pdf).unwrap();
    let r = doc.render(page, 72, QualityHint::High).unwrap();
    decode(&r.png)
}

fn near(a: [u8; 3], b: [u8; 3]) -> bool {
    a.iter().zip(b).all(|(&x, y)| (x as i32 - y as i32).abs() < 60)
}

/// Asserts the rendered page shows `expected` in its four quadrants.
fn assert_quadrants(img: &common::Decoded, expected: Grid, context: &str) {
    let (w, h) = (img.width, img.height);
    for (row, y) in [(0usize, h / 4), (1, 3 * h / 4)] {
        for (col, x) in [(0usize, w / 4), (1, 3 * w / 4)] {
            let got = img.pixel(x, y);
            assert!(near(got, expected[row][col]), "{context}: quadrant ({row},{col}) is {got:?}, wanted {:?}", expected[row][col]);
        }
    }
}

#[test]
fn rotation_and_mirror_match_what_the_workspace_shows() {
    let src = tempfile::tempdir().unwrap();
    let img = quadrants(40, 30);
    for kind in [Kind::PngRgb, Kind::Bmp, Kind::Tiff, Kind::WebpLossless, Kind::Jpeg] {
        let path = write_image(src.path(), "q.img", &img, kind);
        for (rotation, mirror) in [(0u16, false), (90, false), (180, false), (270, false), (0, true), (90, true), (270, true)] {
            let out = tempfile::tempdir().unwrap();
            let report = images_to_pdf(&[input(&path, rotation, mirror)], &options(out.path(), "match_image"), &JobContext::detached()).unwrap();
            assert_eq!(report.pages, 1);
            let page = render(&report.output_path, 1);
            // Mirror first, then the clockwise turns, like the workspace grid.
            let base = if mirror { flip_h(BASE) } else { BASE };
            let expected = turns(base, rotation);
            let (w, h) = if rotation % 180 == 0 { (40, 30) } else { (30, 40) };
            assert_eq!((page.width, page.height), (w, h), "{kind:?} {rotation} {mirror}");
            assert_quadrants(&page, expected, &format!("{kind:?} rotation {rotation} mirror {mirror}"));
        }
    }
}

#[test]
fn exif_orientation_is_applied_like_a_photo_viewer() {
    let src = tempfile::tempdir().unwrap();
    let plain = quadrants(40, 30);
    let jpeg = std::fs::read(write_image(src.path(), "plain.jpg", &plain, Kind::Jpeg)).unwrap();
    let cases: [(u8, Grid); 8] = [
        (1, BASE),
        (2, flip_h(BASE)),
        (3, turns(BASE, 180)),
        (4, flip_v(BASE)),
        (5, flip_h(turns(BASE, 90))),
        (6, turns(BASE, 90)),
        (7, flip_h(turns(BASE, 270))),
        (8, turns(BASE, 270)),
    ];
    for (orientation, expected) in cases {
        let path = src.path().join(format!("o{orientation}.jpg"));
        std::fs::write(&path, with_exif_orientation(&jpeg, orientation)).unwrap();
        let out = tempfile::tempdir().unwrap();
        let report = images_to_pdf(&[input(&path, 0, false)], &options(out.path(), "match_image"), &JobContext::detached()).unwrap();
        let page = render(&report.output_path, 1);
        let swapped = orientation >= 5;
        assert_eq!((page.width, page.height), if swapped { (30, 40) } else { (40, 30) }, "exif {orientation}");
        assert_quadrants(&page, expected, &format!("exif {orientation}"));
    }
}

#[test]
fn exif_and_user_rotation_add_up() {
    let src = tempfile::tempdir().unwrap();
    let jpeg = std::fs::read(write_image(src.path(), "plain.jpg", &quadrants(40, 30), Kind::Jpeg)).unwrap();
    let path = src.path().join("o6.jpg");
    std::fs::write(&path, with_exif_orientation(&jpeg, 6)).unwrap();
    let out = tempfile::tempdir().unwrap();
    let report = images_to_pdf(&[input(&path, 90, true)], &options(out.path(), "match_image"), &JobContext::detached()).unwrap();
    // EXIF 6 turns it once, the mirror flips that result, the user turn adds one more.
    let expected = turns(flip_h(turns(BASE, 90)), 90);
    assert_quadrants(&render(&report.output_path, 1), expected, "exif 6 + mirror + 90");
}

#[test]
fn a_jpeg_is_stored_untouched_and_a_png_keeps_its_compressed_rows() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let jpeg_path = write_image(src.path(), "a.jpg", &quadrants(64, 48), Kind::Jpeg);
    let png_path = write_image(src.path(), "b.png", &quadrants(64, 48), Kind::PngRgb);
    let report = images_to_pdf(
        &[input(&jpeg_path, 0, false), input(&png_path, 0, false)],
        &options(out.path(), "a4"),
        &JobContext::detached(),
    )
    .unwrap();
    let pdf = std::fs::read(&report.output_path).unwrap();
    let jpeg = std::fs::read(&jpeg_path).unwrap();
    assert!(pdf.windows(jpeg.len()).any(|w| w == jpeg.as_slice()), "the JPEG is embedded byte for byte");
    assert!(pdf.windows(11).any(|w| w == b"/DCTDecode "));
    assert!(pdf.windows(14).any(|w| w == b"/Predictor 15 "));
    assert_eq!(report.pages, 2);
}

#[test]
fn fixed_sheets_fit_the_picture_and_follow_its_orientation() {
    let src = tempfile::tempdir().unwrap();
    let portrait = write_image(src.path(), "p.png", &quadrants(30, 40), Kind::PngRgb);
    let landscape = write_image(src.path(), "l.png", &quadrants(40, 30), Kind::PngRgb);
    let square = write_image(src.path(), "s.png", &quadrants(30, 30), Kind::PngRgb);
    let out = tempfile::tempdir().unwrap();
    let report = images_to_pdf(
        &[input(&portrait, 0, false), input(&landscape, 0, false), input(&square, 0, false), input(&portrait, 90, false)],
        &options(out.path(), "A4"),
        &JobContext::detached(),
    )
    .unwrap();
    assert_eq!(report.page_size, "a4");
    let doc = RenderDocument::open(&report.output_path).unwrap();
    let sizes: Vec<(f64, f64)> = (1..=4).map(|p| doc.page_size_pt(p).unwrap()).collect();
    assert_eq!(sizes, vec![(595.0, 842.0), (842.0, 595.0), (595.0, 842.0), (842.0, 595.0)]);
    // The portrait picture is centred and keeps its 3:4 shape: 631.5 pt wide at full height.
    let page = render(&report.output_path, 1);
    assert!(near(page.pixel(2, 2), [255, 255, 255]), "margin is white");
    let (cx, cy) = (page.width / 2, page.height / 2);
    assert!(page.pixel(cx - 100, cy - 100).iter().any(|&c| c > 100), "picture area is coloured");
}

#[test]
fn transparency_is_flattened_on_white_and_other_png_shapes_decode() {
    let src = tempfile::tempdir().unwrap();
    // RGBA: the left half is fully transparent red, the right half opaque blue.
    let rgba = image::RgbaImage::from_fn(40, 30, |x, _| if x < 20 { image::Rgba([255, 0, 0, 0]) } else { image::Rgba([0, 0, 255, 255]) });
    let rgba_path = src.path().join("rgba.png");
    rgba.save(&rgba_path).unwrap();
    // 16-bit RGB.
    let deep = image::ImageBuffer::<Rgb<u16>, Vec<u16>>::from_fn(40, 30, |_, _| Rgb([0u16, 65535, 0]));
    let deep_path = src.path().join("deep.png");
    deep.save(&deep_path).unwrap();
    // Grey, 8-bit.
    let grey = image::GrayImage::from_fn(40, 30, |_, _| image::Luma([128u8]));
    let grey_path = src.path().join("grey.png");
    grey.save(&grey_path).unwrap();
    // Palette.
    let pal_path = src.path().join("pal.png");
    {
        let file = std::fs::File::create(&pal_path).unwrap();
        let mut enc = png::Encoder::new(file, 40, 30);
        enc.set_color(png::ColorType::Indexed);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_palette(vec![255, 0, 0, 0, 255, 0]);
        let mut w = enc.write_header().unwrap();
        let data: Vec<u8> = (0..30).flat_map(|_| (0..40).map(|x| (x >= 20) as u8)).collect();
        w.write_image_data(&data).unwrap();
    }
    let out = tempfile::tempdir().unwrap();
    let report = images_to_pdf(
        &[input(&rgba_path, 0, false), input(&deep_path, 0, false), input(&grey_path, 0, false), input(&pal_path, 0, false)],
        &options(out.path(), "match_image"),
        &JobContext::detached(),
    )
    .unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(report.pages, 4);
    let p1 = render(&report.output_path, 1);
    assert!(near(p1.pixel(5, 15), [255, 255, 255]), "transparent area is white");
    assert!(near(p1.pixel(35, 15), [0, 0, 255]));
    assert!(near(render(&report.output_path, 2).pixel(20, 15), [0, 255, 0]));
    assert!(near(render(&report.output_path, 3).pixel(20, 15), [128, 128, 128]));
    let p4 = render(&report.output_path, 4);
    assert!(near(p4.pixel(5, 15), [255, 0, 0]) && near(p4.pixel(35, 15), [0, 255, 0]));
}

#[test]
fn an_unreadable_image_is_skipped_and_reported() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let good = write_image(src.path(), "good.png", &quadrants(20, 20), Kind::PngRgb);
    let bad = src.path().join("bad.jpg");
    std::fs::write(&bad, b"this is not a picture").unwrap();
    let missing = src.path().join("gone.png");
    let report = images_to_pdf(
        &[input(&good, 0, false), input(&bad, 0, false), input(&missing, 0, false), input(&good, 0, false)],
        &options(out.path(), "a4"),
        &JobContext::detached(),
    )
    .unwrap();
    assert_eq!(report.pages, 2);
    assert_eq!(report.skipped.len(), 2);
    assert_eq!(report.skipped[0].source, bad);
    assert_eq!(report.skipped[1].error.code, "not_found");
    assert_eq!(pdf_info(&report.output_path).unwrap().pages, 2);

    let err = images_to_pdf(&[input(&bad, 0, false)], &options(out.path(), "a4"), &JobContext::detached()).unwrap_err();
    assert_eq!(err.code(), "invalid_input");
    assert!(err.to_string().contains("none of the provided images"));
}

#[test]
fn input_checks_and_names() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let img = write_image(src.path(), "i.png", &quadrants(20, 20), Kind::PngRgb);
    let job = JobContext::detached();
    let code = |r: Result<_, dokuwu_core::CoreError>| match r {
        Ok(_) => "ok",
        Err(e) => e.code(),
    };
    assert_eq!(code(images_to_pdf(&[], &options(out.path(), "a4"), &job)), "invalid_input");
    assert_eq!(code(images_to_pdf(&[input(&img, 0, false)], &options(out.path(), "tabloid"), &job)), "invalid_input");
    assert_eq!(code(images_to_pdf(&[input(&img, 45, false)], &options(out.path(), "a4"), &job)), "invalid_input");
    assert_eq!(code(images_to_pdf(&[input(&img, 0, false)], &options(&out.path().join("nope"), "a4"), &job)), "not_found");

    let first = images_to_pdf(&[input(&img, 0, false)], &options(out.path(), "a4"), &job).unwrap();
    let second = images_to_pdf(&[input(&img, 0, false)], &options(out.path(), "a4"), &job).unwrap();
    assert_eq!(first.output_path, out.path().join("output.pdf"));
    assert_eq!(second.output_path, out.path().join("output (1).pdf"));
    let mut named = options(out.path(), "a4");
    named.output_name = Some("Scan: 2025.pdf".into());
    assert_eq!(images_to_pdf(&[input(&img, 0, false)], &named, &job).unwrap().output_path, out.path().join("Scan_ 2025.pdf"));
    let leftovers: Vec<_> = std::fs::read_dir(out.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(leftovers.len(), 3, "{leftovers:?}");
}

#[test]
fn many_images_keep_their_order_and_cancelling_removes_the_partial_file() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let inputs: Vec<ImageInput> = (0..30u32)
        .map(|i| input(&write_image(src.path(), &format!("{i}.png"), &quadrants(10 + i, 10), Kind::PngRgb), 0, false))
        .collect();
    let report = images_to_pdf(&inputs, &options(out.path(), "match_image"), &JobContext::detached()).unwrap();
    assert_eq!(report.pages, 30);
    let doc = RenderDocument::open(&report.output_path).unwrap();
    for i in 0..30u32 {
        assert_eq!(doc.page_size_pt(i + 1).unwrap(), ((10 + i) as f64, 10.0), "page {}", i + 1);
    }

    let cancel_out = tempfile::tempdir().unwrap();
    let token = CancelToken::new();
    let cancel = token.clone();
    let sink: dokuwu_core::ProgressSink = std::sync::Arc::new(move |_, p| {
        if p.done >= 3 {
            cancel.cancel();
        }
    });
    let err = images_to_pdf(&inputs, &options(cancel_out.path(), "a4"), &JobContext::new(1, token, Some(sink)).with_min_interval(std::time::Duration::ZERO)).unwrap_err();
    assert!(err.is_cancelled());
    assert_eq!(std::fs::read_dir(cancel_out.path()).unwrap().count(), 0);
}
