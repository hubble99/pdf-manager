//! WEBP conversion through the public API, with real files on disk.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dokuwu_core::job::{CancelToken, JobContext, Progress, ProgressSink};
use dokuwu_core::ops::image_convert::{
    convert_webp_images, convert_webp_images_with, is_webp, ConvertOptions, TargetFormat, STAGE,
};
use dokuwu_core::resources::{MemoryProbe, MIB};
use image::codecs::webp::WebPEncoder;
use image::{ImageEncoder, ImageFormat, Rgba, RgbaImage};

/// 4x2 image: left half opaque red, right half fully transparent.
fn write_webp(dir: &Path, name: &str) -> PathBuf {
    let mut img = RgbaImage::new(4, 2);
    for (x, _, px) in img.enumerate_pixels_mut() {
        *px = if x < 2 {
            Rgba([255, 0, 0, 255])
        } else {
            Rgba([0, 0, 255, 0])
        };
    }
    let path = dir.join(name);
    let file = std::fs::File::create(&path).unwrap();
    WebPEncoder::new_lossless(file)
        .write_image(img.as_raw(), 4, 2, image::ExtendedColorType::Rgba8)
        .unwrap();
    path
}

fn options(dir: &Path, format: TargetFormat) -> ConvertOptions {
    ConvertOptions {
        format,
        quality: 90,
        output_dir: dir.to_path_buf(),
    }
}

#[test]
fn converts_to_png_and_keeps_transparency() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let input = write_webp(src.path(), "photo.webp");

    let report = convert_webp_images(
        std::slice::from_ref(&input),
        &options(out.path(), TargetFormat::Png),
        &JobContext::detached(),
    )
    .unwrap();

    assert_eq!((report.succeeded, report.failed), (1, 0));
    let file = &report.files[0];
    assert_eq!(file.source, input);
    let output = file.output.clone().unwrap();
    assert_eq!(output, out.path().join("photo.png"));
    assert_eq!((file.width, file.height), (Some(4), Some(2)));
    assert_eq!(
        file.output_bytes,
        Some(std::fs::metadata(&output).unwrap().len())
    );
    assert!(!file.animated);

    assert_eq!(
        image::ImageReader::open(&output)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .format(),
        Some(ImageFormat::Png)
    );
    let decoded = image::open(&output).unwrap().to_rgba8();
    assert_eq!(decoded.get_pixel(0, 0), &Rgba([255, 0, 0, 255]));
    assert_eq!(decoded.get_pixel(3, 1)[3], 0);
}

#[test]
fn jpg_and_jpeg_flatten_transparency_onto_white() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let input = write_webp(src.path(), "logo.webp");

    for (format, ext) in [(TargetFormat::Jpg, "jpg"), (TargetFormat::Jpeg, "jpeg")] {
        let report = convert_webp_images(
            std::slice::from_ref(&input),
            &options(out.path(), format),
            &JobContext::detached(),
        )
        .unwrap();
        let output = report.files[0].output.clone().unwrap();
        assert_eq!(output, out.path().join(format!("logo.{ext}")));
        let reader = image::ImageReader::open(&output)
            .unwrap()
            .with_guessed_format()
            .unwrap();
        assert_eq!(reader.format(), Some(ImageFormat::Jpeg));
        let decoded = reader.decode().unwrap().to_rgb8();
        let transparent = decoded.get_pixel(3, 1);
        assert!(
            transparent.0.iter().all(|&c| c > 240),
            "expected white, got {transparent:?}"
        );
        let opaque = decoded.get_pixel(0, 0);
        assert!(
            opaque[0] > 200 && opaque[1] < 60 && opaque[2] < 60,
            "expected red, got {opaque:?}"
        );
    }
}

