//! Tauri commands for PDF to image and image to PDF
//! (`dokuwu_core::ops::pdf_to_image`, `dokuwu_core::ops::image_to_pdf`).
//!
//! Results go to the Downloads folder under a free name (" (1)", " (2)", ...
//! are added instead of overwriting).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dokuwu_core::job::{JobContext, JobId, JobRunner};
use dokuwu_core::ops::image_thumb::ThumbService;
use dokuwu_core::ops::image_to_pdf::{images_to_pdf, ImageInput, ImageToPdfOptions, ImageToPdfReport};
use dokuwu_core::ops::pdf_to_image::{pdf_to_images, ImageFormat, PdfToImageOptions, PdfToImageReport};
use dokuwu_core::{CoreError, CoreResult};
use serde::Deserialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::core_bridge::{start_job, CoreState};

/// App-wide thumbnail threads, managed as Tauri state.
#[derive(Default)]
pub struct ThumbState {
    pub service: Arc<ThumbService>,
}

/// JPEG thumbnail of a picture file (any format the converter accepts), turned
/// the way a photo viewer shows it. The bytes travel as a raw IPC response.
#[tauri::command]
pub async fn core_image_thumbnail(state: State<'_, ThumbState>, path: String, size: u32) -> Result<Response, CoreError> {
    if path.trim().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    let service = Arc::clone(&state.service);
    let bytes = tauri::async_runtime::spawn_blocking(move || service.thumbnail(Path::new(&path), size))
        .await
        .map_err(|e| CoreError::Internal(format!("thumbnail stopped: {e}")))??;
    Ok(Response::new(bytes))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfToImageArgs {
    pub format: ImageFormat,
    pub dpi: u32,
    #[serde(default)]
    pub page_ranges: String,
    #[serde(default)]
    pub output_name: Option<String>,
}

fn downloads<R: Runtime>(app: &AppHandle<R>) -> CoreResult<PathBuf> {
    app.path()
        .download_dir()
        .map_err(|e| CoreError::Internal(format!("cannot find the Downloads folder: {e}")))
}

/// Renders the chosen pages of a PDF to PNG, JPEG or WEBP: one file for one
/// page, a ZIP for several.
#[tauri::command]
pub fn core_pdf_to_image_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CoreState>,
    input_path: String,
    options: PdfToImageArgs,
) -> Result<JobId, CoreError> {
    let dir = downloads(&app)?;
    start_pdf_to_image(&app, &state.runner, PathBuf::from(input_path), options, dir)
}

pub(crate) fn start_pdf_to_image<R: Runtime>(
    app: &AppHandle<R>,
    runner: &JobRunner,
    input: PathBuf,
    args: PdfToImageArgs,
    dir: PathBuf,
) -> CoreResult<JobId> {
    if input.as_os_str().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    start_job(app, runner, "pdf_to_image", move |ctx: &JobContext| -> CoreResult<PdfToImageReport> {
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
        let options = PdfToImageOptions {
            format: args.format,
            dpi: args.dpi,
            page_ranges: args.page_ranges,
            output_dir: dir,
            output_name: args.output_name,
        };
        pdf_to_images(&input, &options, ctx)
    })
}

/// Builds one PDF from the images, in the order given, each with its own
/// rotation and mirroring.
#[tauri::command]
pub fn core_image_to_pdf_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CoreState>,
    images: Vec<ImageInput>,
    page_size: String,
    output_name: Option<String>,
) -> Result<JobId, CoreError> {
    let dir = downloads(&app)?;
    start_image_to_pdf(&app, &state.runner, images, page_size, output_name, dir)
}

