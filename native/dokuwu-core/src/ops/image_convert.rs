//! WEBP to PNG / JPG / JPEG conversion, one file at a time.
//!
//! Inputs are paths and outputs are written straight to disk, so the frontend
//! never holds image bytes. Memory use is bounded by the images being decoded
//! at that moment: the pool size comes from free RAM, and each file waits on a
//! [`MemoryBrake`] sized from its own dimensions before it is decoded.
//!
//! A batch keeps going when one file fails; the report lists every file with
//! its output or its error. Cancelling stops before the next file, removes the
//! file being written, and keeps the files already finished.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPDecoder;
use image::{DynamicImage, ImageDecoder, ImageEncoder, Limits, RgbImage};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;
use crate::resources::{worker_count, MemoryBrake, MemoryProbe, SystemMemory, MIB};

/// Stage name used in progress reports.
pub const STAGE: &str = "converting";

pub const DEFAULT_JPEG_QUALITY: u8 = 90;

/// Upper bound on parallel decodes. Encoding is CPU bound, but more workers
/// than this mostly add memory pressure for little gain.
const MAX_WORKERS: usize = 4;
/// Planning estimate for one worker, used only to size the pool. Each file
/// still checks its real need with the memory brake.
const PLANNED_BYTES_PER_WORKER: u64 = 256 * MIB;
/// Left free for the app and the rest of the system.
const RESERVE_BYTES: u64 = 512 * MIB;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetFormat {
    Png,
    Jpg,
    Jpeg,
}

impl TargetFormat {
    pub fn extension(self) -> &'static str {
        match self {
            TargetFormat::Png => "png",
            TargetFormat::Jpg => "jpg",
            TargetFormat::Jpeg => "jpeg",
        }
    }

    fn is_jpeg(self) -> bool {
        matches!(self, TargetFormat::Jpg | TargetFormat::Jpeg)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertOptions {
    pub format: TargetFormat,
    /// JPEG quality, 1 to 100. Ignored for PNG.
    #[serde(default = "default_quality")]
    pub quality: u8,
    /// Folder the converted files are written to. Must exist.
    pub output_dir: PathBuf,
}

fn default_quality() -> u8 {
    DEFAULT_JPEG_QUALITY
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertedFile {
    pub source: PathBuf,
    /// Where the converted file was written; `None` when this file failed.
    pub output: Option<PathBuf>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub output_bytes: Option<u64>,
    /// True when the source was an animated WEBP; only its first frame is kept.
    pub animated: bool,
    pub error: Option<CoreError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertReport {
    /// One entry per input, in input order.
    pub files: Vec<ConvertedFile>,
    pub succeeded: usize,
    pub failed: usize,
}

/// Converts every input with the system's live memory figures.
pub fn convert_webp_images(
    inputs: &[PathBuf],
    options: &ConvertOptions,
    ctx: &JobContext,
) -> CoreResult<ConvertReport> {
    convert_webp_images_with(inputs, options, ctx, Arc::new(SystemMemory::new()))
}

/// Same as [`convert_webp_images`], with the memory source injected (tests).
pub fn convert_webp_images_with(
    inputs: &[PathBuf],
    options: &ConvertOptions,
    ctx: &JobContext,
    probe: Arc<dyn MemoryProbe>,
) -> CoreResult<ConvertReport> {
    validate(inputs, options)?;
    ctx.check_cancelled()?;

    let total = inputs.len() as u64;
    ctx.report(STAGE, 0, Some(total));

    let workers = worker_count(
        probe.as_ref(),
        PLANNED_BYTES_PER_WORKER,
        RESERVE_BYTES,
        MAX_WORKERS,
    )
    .min(inputs.len());
    let next = AtomicUsize::new(0);
    let done = AtomicU64::new(0);
    let cancelled = AtomicBool::new(false);
    // Serializes picking an output name and creating it, so two inputs with
    // the same stem in one batch never collide.
    let name_lock = Mutex::new(());
    let slots: Vec<Mutex<Option<ConvertedFile>>> =
        inputs.iter().map(|_| Mutex::new(None)).collect();

    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if cancelled.load(Ordering::SeqCst) || ctx.check_cancelled().is_err() {
                    cancelled.store(true, Ordering::SeqCst);
                    return;
                }
                let index = next.fetch_add(1, Ordering::SeqCst);
                let Some(source) = inputs.get(index) else {
                    return;
                };
                let outcome = convert_one(source, options, ctx, &probe, &name_lock);
                let entry = match outcome {
                    Err(err) if err.is_cancelled() => {
                        cancelled.store(true, Ordering::SeqCst);
                        return;
                    }
                    Ok(entry) => entry,
                    Err(error) => failed_entry(source, error),
                };
                *slots[index].lock().unwrap_or_else(|e| e.into_inner()) = Some(entry);
                let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                ctx.report(STAGE, finished, Some(total));
            });
        }
    });

    if cancelled.load(Ordering::SeqCst) {
        return Err(CoreError::Cancelled);
    }

    let files: Vec<ConvertedFile> = slots
        .into_iter()
        .zip(inputs)
        .map(|(slot, source)| {
            slot.into_inner()
                .unwrap_or_else(|e| e.into_inner())
                .unwrap_or_else(|| {
                    failed_entry(source, CoreError::Internal("file was not processed".into()))
                })
        })
        .collect();
    let succeeded = files.iter().filter(|f| f.error.is_none()).count();
    Ok(ConvertReport {
        failed: files.len() - succeeded,
        succeeded,
        files,
    })
}

