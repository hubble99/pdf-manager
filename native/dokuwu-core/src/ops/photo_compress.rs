//! Photo compression: smaller JPEG and PNG files, one image at a time.
//!
//! Inputs are paths and results are written straight to disk, so the frontend
//! never holds image bytes. Memory use depends on the images being processed
//! at that moment, never on how many files there are or how large the files
//! on disk are: the pool size comes from free RAM, and each image waits on a
//! [`MemoryBrake`] sized from its own pixel count before it is decoded.
//!
//! - JPEG is re-encoded at the chosen quality.
//! - PNG is re-encoded losslessly with the strongest compression.
//! - `max_side` shrinks a larger image (never enlarges), keeping its shape.
//! - `format: jpeg` turns any input into a JPEG (transparency becomes white),
//!   which is how a PNG photo shrinks a lot.
//! - When re-encoding in the same format would not make the file smaller, the
//!   original is copied instead, so a result is never bigger than its source.
//!
//! Metadata is dropped except the colour profile; the EXIF orientation is
//! applied to the pixels first, so photos still look upright. A batch keeps
//! going when one file fails. Cancelling stops before the next file, removes
//! the file being written, and keeps the files already finished.

use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use image::codecs::jpeg::{JpegDecoder, JpegEncoder};
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngDecoder, PngEncoder};
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageEncoder, Limits};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;
use crate::ops::batch::run_pool;
use crate::ops::image_convert::{
    create_unique_file, decode_error, file_stem_or_image, flatten_on_white,
};
use crate::resources::{worker_count, MemoryBrake, MemoryProbe, SystemMemory, MIB};

/// Stage name used in progress reports.
pub const STAGE: &str = "compressing";

pub const DEFAULT_QUALITY: u8 = 75;
/// Smallest `max_side` accepted; below this an image is just a few pixels.
pub const MIN_MAX_SIDE: u32 = 16;

/// Upper bound on parallel images. Encoding is CPU bound, but more workers
/// than this mostly add memory pressure for little gain.
const MAX_WORKERS: usize = 4;
/// Planning estimate for one worker, used only to size the pool (a 24 MP
/// photo needs about 150 MiB). Each image still checks its real need with the
/// memory brake.
const PLANNED_BYTES_PER_WORKER: u64 = 384 * MIB;
/// Left free for the app and the rest of the system.
const RESERVE_BYTES: u64 = 512 * MIB;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    /// JPEG stays JPEG and PNG stays PNG.
    #[default]
    Keep,
    /// Every image becomes a JPEG.
    Jpeg,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressOptions {
    /// JPEG quality, 1 to 100. Does not affect PNG, which stays lossless.
    #[serde(default = "default_quality")]
    pub quality: u8,
    /// Longest side in pixels. Larger images are shrunk to fit; smaller ones
    /// are left alone. `None` keeps the original size.
    #[serde(default)]
    pub max_side: Option<u32>,
    #[serde(default)]
    pub format: OutputFormat,
    /// Folder the compressed files are written to. Must exist.
    pub output_dir: PathBuf,
}

