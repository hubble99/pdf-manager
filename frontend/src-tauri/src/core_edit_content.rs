//! Tauri commands for Edit Content (`dokuwu_core::ops::edit_content`).
//!
//! The document is opened by path (`core_edit_content_open`); every other
//! request is one command envelope (`core_edit_content_command`), exactly the
//! envelope the frontend always sent. The saved PDF is copied to the Downloads
//! folder by `core_edit_content_export`. A failure that has no reply of its own
//! is `{ code, message }`, with the stable codes of the old HTTP surface.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dokuwu_core::ops::edit_content::{EditContentHost, HostConfig, HostError};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};

/// The one Edit Content host, managed as Tauri state.
pub struct EditContentState {
    pub host: Arc<EditContentHost>,
}

impl EditContentState {
    pub fn new(config: HostConfig) -> Self {
        Self { host: Arc::new(EditContentHost::new(config)) }
    }

    /// The host of a running app. A packaged app finds its worker and PDFium
    /// in the `edit-content` resource folder; a development build uses the
    /// engine built inside the repository.
    pub fn for_app<R: Runtime>(app: &AppHandle<R>) -> Self {
        let resource_root = if cfg!(debug_assertions) {
            None
        } else {
            app.path().resource_dir().ok().map(|dir| dir.join("edit-content"))
        };
        let dev_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
        Self::new(HostConfig::resolve(resource_root, &dev_root, &app.package_info().version.to_string()))
    }

    /// Cancels active requests and closes every worker, at app exit.
    pub fn shutdown(&self) {
        match self.host.shutdown() {
            Ok(closed) => log::info!("edit-content closed {closed} session(s) at exit"),
            Err(error) => log::warn!("edit-content shutdown: {error}"),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedPdf {
    pub path: String,
    pub file_name: String,
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, HostError> + Send + 'static) -> Result<T, HostError> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| HostError {
        code: "INTERNAL".into(),
        message: format!("Edit Content task stopped: {e}"),
    })?
}

/// Opens a PDF and returns the reply: session state and the discovered objects.
#[tauri::command]
pub async fn core_edit_content_open(state: State<'_, EditContentState>, path: String) -> Result<Value, HostError> {
    let host = Arc::clone(&state.host);
    blocking(move || host.open(Path::new(&path))).await
}

/// One command envelope (`inspect`, `render`, `apply`, `history`, `save`, `close`).
#[tauri::command]
pub async fn core_edit_content_command(
    state: State<'_, EditContentState>,
    session_id: String,
    envelope: Value,
) -> Result<Value, HostError> {
    let host = Arc::clone(&state.host);
    blocking(move || host.command(&session_id, envelope)).await
}

/// Asks a running request to stop at its next checkpoint.
#[tauri::command]
pub async fn core_edit_content_cancel(
    state: State<'_, EditContentState>,
    session_id: String,
    request_id: String,
) -> Result<Value, HostError> {
    let host = Arc::clone(&state.host);
    blocking(move || host.cancel(&session_id, &request_id)).await
}

/// Copies a saved output to the Downloads folder, named `name` (or after the
/// output) plus `.pdf`, with " (1)", " (2)", ... instead of overwriting.
#[tauri::command]
pub async fn core_edit_content_export<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, EditContentState>,
    session_id: String,
    output_id: String,
    name: Option<String>,
) -> Result<ExportedPdf, HostError> {
    let dir: PathBuf = app.path().download_dir().map_err(|e| HostError {
        code: "EXPORT_FAILED".into(),
        message: format!("Cannot find the Downloads folder: {e}"),
    })?;
    let host = Arc::clone(&state.host);
    blocking(move || {
        let path = host.export(&session_id, &output_id, &dir, name.as_deref())?;
        let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(ExportedPdf { path: path.to_string_lossy().into_owned(), file_name })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(dir: &Path) -> EditContentState {
        EditContentState::new(HostConfig {
            sessions_root: dir.join("sessions"),
            worker_workspace: dir.join("worker"),
            scratch_root: dir.join("scratch"),
            worker_command: vec![dir.join("no-such-worker").to_string_lossy().into_owned()],
            pdfium_library: dir.join("no-such-pdfium"),
            resource_root: None,
            app_version: "test".into(),
        })
    }

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn errors_reach_the_frontend_as_code_and_message() {
        let error = HostError { code: "PDF_UNREADABLE".into(), message: "m".into() };
        assert_eq!(serde_json::to_value(&error).unwrap(), json!({"code": "PDF_UNREADABLE", "message": "m"}));
    }

    #[test]
    fn commands_refuse_bad_input_before_any_worker_starts() {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(state(dir.path()));
        let state = app.state::<EditContentState>();

        let text = dir.path().join("notes.txt");
        std::fs::write(&text, b"x").unwrap();
        let error = run(core_edit_content_open(state.clone(), text.to_string_lossy().into_owned())).unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED_FILE");

        let session = "a".repeat(32);
        let bad = json!({"schemaVersion": "wrong"});
        let error = run(core_edit_content_command(state.clone(), session.clone(), bad)).unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");

        let unknown = json!({
            "schemaVersion": "edit-content-request/v1", "requestId": "r1", "sessionId": session,
            "command": "inspect", "expectedAcceptedRevision": 0, "payload": {},
        });
        let reply = run(core_edit_content_command(state.clone(), session.clone(), unknown)).unwrap();
        assert_eq!(reply["status"], "rejected");

        let cancelled = run(core_edit_content_cancel(state.clone(), session.clone(), "r1".into()));
        assert_eq!(cancelled.unwrap_err().code, "SESSION_NOT_FOUND");
        let error = run(core_edit_content_export(app.handle().clone(), state.clone(), session, "out1".into(), None)).unwrap_err();
        assert!(["OUTPUT_NOT_FOUND", "EXPORT_FAILED"].contains(&error.code.as_str()));
    }

    #[test]
    fn an_unusable_engine_is_reported_as_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(state(dir.path()));
        let state = app.state::<EditContentState>();
        let pdf = dir.path().join("doc.pdf");
        std::fs::write(&pdf, b"%PDF-1.4\n%%EOF\n").unwrap();
        let error = run(core_edit_content_open(state.clone(), pdf.to_string_lossy().into_owned())).unwrap_err();
        assert!(error.message.len() > 10, "{error}");
        assert!(!error.code.is_empty());
        // Nothing is left behind by the failed open.
        assert!(!dir.path().join("scratch").read_dir().map(|mut d| d.next().is_some()).unwrap_or(false));
        state.shutdown();
    }
}
