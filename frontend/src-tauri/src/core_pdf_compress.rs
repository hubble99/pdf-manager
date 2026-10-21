//! Tauri commands for Compress PDF (`dokuwu_core::ops::pdf_compress`).

use std::path::{Path, PathBuf};

use dokuwu_core::job::{JobContext, JobId, JobRunner};
use dokuwu_core::ops::pdf_compress::{
    compress_pdf, probe_pdf, unique_output_path, CompressOptions, PdfCompressReport, PdfProbe,
};
use dokuwu_core::{CoreError, CoreResult};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::core_bridge::{start_job, CoreState};

/// Size, page count and protection of a PDF, so the page can show the file's
/// size and refuse a protected file before the user presses Compress. Runs on
/// a blocking thread: opening a damaged PDF can take a moment.
#[tauri::command]
pub async fn core_pdf_probe(path: String) -> Result<PdfProbe, CoreError> {
    if path.trim().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    tauri::async_runtime::spawn_blocking(move || probe_pdf(Path::new(&path)))
        .await
        .map_err(|e| CoreError::Internal(format!("probe stopped: {e}")))?
}

/// Compress a PDF. The result goes to the Downloads folder, named `output_name`
/// (or the PDF's name) plus `.pdf`, with " (1)", " (2)", ... added instead of
/// overwriting an existing file. `quality` is the JPEG quality for pictures.
#[tauri::command]
pub fn core_pdf_compress_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CoreState>,
    input_path: String,
    quality: u8,
    output_name: Option<String>,
) -> Result<JobId, CoreError> {
    if input_path.trim().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| CoreError::Internal(format!("cannot find the Downloads folder: {e}")))?;
    start_compress(&app, &state.runner, PathBuf::from(input_path), quality, output_name, dir)
}

pub(crate) fn start_compress<R: Runtime>(
    app: &AppHandle<R>,
    runner: &JobRunner,
    input: PathBuf,
    quality: u8,
    output_name: Option<String>,
    dir: PathBuf,
) -> CoreResult<JobId> {
    let stem = output_name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .or_else(|| input.file_stem().map(|s| format!("compressed_{}", s.to_string_lossy())))
        .unwrap_or_else(|| "compressed".into());
    start_job(app, runner, "pdf_compress", move |ctx: &JobContext| -> CoreResult<PdfCompressReport> {
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
        let output = unique_output_path(&dir, &stem);
        compress_pdf(&input, &output, &CompressOptions::new(quality), ctx)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_bridge::{FINISHED_EVENT, PROGRESS_EVENT};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../native/dokuwu-core/tests/fixtures/pdf-compress")
            .join(name)
    }

    fn run_job(input: PathBuf, quality: u8, name: Option<String>, dir: PathBuf) -> (Vec<serde_json::Value>, serde_json::Value) {
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
        let id = start_compress(&handle, &runner, input, quality, name, dir).unwrap();
        let mut progress = Vec::new();
        loop {
            let (finished, payload) = rx.recv_timeout(Duration::from_secs(60)).expect("event");
            assert_eq!(payload["jobId"], id);
            assert_eq!(payload["kind"], "pdf_compress");
            if finished {
                return (progress, payload);
            }
            progress.push(payload);
        }
    }

    #[test]
    fn compress_job_reports_progress_and_the_report() {
        let dir = tempfile::tempdir().unwrap();
        let (progress, done) = run_job(fixture("many.pdf"), 60, Some("small".into()), dir.path().to_path_buf());
        assert!(progress.iter().any(|p| p["stage"] == "images"));
        assert_eq!(done["status"], "succeeded");
        let report = &done["result"];
        assert_eq!(report["imagesRecompressed"], 6);
        assert_eq!(report["keptOriginal"], false);
        assert_eq!(report["outputPath"], dir.path().join("small.pdf").to_str().unwrap());
        assert!(dir.path().join("small.pdf").is_file());
    }

    #[test]
    fn the_default_name_adds_a_prefix_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let (_, first) = run_job(fixture("photo.pdf"), 60, None, dir.path().to_path_buf());
        let (_, second) = run_job(fixture("photo.pdf"), 60, None, dir.path().to_path_buf());
        assert_eq!(first["result"]["outputPath"], dir.path().join("compressed_photo.pdf").to_str().unwrap());
        assert_eq!(second["result"]["outputPath"], dir.path().join("compressed_photo (1).pdf").to_str().unwrap());
    }

    #[test]
    fn a_protected_pdf_fails_with_password_required() {
        let dir = tempfile::tempdir().unwrap();
        let (_, done) = run_job(fixture("encrypted.pdf"), 60, None, dir.path().to_path_buf());
        assert_eq!(done["status"], "failed");
        assert_eq!(done["error"]["code"], "password_required");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_missing_file_fails_with_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let (_, done) = run_job(fixture("nope.pdf"), 60, None, dir.path().to_path_buf());
        assert_eq!(done["error"]["code"], "not_found");
    }

    #[test]
    fn the_probe_reads_size_and_protection() {
        let ok = tauri::async_runtime::block_on(core_pdf_probe(fixture("shared.pdf").to_string_lossy().into_owned())).unwrap();
        assert_eq!(ok.pages, 3);
        assert!(!ok.encrypted);
        let locked = tauri::async_runtime::block_on(core_pdf_probe(fixture("encrypted.pdf").to_string_lossy().into_owned())).unwrap();
        assert!(locked.encrypted);
        assert!(tauri::async_runtime::block_on(core_pdf_probe(String::new())).is_err());
    }
}