fn default_quality() -> u8 {
    DEFAULT_QUALITY
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressedPhoto {
    pub source: PathBuf,
    /// Where the result was written; `None` when this file failed.
    pub output: Option<PathBuf>,
    /// Pixel size of the result.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub original_bytes: Option<u64>,
    pub output_bytes: Option<u64>,
    /// True when the image was shrunk to fit `max_side`.
    pub resized: bool,
    /// True when re-encoding would not have made the file smaller, so the
    /// output is a copy of the original.
    pub kept_original: bool,
    pub error: Option<CoreError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressReport {
    /// One entry per input, in input order.
    pub files: Vec<CompressedPhoto>,
    pub succeeded: usize,
    pub failed: usize,
    /// Sizes summed over the files that succeeded.
    pub original_bytes: u64,
    pub output_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Jpeg,
    Png,
}

/// Compresses every input with the system's live memory figures.
pub fn compress_photos(
    inputs: &[PathBuf],
    options: &CompressOptions,
    ctx: &JobContext,
) -> CoreResult<CompressReport> {
    compress_photos_with(inputs, options, ctx, Arc::new(SystemMemory::new()))
}

/// Same as [`compress_photos`], with the memory source injected (tests).
pub fn compress_photos_with(
    inputs: &[PathBuf],
    options: &CompressOptions,
    ctx: &JobContext,
    probe: Arc<dyn MemoryProbe>,
) -> CoreResult<CompressReport> {
    validate(inputs, options)?;
    ctx.check_cancelled()?;

    let workers = worker_count(
        probe.as_ref(),
        PLANNED_BYTES_PER_WORKER,
        RESERVE_BYTES,
        MAX_WORKERS,
    )
    .min(inputs.len());
    // Serializes picking an output name and creating it, so two inputs with
    // the same stem in one batch never collide.
    let name_lock = std::sync::Mutex::new(());

    let files = run_pool(
        inputs,
        workers,
        ctx,
        STAGE,
        |source| compress_one(source, options, ctx, &probe, &name_lock),
        failed_entry,
    )?;

    let ok = |f: &&CompressedPhoto| f.error.is_none();
    let succeeded = files.iter().filter(ok).count();
    Ok(CompressReport {
        succeeded,
        failed: files.len() - succeeded,
        original_bytes: files
            .iter()
            .filter(ok)
            .filter_map(|f| f.original_bytes)
            .sum(),
        output_bytes: files.iter().filter(ok).filter_map(|f| f.output_bytes).sum(),
        files,
    })
}

fn validate(inputs: &[PathBuf], options: &CompressOptions) -> CoreResult<()> {
    if inputs.is_empty() {
        return Err(CoreError::InvalidInput("no input files".into()));
    }
    if !(1..=100).contains(&options.quality) {
        return Err(CoreError::InvalidInput(format!(
            "quality must be between 1 and 100, got {}",
            options.quality
        )));
    }
    if let Some(side) = options.max_side {
        if side < MIN_MAX_SIDE {
            return Err(CoreError::InvalidInput(format!(
                "the longest side must be at least {MIN_MAX_SIDE} pixels, got {side}"
            )));
        }
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

fn failed_entry(source: &Path, error: CoreError) -> CompressedPhoto {
    CompressedPhoto {
        source: source.to_path_buf(),
        output: None,
        width: None,
        height: None,
        original_bytes: None,
        output_bytes: None,
        resized: false,
        kept_original: false,
        error: Some(error),
    }
}

/// Reads the first bytes to tell JPEG from PNG. The extension is not trusted:
/// a renamed WEBP is rejected, a JPEG without `.jpg` is accepted.
pub fn detect_kind(path: &Path) -> CoreResult<Option<&'static str>> {
    Ok(read_kind(path)?.map(|k| match k {
        Kind::Jpeg => "jpeg",
        Kind::Png => "png",
    }))
}

fn read_kind(path: &Path) -> CoreResult<Option<Kind>> {
    let mut header = [0u8; 8];
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
    if read >= 3 && header[..3] == [0xFF, 0xD8, 0xFF] {
        Ok(Some(Kind::Jpeg))
    } else if read == 8 && header == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        Ok(Some(Kind::Png))
    } else {
        Ok(None)
    }
}

/// True when a JPEG file reaches its end-of-image marker.
///
/// The JPEG decoder fills in the missing part of a cut-off file with grey and
/// reports success, so a truncated photo would be "compressed" into a damaged
/// one. This walks the marker structure (streaming, no allocation) to catch
/// that. Bytes after the end marker, such as an appended video, are ignored.
fn jpeg_is_complete(path: &Path) -> CoreResult<bool> {
    let file = File::open(path).map_err(|e| CoreError::io(path, e))?;
    match scan_jpeg(&mut BufReader::with_capacity(64 * 1024, file)) {
        Ok(complete) => Ok(complete),
        Err(e) if matches!(e.kind(), ErrorKind::UnexpectedEof | ErrorKind::InvalidData) => {
            Ok(false)
        }
        Err(e) => Err(CoreError::io(path, e)),
    }
}

fn scan_jpeg<R: BufRead>(r: &mut R) -> io::Result<bool> {
    let invalid = || io::Error::from(ErrorKind::InvalidData);
    let mut byte = [0u8; 1];
    let mut soi = [0u8; 2];
    r.read_exact(&mut soi)?;
    if soi != [0xFF, 0xD8] {
        return Ok(false);
    }
    let mut after_scan = false;
    loop {
        let marker = if after_scan {
            next_marker_in_scan(r)?
        } else {
            r.read_exact(&mut byte)?;
            if byte[0] != 0xFF {
                return Err(invalid());
            }
            loop {
                r.read_exact(&mut byte)?;
                if byte[0] != 0xFF {
                    break byte[0];
                }
            }
        };
        after_scan = false;
        match marker {
            0xD9 => return Ok(true),
            // Markers without a length: TEM, RSTn, SOI.
            0x00 | 0x01 | 0xD0..=0xD8 => {}
            _ => {
                let mut len = [0u8; 2];
                r.read_exact(&mut len)?;
                let len = u64::from(u16::from_be_bytes(len));
                if len < 2 {
                    return Err(invalid());
                }
                let skipped = io::copy(&mut r.by_ref().take(len - 2), &mut io::sink())?;
                if skipped != len - 2 {
                    return Err(ErrorKind::UnexpectedEof.into());
                }
                after_scan = marker == 0xDA;
            }
        }
    }
}

/// Skips compressed scan data and returns the code of the next real marker.
/// `FF 00` (a stuffed byte) and `FF D0`..`FF D7` (restart) belong to the scan.
fn next_marker_in_scan<R: BufRead>(r: &mut R) -> io::Result<u8> {
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Err(ErrorKind::UnexpectedEof.into());
        }
        let Some(at) = buf.iter().position(|&b| b == 0xFF) else {
            let n = buf.len();
            r.consume(n);
            continue;
        };
        r.consume(at + 1);
        loop {
            let buf = r.fill_buf()?;
            let Some(&next) = buf.first() else {
                return Err(ErrorKind::UnexpectedEof.into());
            };
            match next {
                0xFF => r.consume(1),
                0x00 | 0xD0..=0xD7 => {
                    r.consume(1);
                    break;
                }
                code => {
                    r.consume(1);
                    return Ok(code);
                }
            }
        }
    }
}

