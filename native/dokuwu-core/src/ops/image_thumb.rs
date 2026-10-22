//! Small previews of picture files for the Images to PDF list.
//!
//! The browser view cannot show every format the converter accepts (TIFF, for
//! one), and it does not apply a photo's EXIF orientation to a decoded copy
//! the way the PDF will have it. A thumbnail is decoded here instead: oriented
//! like the PDF page, transparency flattened on white, JPEG, longest side
//! `max_side`. Decoding runs on two threads so a list of 200 photos cannot
//! decode 200 at once.

use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use image::{DynamicImage, ImageDecoder, ImageReader, Limits};
use jpeg_encoder::{ColorType, Encoder as JpegEncoder};

use crate::error::{CoreError, CoreResult};
use crate::ops::image_to_pdf::flatten;

pub const MIN_SIDE: u32 = 16;
pub const MAX_SIDE: u32 = 1024;
const QUALITY: u8 = 80;
const WORKERS: usize = 2;
/// Refused rather than decoded: a thumbnail is not worth this much memory.
const MAX_PIXELS: u64 = 400_000_000;

/// JPEG bytes of `path`, scaled so its longest side is at most `max_side`.
pub fn thumbnail_jpeg(path: &Path, max_side: u32) -> CoreResult<Vec<u8>> {
    let side = max_side.clamp(MIN_SIDE, MAX_SIDE);
    let file = std::fs::File::open(path).map_err(|e| CoreError::io(path, e))?;
    let mut decoder = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|e| CoreError::io(path, e))?
        .into_decoder()
        .map_err(|e| CoreError::Unsupported(format!("cannot read image: {e}")))?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 || w as u64 * h as u64 > MAX_PIXELS {
        return Err(CoreError::Unsupported(format!("image of {w} x {h} pixels is too large")));
    }
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut limits = Limits::default();
    limits.max_alloc = Some(w as u64 * h as u64 * 16 + (64 << 20));
    decoder.set_limits(limits).map_err(|e| CoreError::Unsupported(format!("image too large: {e}")))?;
    let decoded = DynamicImage::from_decoder(decoder)
        .map_err(|e| CoreError::Unsupported(format!("cannot decode image: {e}")))?;
    let mut small = decoded.thumbnail(side, side);
    small.apply_orientation(orientation);
    let (width, height) = (small.width(), small.height());
    let (gray, pixels) = flatten(small);
    let rgb: Vec<u8> = if gray { pixels.iter().flat_map(|&g| [g, g, g]).collect() } else { pixels };
    let mut out = Vec::with_capacity(rgb.len() / 6);
    JpegEncoder::new(&mut out, QUALITY)
        .encode(&rgb, width as u16, height as u16, ColorType::Rgb)
        .map_err(|e| CoreError::Internal(format!("jpeg encode: {e}")))?;
    Ok(out)
}

struct Request {
    path: PathBuf,
    side: u32,
    reply: Sender<CoreResult<Vec<u8>>>,
}

/// Two decode threads and a queue; lives as long as the app.
pub struct ThumbService {
    jobs: Mutex<Option<Sender<Request>>>,
    workers: Mutex<Vec<thread::JoinHandle<()>>>,
}

impl ThumbService {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<Request>();
        let rx: Arc<Mutex<Receiver<Request>>> = Arc::new(Mutex::new(rx));
        let workers = (0..WORKERS)
            .map(|i| {
                let rx = Arc::clone(&rx);
                thread::Builder::new()
                    .name(format!("dokuwu-thumb-{i}"))
                    .spawn(move || loop {
                        let next = rx.lock().unwrap_or_else(|e| e.into_inner()).recv();
                        let Ok(request) = next else { return };
                        let result = thumbnail_jpeg(&request.path, request.side);
                        let _ = request.reply.send(result);
                    })
                    .expect("cannot start thumbnail thread")
            })
            .collect();
        Self { jobs: Mutex::new(Some(tx)), workers: Mutex::new(workers) }
    }

    /// Makes one thumbnail and waits for it. Call from a blocking thread.
    pub fn thumbnail(&self, path: &Path, max_side: u32) -> CoreResult<Vec<u8>> {
        let (reply, answer) = mpsc::channel();
        {
            let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
            let sender = jobs.as_ref().ok_or_else(|| CoreError::Internal("the thumbnail service has stopped".into()))?;
            sender
                .send(Request { path: path.to_path_buf(), side: max_side, reply })
                .map_err(|_| CoreError::Internal("the thumbnail service has stopped".into()))?;
        }
        answer.recv().map_err(|_| CoreError::Internal("the thumbnail thread stopped before answering".into()))?
    }

    pub fn shutdown(&self) {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner()).take();
        let handles: Vec<_> = self.workers.lock().unwrap_or_else(|e| e.into_inner()).drain(..).collect();
        for handle in handles {
            let _ = handle.join();
        }
    }
}

impl Default for ThumbService {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ThumbService {
    fn drop(&mut self) {
        self.shutdown();
    }
}
