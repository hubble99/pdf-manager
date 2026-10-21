//! Tauri commands for the native core (`native/dokuwu-core`).
//!
//! A long operation is started with a `core_*_start` command, which returns a
//! job id at once. Progress and the result arrive as window events:
//!
//! - `core://job-progress`: `{ jobId, kind, stage, done, total }`
//! - `core://job-finished`: `{ jobId, kind, status, result?, error? }` where
//!   `status` is `succeeded`, `failed` or `cancelled`.
//!
//! `core_job_cancel` asks a running job to stop. A new feature adds one start
//! command that calls [`start_job`] with its operation.

use std::path::PathBuf;
use std::sync::Arc;

use dokuwu_core::job::{JobContext, JobId, JobOutcome, JobRunner, Progress, ProgressSink};
use dokuwu_core::ops::checksum::{sha256_file, FileDigest};
use dokuwu_core::ops::pdf_to_word::{convert_pdf_to_docx, unique_output_path, PdfToWordReport};
use dokuwu_core::{CoreError, CoreInfo, CoreResult};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

pub const PROGRESS_EVENT: &str = "core://job-progress";
pub const FINISHED_EVENT: &str = "core://job-finished";

/// App-wide job registry, managed as Tauri state.
#[derive(Default)]
pub struct CoreState {
    pub runner: JobRunner,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    job_id: JobId,
    kind: &'static str,
    #[serde(flatten)]
    progress: &'a Progress,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishedEvent<T: Serialize> {
    job_id: JobId,
    kind: &'static str,
    #[serde(flatten)]
    outcome: JobOutcome<T>,
}

/// Runs `work` as a background job and forwards its progress and outcome to
/// the frontend as events.
pub fn start_job<R, T, F>(
    app: &AppHandle<R>,
    runner: &JobRunner,
    kind: &'static str,
    work: F,
) -> CoreResult<JobId>
where
    R: Runtime,
    T: Serialize + Send + 'static,
    F: FnOnce(&JobContext) -> CoreResult<T> + Send + 'static,
{
    let progress_app = app.clone();
    let sink: ProgressSink = Arc::new(move |job_id, progress| {
        let _ = progress_app.emit(PROGRESS_EVENT, ProgressEvent { job_id, kind, progress });
    });
    let done_app = app.clone();
    runner.spawn(kind, Some(sink), work, move |job_id, outcome| {
        if let JobOutcome::Failed { error } = &outcome {
            log::warn!("core job {kind} #{job_id} failed: {error}");
        }
        // `emit` needs a Clone payload; the outcome owns the result, so
        // serialize it once here.
        match serde_json::to_value(FinishedEvent { job_id, kind, outcome }) {
            Ok(payload) => {
                let _ = done_app.emit(FINISHED_EVENT, payload);
            }
            Err(err) => log::error!("core job {kind} #{job_id}: cannot serialize outcome: {err}"),
        }
    })
}

#[tauri::command]
pub fn core_info() -> CoreInfo {
    dokuwu_core::core_info()
}

/// SHA-256 of a file on disk. The first core command, used to verify the
/// command, progress, cancel and result wiring end to end.
#[tauri::command]
pub fn core_checksum_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CoreState>,
    path: String,
) -> Result<JobId, CoreError> {
    let path = PathBuf::from(path);
    if path.as_os_str().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    start_job(&app, &state.runner, "checksum", move |ctx| -> CoreResult<FileDigest> {
        sha256_file(&path, ctx)
    })
}

/// PDF to Word. The .docx goes to the Downloads folder, like the other tools'
/// output, named `output_name` (or the PDF's name) plus `.docx`, with
/// " (1)", " (2)", ... added instead of overwriting an existing file.
#[tauri::command]
pub fn core_pdf_to_word_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CoreState>,
    input_path: String,
    output_name: Option<String>,
) -> Result<JobId, CoreError> {
    let input = PathBuf::from(&input_path);
    if input_path.trim().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| CoreError::Internal(format!("cannot find the Downloads folder: {e}")))?;
    let stem = output_name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .or_else(|| input.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "document".into());
    start_job(&app, &state.runner, "pdf_to_word", move |ctx| -> CoreResult<PdfToWordReport> {
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
        let output = unique_output_path(&dir, &stem);
        convert_pdf_to_docx(&input, &output, ctx)
    })
}

/// Returns false when the job already finished or never existed.
#[tauri::command]
pub fn core_job_cancel(state: State<'_, CoreState>, job_id: JobId) -> bool {
    state.runner.cancel(job_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;

    #[test]
    fn checksum_job_emits_progress_and_finished_events() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        let (tx, rx) = mpsc::channel::<serde_json::Value>();
        let progress_tx = tx.clone();
        handle.listen_any(PROGRESS_EVENT, move |e| {
            let _ = progress_tx.send(serde_json::json!({"event": "progress", "payload": serde_json::from_str::<serde_json::Value>(e.payload()).unwrap()}));
        });
        handle.listen_any(FINISHED_EVENT, move |e| {
            let _ = tx.send(serde_json::json!({"event": "finished", "payload": serde_json::from_str::<serde_json::Value>(e.payload()).unwrap()}));
        });

        let file_path = temp_file(b"abc");
        let runner = JobRunner::new();
        let path = file_path.clone();
        let id = start_job(&handle, &runner, "checksum", move |ctx| sha256_file(&path, ctx)).unwrap();

        let mut saw_progress = false;
        loop {
            let msg = rx.recv_timeout(Duration::from_secs(10)).expect("event");
            assert_eq!(msg["payload"]["jobId"], id);
            assert_eq!(msg["payload"]["kind"], "checksum");
            if msg["event"] == "progress" {
                saw_progress = true;
                assert_eq!(msg["payload"]["stage"], "hashing");
                continue;
            }
            assert_eq!(msg["payload"]["status"], "succeeded");
            assert_eq!(
                msg["payload"]["result"]["sha256"],
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            );
            break;
        }
        assert!(saw_progress);
        let _ = std::fs::remove_file(&file_path);
    }

    #[test]
    fn missing_file_finishes_with_not_found() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let (tx, rx) = mpsc::channel::<serde_json::Value>();
        handle.listen_any(FINISHED_EVENT, move |e| {
            let _ = tx.send(serde_json::from_str(e.payload()).unwrap());
        });
        let runner = JobRunner::new();
        start_job(&handle, &runner, "checksum", |ctx| {
            sha256_file(std::path::Path::new("definitely/missing/file.pdf"), ctx)
        })
        .unwrap();
        let payload = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(payload["status"], "failed");
        assert_eq!(payload["error"]["code"], "not_found");
    }

    fn temp_file(bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir()
            .join(format!("dokuwu-core-bridge-{}.bin", uuid::Uuid::new_v4().simple()));
        std::fs::File::create(&path).unwrap().write_all(bytes).unwrap();
        path
    }
}
