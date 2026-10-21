//! Photo compression through the public API, with real files on disk.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dokuwu_core::job::{CancelToken, JobContext, Progress, ProgressSink};
use dokuwu_core::ops::photo_compress::{
    compress_photos, compress_photos_with, detect_kind, CompressOptions, OutputFormat, STAGE,
};
use dokuwu_core::resources::{MemoryProbe, MIB};
use image::codecs::jpeg::JpegEncoder;
use image::{ImageEncoder, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};

/// Smooth gradient plus a little noise: compresses like a photo does.
fn photo(width: u32, height: u32) -> RgbImage {
    let mut seed = 12345u32;
    RgbImage::from_fn(width, height, |x, y| {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let noise = (seed >> 28) as u8; // 0..15
        Rgb([
            ((x * 255) / width.max(1)) as u8 / 2 + noise,
            ((y * 255) / height.max(1)) as u8 / 2 + noise,
            ((x + y) % 200) as u8 / 2 + noise,
        ])
    })
}

fn write_jpeg(dir: &Path, name: &str, img: &RgbImage, quality: u8) -> PathBuf {
    let path = dir.join(name);
    let file = std::fs::File::create(&path).unwrap();
    JpegEncoder::new_with_quality(file, quality)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    path
}

fn write_png(dir: &Path, name: &str, img: &RgbaImage) -> PathBuf {
    let path = dir.join(name);
    img.save_with_format(&path, ImageFormat::Png).unwrap();
    path
}

fn options(dir: &Path) -> CompressOptions {
    CompressOptions {
        quality: 60,
        max_side: None,
        format: OutputFormat::Keep,
        output_dir: dir.to_path_buf(),
    }
}

fn len(path: &Path) -> u64 {
    std::fs::metadata(path).unwrap().len()
}

fn format_of(path: &Path) -> Option<ImageFormat> {
    image::ImageReader::open(path)
        .unwrap()
        .with_guessed_format()
        .unwrap()
        .format()
}

fn dir_is_empty(dir: &Path) -> bool {
    std::fs::read_dir(dir).unwrap().count() == 0
}

#[test]
fn jpeg_gets_smaller_at_a_lower_quality() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let input = write_jpeg(src.path(), "trip.jpg", &photo(640, 480), 95);

    let report = compress_photos(
        std::slice::from_ref(&input),
        &options(out.path()),
        &JobContext::detached(),
    )
    .unwrap();

    assert_eq!((report.succeeded, report.failed), (1, 0));
    let file = &report.files[0];
    let output = file.output.clone().unwrap();
    assert_eq!(output, out.path().join("trip (compressed).jpg"));
    assert_eq!(file.source, input);
    assert_eq!((file.width, file.height), (Some(640), Some(480)));
    assert_eq!(file.original_bytes, Some(len(&input)));
    assert_eq!(file.output_bytes, Some(len(&output)));
    assert!(file.output_bytes.unwrap() < file.original_bytes.unwrap());
    assert!(!file.kept_original && !file.resized);
    assert_eq!(report.original_bytes, len(&input));
    assert_eq!(report.output_bytes, len(&output));
    assert_eq!(format_of(&output), Some(ImageFormat::Jpeg));
    assert_eq!(image::open(&output).unwrap().width(), 640);
}

#[test]
fn keeps_the_original_when_recompressing_would_not_help() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    // Already at quality 30; asking for 95 can only make it bigger.
    let input = write_jpeg(src.path(), "small.jpg", &photo(320, 240), 30);
    let mut opts = options(out.path());
    opts.quality = 95;

    let report =
        compress_photos(std::slice::from_ref(&input), &opts, &JobContext::detached()).unwrap();

    let file = &report.files[0];
    assert!(file.kept_original);
    let output = file.output.clone().unwrap();
    assert_eq!(
        std::fs::read(&output).unwrap(),
        std::fs::read(&input).unwrap()
    );
    assert_eq!(file.output_bytes, file.original_bytes);
}