fn validate(inputs: &[PathBuf], options: &ConvertOptions) -> CoreResult<()> {
    if inputs.is_empty() {
        return Err(CoreError::InvalidInput("no input files".into()));
    }
    if !(1..=100).contains(&options.quality) {
        return Err(CoreError::InvalidInput(format!(
            "JPEG quality must be between 1 and 100, got {}",
            options.quality
        )));
    }
    let meta =
        fs::metadata(&options.output_dir).map_err(|e| CoreError::io(&options.output_dir, e))?;
    if !meta.is_dir() {
        return Err(CoreError::InvalidInput(format!(
            "output folder is not a folder: {}",
            options.output_dir.display()
        )));
    }
    Ok(())
}

fn failed_entry(source: &Path, error: CoreError) -> ConvertedFile {
    ConvertedFile {
        source: source.to_path_buf(),
        output: None,
        width: None,
        height: None,
        output_bytes: None,
        animated: false,
        error: Some(error),
    }
}

/// True when the file starts with a RIFF/WEBP header. The extension is not
/// trusted: a renamed PNG is rejected, a WEBP without `.webp` is accepted.
pub fn is_webp(path: &Path) -> CoreResult<bool> {
    let mut header = [0u8; 12];
    let mut file = File::open(path).map_err(|e| CoreError::io(path, e))?;
    let mut read = 0;
    while read < header.len() {
        match file.read(&mut header[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(CoreError::io(path, e)),
        }
    }
    Ok(read == header.len() && &header[0..4] == b"RIFF" && &header[8..12] == b"WEBP")
}

fn convert_one(
    source: &Path,
    options: &ConvertOptions,
    ctx: &JobContext,
    probe: &Arc<dyn MemoryProbe>,
    name_lock: &Mutex<()>,
) -> CoreResult<ConvertedFile> {
    let meta = fs::metadata(source).map_err(|e| CoreError::io(source, e))?;
    if !meta.is_file() {
        return Err(CoreError::InvalidInput(format!(
            "not a file: {}",
            source.display()
        )));
    }
    if !is_webp(source)? {
        return Err(CoreError::Unsupported(format!(
            "not a WEBP image: {}",
            source.display()
        )));
    }

    let reader = BufReader::new(File::open(source).map_err(|e| CoreError::io(source, e))?);
    let mut decoder = WebPDecoder::new(reader).map_err(|e| decode_error(source, e))?;
    let (width, height) = decoder.dimensions();
    let animated = decoder.has_animation();

    // Decoded RGBA plus, for JPEG, the flattened RGB copy, plus encoder slack.
    let pixels = u64::from(width) * u64::from(height);
    let needed = pixels * 4
        + if options.format.is_jpeg() {
            pixels * 3
        } else {
            0
        }
        + 32 * MIB;
    MemoryBrake::new(Arc::clone(probe), needed.saturating_add(RESERVE_BYTES))
        .wait_for_headroom(ctx)?;
    ctx.check_cancelled()?;

    // The brake already checked that this image fits in free memory, so the
    // decoder's default 512 MiB cap would only reject large, legal images.
    decoder
        .set_limits(Limits::no_limits())
        .map_err(|e| decode_error(source, e))?;
    let image = DynamicImage::from_decoder(decoder).map_err(|e| decode_error(source, e))?;
    ctx.check_cancelled()?;

    let (output, file) = {
        let _guard = name_lock.lock().unwrap_or_else(|e| e.into_inner());
        create_unique_output(&options.output_dir, source, options.format)?
    };
    let written = encode(&image, options, file).and_then(|()| {
        fs::metadata(&output)
            .map(|m| m.len())
            .map_err(|e| CoreError::io(&output, e))
    });
    match written {
        Ok(bytes) => Ok(ConvertedFile {
            source: source.to_path_buf(),
            output: Some(output),
            width: Some(width),
            height: Some(height),
            output_bytes: Some(bytes),
            animated,
            error: None,
        }),
        Err(err) => {
            let _ = fs::remove_file(&output);
            Err(err)
        }
    }
}

fn encode(image: &DynamicImage, options: &ConvertOptions, file: File) -> CoreResult<()> {
    let mut out = BufWriter::new(file);
    let result = if options.format.is_jpeg() {
        let rgb = flatten_on_white(image);
        JpegEncoder::new_with_quality(&mut out, options.quality).write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
    } else {
        // PNG keeps transparency. Gray and RGB sources stay in their own
        // colour type, so output is not inflated to RGBA needlessly.
        let image = match image {
            DynamicImage::ImageRgb8(_) | DynamicImage::ImageRgba8(_) => image,
            _ => &DynamicImage::ImageRgba8(image.to_rgba8()),
        };
        PngEncoder::new(&mut out).write_image(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        )
    };
    result.map_err(|e| CoreError::Internal(format!("cannot encode image: {e}")))?;
    out.flush()
        .map_err(|e| CoreError::Internal(format!("cannot write image: {e}")))?;
    let file = out
        .into_inner()
        .map_err(|e| CoreError::Internal(format!("cannot write image: {e}")))?;
    file.sync_all()
        .map_err(|e| CoreError::Internal(format!("cannot write image: {e}")))
}

/// JPEG has no alpha channel. Transparent pixels are blended onto white, which
/// is what the image looks like on a page or in most viewers.
fn flatten_on_white(image: &DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    let mut rgb = RgbImage::new(rgba.width(), rgba.height());
    for (dst, src) in rgb.pixels_mut().zip(rgba.pixels()) {
        let a = u16::from(src[3]);
        for c in 0..3 {
            let v = (u16::from(src[c]) * a + 255 * (255 - a) + 127) / 255;
            dst[c] = v as u8;
        }
    }
    rgb
}

fn decode_error(source: &Path, err: image::ImageError) -> CoreError {
    match err {
        image::ImageError::IoError(e) => CoreError::io(source, e),
        image::ImageError::Unsupported(e) => {
            CoreError::Unsupported(format!("{}: {e}", source.display()))
        }
        other => CoreError::InvalidInput(format!("cannot read {}: {other}", source.display())),
    }
}

/// Creates `<stem>.<ext>` in `dir`, or `<stem> (1).<ext>`, `<stem> (2).<ext>`
/// and so on when the name is taken. Existing files are never overwritten.
fn create_unique_output(
    dir: &Path,
    source: &Path,
    format: TargetFormat,
) -> CoreResult<(PathBuf, File)> {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "image".to_owned());
    let ext = format.extension();
    for n in 0u32..10_000 {
        let name = if n == 0 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(CoreError::io(&path, e)),
        }
    }
    Err(CoreError::InvalidInput(format!(
        "too many files named {stem}.{ext} in {}",
        dir.display()
    )))
}