/// Builds a two-frame animated WEBP (red frame, then blue) from lossless stills.
fn write_animated_webp(dir: &Path, name: &str) -> PathBuf {
    fn vp8l_chunk(color: Rgba<u8>) -> Vec<u8> {
        let img = RgbaImage::from_pixel(4, 2, color);
        let mut still = Vec::new();
        WebPEncoder::new_lossless(&mut still)
            .write_image(img.as_raw(), 4, 2, image::ExtendedColorType::Rgba8)
            .unwrap();
        // RIFF header is 12 bytes; the rest is the VP8L chunk (already padded).
        still[12..].to_vec()
    }
    fn u24(v: u32) -> [u8; 3] {
        [v as u8, (v >> 8) as u8, (v >> 16) as u8]
    }
    fn chunk(tag: &[u8], body: &[u8]) -> Vec<u8> {
        let mut c = tag.to_vec();
        c.extend_from_slice(&(body.len() as u32).to_le_bytes());
        c.extend_from_slice(body);
        if body.len() % 2 == 1 {
            c.push(0);
        }
        c
    }
    let mut vp8x = vec![0x02 | 0x10, 0, 0, 0];
    vp8x.extend_from_slice(&u24(3));
    vp8x.extend_from_slice(&u24(1));
    let mut anim = 0u32.to_le_bytes().to_vec();
    anim.extend_from_slice(&0u16.to_le_bytes());
    let mut body = b"WEBP".to_vec();
    body.extend(chunk(b"VP8X", &vp8x));
    body.extend(chunk(b"ANIM", &anim));
    for color in [Rgba([255, 0, 0, 255]), Rgba([0, 0, 255, 255])] {
        let mut frame = Vec::new();
        frame.extend_from_slice(&u24(0));
        frame.extend_from_slice(&u24(0));
        frame.extend_from_slice(&u24(3));
        frame.extend_from_slice(&u24(1));
        frame.extend_from_slice(&u24(100));
        frame.push(0);
        frame.extend(vp8l_chunk(color));
        body.extend(chunk(b"ANMF", &frame));
    }
    let path = dir.join(name);
    std::fs::write(&path, chunk(b"RIFF", &body)).unwrap();
    path
}

#[test]
fn animated_webp_keeps_the_first_frame() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let input = write_animated_webp(src.path(), "sticker.webp");

    let report = convert_webp_images(
        &[input],
        &options(out.path(), TargetFormat::Png),
        &JobContext::detached(),
    )
    .unwrap();

    let file = &report.files[0];
    assert!(file.error.is_none(), "{:?}", file.error);
    assert!(file.animated);
    let decoded = image::open(file.output.as_ref().unwrap())
        .unwrap()
        .to_rgba8();
    assert_eq!(decoded.dimensions(), (4, 2));
    // Frame compositing may round by one step; the first frame is red, not blue.
    let px = decoded.get_pixel(1, 1);
    assert!(
        px[0] >= 250 && px[1] == 0 && px[2] == 0 && px[3] == 255,
        "expected red, got {px:?}"
    );
}

#[test]
fn never_overwrites_existing_files() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = write_webp(src.path(), "same.webp");
    let other = tempfile::tempdir().unwrap();
    let b = write_webp(other.path(), "same.webp");
    std::fs::write(out.path().join("same.png"), b"keep me").unwrap();

    let report = convert_webp_images(
        &[a, b],
        &options(out.path(), TargetFormat::Png),
        &JobContext::detached(),
    )
    .unwrap();

    assert_eq!(report.succeeded, 2);
    assert_eq!(
        std::fs::read(out.path().join("same.png")).unwrap(),
        b"keep me"
    );
    let mut names: Vec<_> = report
        .files
        .iter()
        .map(|f| f.output.clone().unwrap())
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            out.path().join("same (1).png"),
            out.path().join("same (2).png")
        ]
    );
}

#[test]
fn bad_files_fail_alone_and_the_batch_continues() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let good = write_webp(src.path(), "good.webp");
    let not_webp = src.path().join("fake.webp");
    std::fs::write(&not_webp, b"\x89PNG\r\n\x1a\n not a webp at all").unwrap();
    let truncated = src.path().join("broken.webp");
    let bytes = std::fs::read(&good).unwrap();
    std::fs::write(&truncated, &bytes[..bytes.len() / 2]).unwrap();
    let missing = src.path().join("missing.webp");

    let inputs = vec![
        not_webp.clone(),
        good.clone(),
        truncated.clone(),
        missing.clone(),
    ];
    let report = convert_webp_images(
        &inputs,
        &options(out.path(), TargetFormat::Png),
        &JobContext::detached(),
    )
    .unwrap();

    assert_eq!((report.succeeded, report.failed), (1, 3));
    let codes: Vec<_> = report
        .files
        .iter()
        .map(|f| f.error.as_ref().map(|e| e.code()))
        .collect();
    assert_eq!(codes[0], Some("unsupported"));
    assert_eq!(codes[1], None);
    assert_eq!(codes[2], Some("invalid_input"));
    assert_eq!(codes[3], Some("not_found"));
    // Report order follows input order, and failed files leave nothing behind.
    let sources: Vec<_> = report.files.iter().map(|f| f.source.clone()).collect();
    assert_eq!(sources, inputs);
    let written: Vec<_> = std::fs::read_dir(out.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(written, vec![std::ffi::OsString::from("good.png")]);
}

#[test]
fn detects_webp_by_content_not_extension() {
    let src = tempfile::tempdir().unwrap();
    let webp = write_webp(src.path(), "no-extension");
    assert!(is_webp(&webp).unwrap());
    let short = src.path().join("short.webp");
    std::fs::write(&short, b"RIFF").unwrap();
    assert!(!is_webp(&short).unwrap());

    let out = tempfile::tempdir().unwrap();
    let report = convert_webp_images(
        &[webp],
        &options(out.path(), TargetFormat::Png),
        &JobContext::detached(),
    )
    .unwrap();
    assert_eq!(
        report.files[0].output,
        Some(out.path().join("no-extension.png"))
    );
}