#[test]
fn max_side_shrinks_large_images_and_never_enlarges() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let big = write_jpeg(src.path(), "big.jpg", &photo(400, 200), 90);
    let small = write_jpeg(src.path(), "tiny.jpg", &photo(60, 40), 90);
    let mut opts = options(out.path());
    opts.max_side = Some(100);

    let report = compress_photos(&[big, small], &opts, &JobContext::detached()).unwrap();

    let (big_f, small_f) = (&report.files[0], &report.files[1]);
    assert_eq!((big_f.width, big_f.height), (Some(100), Some(50)));
    assert!(big_f.resized);
    assert_eq!((small_f.width, small_f.height), (Some(60), Some(40)));
    assert!(!small_f.resized);
    let decoded = image::open(big_f.output.as_ref().unwrap()).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (100, 50));
}

#[test]
fn resized_output_is_kept_even_when_not_smaller_in_bytes() {
    // The user asked for a smaller picture; a copy of the big original would
    // ignore that.
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let input = write_jpeg(src.path(), "a.jpg", &photo(200, 200), 10);
    let mut opts = options(out.path());
    opts.quality = 100;
    opts.max_side = Some(150);

    let report = compress_photos(&[input], &opts, &JobContext::detached()).unwrap();

    let file = &report.files[0];
    assert!(file.resized && !file.kept_original);
    assert_eq!(file.width, Some(150));
}

#[test]
fn png_stays_lossless_and_keeps_transparency() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let mut img = RgbaImage::new(64, 64);
    for (x, y, px) in img.enumerate_pixels_mut() {
        *px = if x < 32 {
            Rgba([200, (y * 3) as u8, 30, 255])
        } else {
            Rgba([0, 0, 255, 0])
        };
    }
    let input = write_png(src.path(), "logo.png", &img);

    let report = compress_photos(
        std::slice::from_ref(&input),
        &options(out.path()),
        &JobContext::detached(),
    )
    .unwrap();

    let file = &report.files[0];
    let output = file.output.clone().unwrap();
    assert_eq!(output, out.path().join("logo (compressed).png"));
    assert_eq!(format_of(&output), Some(ImageFormat::Png));
    let decoded = image::open(&output).unwrap().to_rgba8();
    assert_eq!(decoded.get_pixel(0, 5), img.get_pixel(0, 5));
    assert_eq!(decoded.get_pixel(60, 5)[3], 0);
    assert!(file.output_bytes.unwrap() <= file.original_bytes.unwrap());
}

#[test]
fn png_can_become_a_jpeg_with_white_instead_of_transparency() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let rgb = photo(300, 200);
    let mut img = RgbaImage::new(300, 200);
    for (x, y, px) in img.enumerate_pixels_mut() {
        let p = rgb.get_pixel(x, y);
        *px = Rgba([p[0], p[1], p[2], if x < 250 { 255 } else { 0 }]);
    }
    let input = write_png(src.path(), "shot.png", &img);
    let mut opts = options(out.path());
    opts.format = OutputFormat::Jpeg;

    let report =
        compress_photos(std::slice::from_ref(&input), &opts, &JobContext::detached()).unwrap();

    let file = &report.files[0];
    let output = file.output.clone().unwrap();
    assert_eq!(output, out.path().join("shot (compressed).jpg"));
    assert_eq!(format_of(&output), Some(ImageFormat::Jpeg));
    assert!(file.output_bytes.unwrap() < file.original_bytes.unwrap());
    assert!(!file.kept_original);
    let decoded = image::open(&output).unwrap().to_rgb8();
    assert!(decoded.get_pixel(290, 10).0.iter().all(|&c| c > 240));
}