fn compress_one(
    source: &Path,
    options: &CompressOptions,
    ctx: &JobContext,
    probe: &Arc<dyn MemoryProbe>,
    name_lock: &std::sync::Mutex<()>,
) -> CoreResult<CompressedPhoto> {
    let meta = fs::metadata(source).map_err(|e| CoreError::io(source, e))?;
    if !meta.is_file() {
        return Err(CoreError::InvalidInput(format!(
            "not a file: {}",
            source.display()
        )));
    }
    let Some(kind) = read_kind(source)? else {
        return Err(CoreError::Unsupported(format!(
            "not a JPEG or PNG image: {}",
            source.display()
        )));
    };
    let original_bytes = meta.len();
    let target = match options.format {
        OutputFormat::Keep => kind,
        OutputFormat::Jpeg => Kind::Jpeg,
    };

    if kind == Kind::Jpeg && !jpeg_is_complete(source)? {
        return Err(CoreError::InvalidInput(format!(
            "cannot read {}: the file is incomplete",
            source.display()
        )));
    }
    let reader = BufReader::new(File::open(source).map_err(|e| CoreError::io(source, e))?);
    match kind {
        Kind::Jpeg => {
            let decoder = JpegDecoder::new(reader).map_err(|e| decode_error(source, e))?;
            run(
                decoder,
                source,
                original_bytes,
                kind,
                target,
                options,
                ctx,
                probe,
                name_lock,
            )
        }
        Kind::Png => {
            let decoder = PngDecoder::new(reader).map_err(|e| decode_error(source, e))?;
            run(
                decoder,
                source,
                original_bytes,
                kind,
                target,
                options,
                ctx,
                probe,
                name_lock,
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run<D: ImageDecoder>(
    mut decoder: D,
    source: &Path,
    original_bytes: u64,
    kind: Kind,
    target: Kind,
    options: &CompressOptions,
    ctx: &JobContext,
    probe: &Arc<dyn MemoryProbe>,
    name_lock: &std::sync::Mutex<()>,
) -> CoreResult<CompressedPhoto> {
    let (width, height) = decoder.dimensions();
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let icc = decoder.icc_profile().ok().flatten();

    // The decoded image plus working copies: the resize keeps an intermediate
    // strip and a result, rotation another copy, and JPEG output from a
    // transparent source a flattened RGB copy. Measured on a 24 MP JPEG: about
    // 2x the decoded size without resizing, 3.3x with it; the factors below
    // leave room on top of that for the encoder.
    let pixels = u64::from(width) * u64::from(height);
    let decoded = pixels * u64::from(decoder.color_type().bytes_per_pixel());
    let shrinks = options
        .max_side
        .is_some_and(|side| width.max(height) > side);
    let flatten = if target == Kind::Jpeg { pixels * 3 } else { 0 };
    let copies = if shrinks { 4 } else { 2 };
    let needed = decoded.saturating_mul(copies) + flatten + 48 * MIB;
    MemoryBrake::new(Arc::clone(probe), needed.saturating_add(RESERVE_BYTES))
        .wait_for_headroom(ctx)?;
    ctx.check_cancelled()?;

    // The brake already checked that this image fits in free memory, so the
    // decoder's default cap would only reject large, legal images.
    decoder
        .set_limits(Limits::no_limits())
        .map_err(|e| decode_error(source, e))?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| decode_error(source, e))?;
    ctx.check_cancelled()?;

    // Shrink first (the smaller image is cheaper to rotate), then upright it.
    let mut resized = false;
    if let Some(max_side) = options.max_side {
        if image.width().max(image.height()) > max_side {
            image = image.resize(max_side, max_side, FilterType::Lanczos3);
            resized = true;
            ctx.check_cancelled()?;
        }
    }
    image.apply_orientation(orientation);
    let (out_width, out_height) = (image.width(), image.height());

    let ext = output_extension(source, target);
    let (output, file) = {
        let _guard = name_lock.lock().unwrap_or_else(|e| e.into_inner());
        create_unique_file(
            &options.output_dir,
            &format!("{} (compressed)", file_stem_or_image(source)),
            ext,
        )?
    };

    let written = encode(&image, target, options.quality, icc, file).and_then(|()| {
        ctx.check_cancelled()?;
        let bytes = file_len(&output)?;
        // Same format, same size, and no gain: hand back the original.
        if kind == target && !resized && bytes >= original_bytes {
            fs::copy(source, &output).map_err(|e| CoreError::io(&output, e))?;
            return Ok((original_bytes, true));
        }
        Ok((bytes, false))
    });
    match written {
        Ok((output_bytes, kept_original)) => Ok(CompressedPhoto {
            source: source.to_path_buf(),
            output: Some(output),
            width: Some(out_width),
            height: Some(out_height),
            original_bytes: Some(original_bytes),
            output_bytes: Some(output_bytes),
            resized,
            kept_original,
            error: None,
        }),
        Err(err) => {
            let _ = fs::remove_file(&output);
            Err(err)
        }
    }
}

fn file_len(path: &Path) -> CoreResult<u64> {
    fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| CoreError::io(path, e))
}

/// A JPEG keeps `.jpeg` if that is what the source used; everything else
/// gets the canonical extension.
fn output_extension(source: &Path, target: Kind) -> &'static str {
    match target {
        Kind::Png => "png",
        Kind::Jpeg => {
            let jpeg_source = source
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("jpeg"));
            if jpeg_source {
                "jpeg"
            } else {
                "jpg"
            }
        }
    }
}