#[test]
fn rejects_bad_requests_before_starting() {
    let src = tempfile::tempdir().unwrap();
    let input = write_webp(src.path(), "a.webp");
    let ctx = JobContext::detached();

    let none: Vec<PathBuf> = Vec::new();
    assert_eq!(
        convert_webp_images(&none, &options(src.path(), TargetFormat::Png), &ctx)
            .unwrap_err()
            .code(),
        "invalid_input"
    );

    let mut bad_quality = options(src.path(), TargetFormat::Jpg);
    bad_quality.quality = 0;
    assert_eq!(
        convert_webp_images(std::slice::from_ref(&input), &bad_quality, &ctx)
            .unwrap_err()
            .code(),
        "invalid_input"
    );

    let missing_dir = options(&src.path().join("nope"), TargetFormat::Png);
    assert_eq!(
        convert_webp_images(std::slice::from_ref(&input), &missing_dir, &ctx)
            .unwrap_err()
            .code(),
        "not_found"
    );

    let file_as_dir = options(&input, TargetFormat::Png);
    assert_eq!(
        convert_webp_images(&[input], &file_as_dir, &ctx)
            .unwrap_err()
            .code(),
        "invalid_input"
    );
}

#[test]
fn reports_progress_per_file_up_to_the_total() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let inputs: Vec<_> = (0..5)
        .map(|i| write_webp(src.path(), &format!("p{i}.webp")))
        .collect();
    let seen = Arc::new(Mutex::new(Vec::<Progress>::new()));
    let seen2 = Arc::clone(&seen);
    let sink: ProgressSink = Arc::new(move |_, p| seen2.lock().unwrap().push(p.clone()));
    let ctx = JobContext::new(1, CancelToken::new(), Some(sink)).with_min_interval(Duration::ZERO);

    let report =
        convert_webp_images(&inputs, &options(out.path(), TargetFormat::Jpg), &ctx).unwrap();

    assert_eq!(report.succeeded, 5);
    let seen = seen.lock().unwrap();
    assert!(seen.iter().all(|p| p.stage == STAGE && p.total == Some(5)));
    assert_eq!(seen.first().unwrap().done, 0);
    assert_eq!(seen.last().unwrap().done, 5);
}

#[test]
fn cancel_before_start_writes_nothing() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let input = write_webp(src.path(), "a.webp");
    let ctx = JobContext::detached();
    ctx.cancel_token().cancel();

    let err =
        convert_webp_images(&[input], &options(out.path(), TargetFormat::Png), &ctx).unwrap_err();

    assert!(err.is_cancelled());
    assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
}

/// Free memory reported as too low until the job is cancelled from outside.
struct StarvedMemory(AtomicU64);

impl MemoryProbe for StarvedMemory {
    fn available_bytes(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
    fn total_bytes(&self) -> u64 {
        8 * 1024 * MIB
    }
}

#[test]
fn waits_for_memory_and_can_be_cancelled_while_waiting() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let input = write_webp(src.path(), "a.webp");
    let token = CancelToken::new();
    let ctx = JobContext::new(1, token.clone(), None);
    let probe = Arc::new(StarvedMemory(AtomicU64::new(MIB)));

    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        token.cancel();
    });
    let err = convert_webp_images_with(
        &[input],
        &options(out.path(), TargetFormat::Png),
        &ctx,
        probe,
    )
    .unwrap_err();
    canceller.join().unwrap();

    assert!(err.is_cancelled());
    assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
}

#[test]
fn report_serializes_for_the_frontend() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let good = write_webp(src.path(), "a.webp");
    let missing = src.path().join("gone.webp");
    let report = convert_webp_images(
        &[good, missing],
        &options(out.path(), TargetFormat::Png),
        &JobContext::detached(),
    )
    .unwrap();

    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["succeeded"], 1);
    assert_eq!(json["failed"], 1);
    assert_eq!(json["files"][0]["width"], 4);
    assert!(json["files"][0]["outputBytes"].as_u64().unwrap() > 0);
    assert_eq!(json["files"][0]["error"], serde_json::Value::Null);
    assert_eq!(json["files"][1]["error"]["code"], "not_found");

    let parsed: ConvertOptions =
        serde_json::from_value(serde_json::json!({"format": "jpeg", "outputDir": "/tmp"})).unwrap();
    assert_eq!(parsed.format, TargetFormat::Jpeg);
    assert_eq!(parsed.quality, 90);
}