/// Inserts an EXIF block with the given orientation right after the SOI.
fn set_exif_orientation(path: &Path, orientation: u8) {
    let jpeg = std::fs::read(path).unwrap();
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"MM\0\x2a\0\0\0\x08"); // big endian, IFD at 8
    tiff.extend_from_slice(&[0, 1]); // one entry
    tiff.extend_from_slice(&[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0]);
    tiff.extend_from_slice(&[0, 0, 0, 0]); // no next IFD
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&tiff);
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&app1);
    out.extend_from_slice(&jpeg[2..]);
    std::fs::write(path, out).unwrap();
}

#[test]
fn exif_orientation_is_applied_to_the_pixels() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    // Orientation 6: the camera was turned, a viewer shows it rotated 90 deg.
    let input = write_jpeg(src.path(), "phone.jpg", &photo(80, 40), 95);
    set_exif_orientation(&input, 6);

    let report = compress_photos(
        std::slice::from_ref(&input),
        &options(out.path()),
        &JobContext::detached(),
    )
    .unwrap();

    let file = &report.files[0];
    assert_eq!((file.width, file.height), (Some(40), Some(80)));
    let decoded = image::open(file.output.as_ref().unwrap()).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (40, 80));
}

#[test]
fn grayscale_jpeg_stays_grayscale() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let gray = image::GrayImage::from_fn(200, 100, |x, y| image::Luma([((x + y) % 256) as u8]));
    let input = src.path().join("gray.jpg");
    JpegEncoder::new_with_quality(std::fs::File::create(&input).unwrap(), 95)
        .write_image(gray.as_raw(), 200, 100, image::ExtendedColorType::L8)
        .unwrap();

    let report = compress_photos(
        std::slice::from_ref(&input),
        &options(out.path()),
        &JobContext::detached(),
    )
    .unwrap();

    let output = report.files[0].output.clone().unwrap();
    assert_eq!(image::open(&output).unwrap().color(), image::ColorType::L8);
}

#[test]
fn keeps_a_jpeg_extension_the_user_chose() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let input = write_jpeg(src.path(), "cam.JPEG", &photo(200, 100), 95);

    let report = compress_photos(
        std::slice::from_ref(&input),
        &options(out.path()),
        &JobContext::detached(),
    )
    .unwrap();

    assert_eq!(
        report.files[0].output.clone().unwrap(),
        out.path().join("cam (compressed).jpeg")
    );
}

#[test]
fn never_overwrites_existing_files() {
    let src = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = write_jpeg(src.path(), "same.jpg", &photo(100, 100), 95);
    let b = write_jpeg(other.path(), "same.jpg", &photo(120, 100), 95);
    let existing = out.path().join("same (compressed).jpg");
    std::fs::write(&existing, b"precious").unwrap();

    let report = compress_photos(&[a, b], &options(out.path()), &JobContext::detached()).unwrap();

    assert_eq!(std::fs::read(&existing).unwrap(), b"precious");
    let mut outputs: Vec<_> = report
        .files
        .iter()
        .map(|f| {
            f.output
                .clone()
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    outputs.sort();
    assert_eq!(
        outputs,
        ["same (compressed) (1).jpg", "same (compressed) (2).jpg"]
    );
}

#[test]
fn bad_files_fail_alone_and_the_batch_continues() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let good = write_jpeg(src.path(), "good.jpg", &photo(200, 100), 95);
    let missing = src.path().join("gone.jpg");
    let text = src.path().join("notes.jpg");
    std::fs::write(&text, b"just some text, not an image").unwrap();
    let truncated = src.path().join("cut.jpg");
    let full = std::fs::read(write_jpeg(src.path(), "full.jpg", &photo(400, 300), 95)).unwrap();
    std::fs::write(&truncated, &full[..full.len() / 3]).unwrap();
    let truncated_png = src.path().join("cut.png");
    let png_full = std::fs::read(write_png(
        src.path(),
        "full.png",
        &RgbaImage::from_fn(200, 200, |x, y| {
            Rgba([x as u8, y as u8, (x ^ y) as u8, 255])
        }),
    ))
    .unwrap();
    std::fs::write(&truncated_png, &png_full[..png_full.len() / 2]).unwrap();
    // A WEBP is a valid image but not one this tool compresses.
    let webp = src.path().join("pic.webp");
    std::fs::write(&webp, b"RIFF\x04\0\0\0WEBPVP8 ").unwrap();

    let report = compress_photos(
        &[missing, good, text, truncated, webp, truncated_png],
        &options(out.path()),
        &JobContext::detached(),
    )
    .unwrap();

    assert_eq!((report.succeeded, report.failed), (1, 5));
    let codes: Vec<_> = report
        .files
        .iter()
        .map(|f| f.error.as_ref().map(|e| e.code()))
        .collect();
    assert_eq!(
        codes,
        [
            Some("not_found"),
            None,
            Some("unsupported"),
            Some("invalid_input"),
            Some("unsupported"),
            Some("invalid_input")
        ]
    );
    // Only the good file left something behind.
    assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 1);
}