fn encode(
    image: &DynamicImage,
    target: Kind,
    quality: u8,
    icc: Option<Vec<u8>>,
    file: File,
) -> CoreResult<()> {
    let mut out = BufWriter::new(file);
    let result = match target {
        Kind::Jpeg => {
            let mut encoder = JpegEncoder::new_with_quality(&mut out, quality);
            if let Some(profile) = icc {
                let _ = encoder.set_icc_profile(profile);
            }
            match image {
                // Grayscale photos stay one channel.
                DynamicImage::ImageLuma8(gray) => encoder.write_image(
                    gray.as_raw(),
                    gray.width(),
                    gray.height(),
                    image::ExtendedColorType::L8,
                ),
                _ => {
                    let rgb = flatten_on_white(image);
                    encoder.write_image(
                        rgb.as_raw(),
                        rgb.width(),
                        rgb.height(),
                        image::ExtendedColorType::Rgb8,
                    )
                }
            }
        }
        Kind::Png => {
            let mut encoder =
                PngEncoder::new_with_quality(&mut out, CompressionType::Best, PngFilter::Adaptive);
            if let Some(profile) = icc {
                let _ = encoder.set_icc_profile(profile);
            }
            encoder.write_image(
                image.as_bytes(),
                image.width(),
                image.height(),
                image.color().into(),
            )
        }
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