pub(crate) fn start_image_to_pdf<R: Runtime>(
    app: &AppHandle<R>,
    runner: &JobRunner,
    images: Vec<ImageInput>,
    page_size: String,
    output_name: Option<String>,
    dir: PathBuf,
) -> CoreResult<JobId> {
    if images.is_empty() {
        return Err(CoreError::InvalidInput("no images provided".into()));
    }
    start_job(app, runner, "image_to_pdf", move |ctx: &JobContext| -> CoreResult<ImageToPdfReport> {
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
        let options = ImageToPdfOptions { page_size, output_dir: dir, output_name };
        images_to_pdf(&images, &options, ctx)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_bridge::{FINISHED_EVENT, PROGRESS_EVENT};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;

    /// Runs a job through the real event path and returns (progress, finished).
    fn run<F>(kind: &str, start: F) -> (Vec<serde_json::Value>, serde_json::Value)
    where
        F: FnOnce(&AppHandle<tauri::test::MockRuntime>, &JobRunner) -> CoreResult<JobId>,
    {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let (tx, rx) = mpsc::channel::<(bool, serde_json::Value)>();
        let progress_tx = tx.clone();
        handle.listen_any(PROGRESS_EVENT, move |e| {
            let _ = progress_tx.send((false, serde_json::from_str(e.payload()).unwrap()));
        });
        handle.listen_any(FINISHED_EVENT, move |e| {
            let _ = tx.send((true, serde_json::from_str(e.payload()).unwrap()));
        });
        let runner = JobRunner::new();
        let id = start(&handle, &runner).unwrap();
        let mut progress = Vec::new();
        loop {
            let (finished, payload) = rx.recv_timeout(Duration::from_secs(60)).expect("event");
            assert_eq!(payload["jobId"], id);
            assert_eq!(payload["kind"], kind);
            if finished {
                return (progress, payload);
            }
            progress.push(payload);
        }
    }

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../native/dokuwu-core/tests/fixtures/pdf-compress")
            .join(name)
    }

    fn png_args(ranges: &str) -> PdfToImageArgs {
        serde_json::from_value(serde_json::json!({ "format": "png", "dpi": 72, "pageRanges": ranges })).unwrap()
    }

    #[test]
    fn pdf_to_image_reports_pages_and_writes_a_zip() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().to_path_buf();
        let (progress, done) = run("pdf_to_image", |app, runner| {
            start_pdf_to_image(app, runner, fixture("shared.pdf"), png_args(""), out)
        });
        assert!(progress.iter().any(|p| p["stage"] == "pages"));
        assert_eq!(done["status"], "succeeded");
        let report = &done["result"];
        assert_eq!(report["pages"], 3);
        assert_eq!(report["isZip"], true);
        assert_eq!(report["format"], "png");
        assert_eq!(report["outputPath"], dir.path().join("shared.zip").to_str().unwrap());
        assert!(dir.path().join("shared.zip").is_file());
    }

    #[test]
    fn thumbnails_come_back_as_jpeg_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        image::RgbImage::from_pixel(80, 40, image::Rgb([0, 0, 200])).save(&path).unwrap();
        let service = Arc::new(ThumbService::new());
        let bytes = service.thumbnail(&path, 20).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
        let empty = tauri::async_runtime::block_on(async {
            let app = tauri::test::mock_app();
            app.manage(ThumbState::default());
            core_image_thumbnail(app.state::<ThumbState>(), String::new(), 20).await
        });
        assert_eq!(empty.err().map(|e| e.code()), Some("invalid_input"));
    }

    #[test]
    fn jpg_is_accepted_as_a_format_name() {
        let args: PdfToImageArgs = serde_json::from_value(serde_json::json!({ "format": "jpg", "dpi": 150 })).unwrap();
        assert_eq!(args.format, ImageFormat::Jpeg);
        assert!(serde_json::from_value::<PdfToImageArgs>(serde_json::json!({ "format": "gif", "dpi": 150 })).is_err());
    }

    #[test]
    fn pdf_to_image_errors_keep_their_codes() {
        let dir = tempfile::tempdir().unwrap();
        let (_, locked) = run("pdf_to_image", |app, runner| {
            start_pdf_to_image(app, runner, fixture("encrypted.pdf"), png_args(""), dir.path().to_path_buf())
        });
        assert_eq!(locked["error"]["code"], "password_required");
        let (_, bad) = run("pdf_to_image", |app, runner| {
            start_pdf_to_image(app, runner, fixture("shared.pdf"), png_args("99"), dir.path().to_path_buf())
        });
        assert_eq!(bad["error"]["code"], "invalid_input");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn image_to_pdf_builds_a_pdf_and_skips_a_bad_image() {
        let dir = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let good = src.path().join("a.png");
        image::RgbImage::from_pixel(30, 20, image::Rgb([200, 10, 10])).save(&good).unwrap();
        let bad = src.path().join("b.jpg");
        std::fs::write(&bad, b"nope").unwrap();
        let inputs: Vec<ImageInput> = serde_json::from_value(serde_json::json!([
            { "path": good, "rotation": 90, "flipH": true },
            { "path": bad },
        ]))
        .unwrap();
        let out = dir.path().to_path_buf();
        let (progress, done) = run("image_to_pdf", |app, runner| {
            start_image_to_pdf(app, runner, inputs, "a4".into(), Some("Scan".into()), out)
        });
        assert!(progress.iter().any(|p| p["stage"] == "images"));
        assert_eq!(done["status"], "succeeded");
        let report = &done["result"];
        assert_eq!(report["pages"], 1);
        assert_eq!(report["skipped"].as_array().unwrap().len(), 1);
        assert_eq!(report["skipped"][0]["error"]["code"], "unsupported");
        assert_eq!(report["outputPath"], dir.path().join("Scan.pdf").to_str().unwrap());
    }

    #[test]
    fn empty_requests_are_refused_before_a_job_starts() {
        let app = tauri::test::mock_app();
        let runner = JobRunner::new();
        let err = start_image_to_pdf(app.handle(), &runner, vec![], "a4".into(), None, std::env::temp_dir()).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        let err = start_pdf_to_image(app.handle(), &runner, PathBuf::new(), png_args(""), std::env::temp_dir()).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
    }
}