#[test]
fn detects_the_format_by_content_not_extension() {
    let dir = tempfile::tempdir().unwrap();
    let jpeg = write_jpeg(dir.path(), "photo.png", &photo(20, 20), 90);
    let png = write_png(dir.path(), "shot.jpg", &RgbaImage::new(4, 4));
    let other = dir.path().join("x.jpg");
    std::fs::write(&other, b"GIF89a").unwrap();
    let empty = dir.path().join("empty.png");
    std::fs::write(&empty, b"").unwrap();

    assert_eq!(detect_kind(&jpeg).unwrap(), Some("jpeg"));
    assert_eq!(detect_kind(&png).unwrap(), Some("png"));
    assert_eq!(detect_kind(&other).unwrap(), None);
    assert_eq!(detect_kind(&empty).unwrap(), None);
    assert_eq!(
        detect_kind(&dir.path().join("nope.jpg"))
            .unwrap_err()
            .code(),
        "not_found"
    );
}

#[test]
fn rejects_bad_requests_before_starting() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let input = write_jpeg(src.path(), "a.jpg", &photo(32, 32), 90);
    let ctx = JobContext::detached();
    let code = |inputs: &[PathBuf], opts: &CompressOptions| {
        compress_photos(inputs, opts, &ctx).unwrap_err().code()
    };

    assert_eq!(code(&[], &options(out.path())), "invalid_input");
    for quality in [0u8, 101] {
        let mut opts = options(out.path());
        opts.quality = quality;
        assert_eq!(code(std::slice::from_ref(&input), &opts), "invalid_input");
    }
    let mut opts = options(out.path());
    opts.max_side = Some(4);
    assert_eq!(code(std::slice::from_ref(&input), &opts), "invalid_input");
    assert_eq!(
        code(
            std::slice::from_ref(&input),
            &options(&out.path().join("missing"))
        ),
        "not_found"
    );
    assert_eq!(
        code(std::slice::from_ref(&input), &options(&input)),
        "invalid_input"
    );
    assert!(dir_is_empty(out.path()));
}

#[test]
fn reports_progress_per_file_up_to_the_total() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let inputs: Vec<_> = (0..5)
        .map(|i| write_jpeg(src.path(), &format!("p{i}.jpg"), &photo(64, 64), 95))
        .collect();
    let seen = Arc::new(Mutex::new(Vec::<Progress>::new()));
    let seen2 = Arc::clone(&seen);
    let sink: ProgressSink = Arc::new(move |_, p| seen2.lock().unwrap().push(p.clone()));
    let ctx = JobContext::new(1, CancelToken::new(), Some(sink)).with_min_interval(Duration::ZERO);

    let report = compress_photos(&inputs, &options(out.path()), &ctx).unwrap();

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
    let input = write_jpeg(src.path(), "a.jpg", &photo(32, 32), 90);
    let ctx = JobContext::detached();
    ctx.cancel_token().cancel();

    let err = compress_photos(&[input], &options(out.path()), &ctx).unwrap_err();

    assert!(err.is_cancelled());
    assert!(dir_is_empty(out.path()));
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
    let input = write_jpeg(src.path(), "a.jpg", &photo(32, 32), 90);
    let token = CancelToken::new();
    let ctx = JobContext::new(1, token.clone(), None);
    let probe = Arc::new(StarvedMemory(AtomicU64::new(MIB)));

    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        token.cancel();
    });
    let err = compress_photos_with(&[input], &options(out.path()), &ctx, probe).unwrap_err();
    canceller.join().unwrap();

    assert!(err.is_cancelled());
    assert!(dir_is_empty(out.path()));
}

#[test]
fn many_files_run_with_a_single_worker_when_memory_is_tight() {
    // 700 MiB free with a 512 MiB reserve leaves less than one planned worker,
    // so the pool is one thread: files are done one at a time, in order.
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let inputs: Vec<_> = (0..6)
        .map(|i| write_jpeg(src.path(), &format!("m{i}.jpg"), &photo(96, 96), 95))
        .collect();
    let probe = Arc::new(StarvedMemory(AtomicU64::new(700 * MIB)));

    let report = compress_photos_with(
        &inputs,
        &options(out.path()),
        &JobContext::detached(),
        probe,
    )
    .unwrap();

    assert_eq!(report.succeeded, 6);
    let sources: Vec<_> = report.files.iter().map(|f| f.source.clone()).collect();
    assert_eq!(sources, inputs);
}

#[test]
fn report_and_options_serialize_for_the_frontend() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let good = write_jpeg(src.path(), "a.jpg", &photo(100, 80), 95);
    let missing = src.path().join("gone.jpg");
    let report = compress_photos(
        &[good, missing],
        &options(out.path()),
        &JobContext::detached(),
    )
    .unwrap();

    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(
        (json["succeeded"].as_u64(), json["failed"].as_u64()),
        (Some(1), Some(1))
    );
    assert_eq!(json["files"][0]["width"], 100);
    assert!(json["files"][0]["originalBytes"].as_u64().unwrap() > 0);
    assert!(json["files"][0]["outputBytes"].as_u64().unwrap() > 0);
    assert_eq!(json["files"][0]["keptOriginal"], false);
    assert_eq!(json["files"][0]["resized"], false);
    assert_eq!(json["files"][0]["error"], serde_json::Value::Null);
    assert_eq!(json["files"][1]["error"]["code"], "not_found");
    assert_eq!(json["outputBytes"], json["files"][0]["outputBytes"]);

    let parsed: CompressOptions =
        serde_json::from_value(serde_json::json!({"outputDir": "/tmp"})).unwrap();
    assert_eq!(parsed.quality, 75);
    assert_eq!(parsed.max_side, None);
    assert_eq!(parsed.format, OutputFormat::Keep);
    let parsed: CompressOptions = serde_json::from_value(
        serde_json::json!({"outputDir": "/tmp", "quality": 50, "maxSide": 1600, "format": "jpeg"}),
    )
    .unwrap();
    assert_eq!(
        (parsed.quality, parsed.max_side, parsed.format),
        (50, Some(1600), OutputFormat::Jpeg)
    );
}

#[test]
fn a_jpeg_with_extra_data_after_its_end_is_still_compressed() {
    // Phones append a video or a second image after the end-of-image marker.
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let input = write_jpeg(src.path(), "motion.jpg", &photo(300, 200), 95);
    set_exif_orientation(&input, 1);
    let mut bytes = std::fs::read(&input).unwrap();
    bytes.extend_from_slice(&vec![0xFFu8; 3000]);
    bytes.extend_from_slice(b"....ftypmp42 pretend video....");
    std::fs::write(&input, bytes).unwrap();

    let report = compress_photos(&[input], &options(out.path()), &JobContext::detached()).unwrap();

    assert_eq!((report.succeeded, report.failed), (1, 0));
}
