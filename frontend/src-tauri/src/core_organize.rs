//! Tauri commands for the Organize workspace (`dokuwu_core::ops::organize`).
//!
//! The workspace adds a file once (`core_organize_open`) and gets a handle,
//! asks for thumbnails in bounded batches (`core_organize_thumbnails`, one raw
//! binary reply per batch) and saves with a job (`core_organize_assemble_start`)
//! that writes the new PDF to the Downloads folder. Files are read from where
//! the user keeps them; nothing is copied or deleted.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dokuwu_core::job::{JobContext, JobId, JobRunner};
use dokuwu_core::ops::organize::{
    assemble, AssembleOptions, AssembleReport, OrganizeDocument, OrganizeRegistry, PageRef, DEFAULT_BATCH, DEFAULT_WIDTH,
};
use dokuwu_core::{CoreError, CoreResult};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::core_bridge::{start_job, CoreState};
use crate::core_pdf_render::RenderState;

/// The files of the open workspace, managed as Tauri state.
#[derive(Default)]
pub struct OrganizeState {
    pub registry: Arc<OrganizeRegistry>,
}

fn downloads<R: Runtime>(app: &AppHandle<R>) -> CoreResult<PathBuf> {
    app.path()
        .download_dir()
        .map_err(|e| CoreError::Internal(format!("cannot find the Downloads folder: {e}")))
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> CoreResult<T> + Send + 'static) -> Result<T, CoreError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| CoreError::Internal(format!("task stopped: {e}")))?
}

/// Checks a PDF or picture and gives it a handle for the workspace.
#[tauri::command]
pub async fn core_organize_open(state: State<'_, OrganizeState>, path: String) -> Result<OrganizeDocument, CoreError> {
    if path.trim().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    let registry = Arc::clone(&state.registry);
    blocking(move || registry.open(Path::new(&path))).await
}

/// Thumbnails of up to `count` pages from page `start` (1-based), `width`
/// pixels wide. The reply is one binary message (see
/// `ThumbnailBatch::encode`), not JSON.
#[tauri::command]
pub async fn core_organize_thumbnails(
    organize: State<'_, OrganizeState>,
    render: State<'_, RenderState>,
    document_id: String,
    start: Option<u32>,
    count: Option<u32>,
    width: Option<u32>,
) -> Result<Response, CoreError> {
    let registry = Arc::clone(&organize.registry);
    let service = Arc::clone(&render.service);
    let batch = blocking(move || {
        registry.thumbnails(
            &service,
            &document_id,
            start.unwrap_or(1),
            count.unwrap_or(DEFAULT_BATCH),
            width.unwrap_or(DEFAULT_WIDTH),
        )
    })
    .await?;
    Ok(Response::new(batch.encode()))
}

/// Forgets a file of the workspace. The file itself is left alone.
#[tauri::command]
pub fn core_organize_release(state: State<'_, OrganizeState>, document_id: String) -> bool {
    state.registry.release(&document_id)
}

/// Builds one PDF from the list of pages, in the Downloads folder.
#[tauri::command]
pub fn core_organize_assemble_start<R: Runtime>(
    app: AppHandle<R>,
    core: State<'_, CoreState>,
    organize: State<'_, OrganizeState>,
    pages: Vec<PageRef>,
    output_name: Option<String>,
) -> Result<JobId, CoreError> {
    let dir = downloads(&app)?;
    start_assemble(&app, &core.runner, &organize.registry, pages, output_name, dir)
}

pub(crate) fn start_assemble<R: Runtime>(
    app: &AppHandle<R>,
    runner: &JobRunner,
    registry: &OrganizeRegistry,
    pages: Vec<PageRef>,
    output_name: Option<String>,
    dir: PathBuf,
) -> CoreResult<JobId> {
    // Resolved before the job starts, so a missing or changed file is an
    // immediate error and the job holds no registry state.
    let sources = registry.sources_for(&pages)?;
    start_job(app, runner, "organize_assemble", move |ctx: &JobContext| -> CoreResult<AssembleReport> {
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
        let options = AssembleOptions { output_dir: dir, output_name, flush_after_bytes: None };
        assemble(&sources, &pages, &options, ctx)
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
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../native/dokuwu-core/tests/fixtures/pdf-compress")
            .join(name)
    }

    fn page(source: &str, page: u32, rotation: i32, flip: bool) -> PageRef {
        PageRef { source: source.into(), page, rotation, flip }
    }

    #[test]
    fn assembling_reports_progress_and_writes_the_pdf() {
        let out = tempfile::tempdir().unwrap();
        let registry = OrganizeRegistry::new();
        let shared = registry.open(&fixture("shared.pdf")).unwrap();
        let tiny = registry.open(&fixture("tiny.pdf")).unwrap();

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
        let pages = vec![
            page(&tiny.document_id, 1, 90, false),
            page(&shared.document_id, 2, 0, true),
            page(&tiny.document_id, 1, 0, false),
        ];
        let id = start_assemble(&handle, &runner, &registry, pages, Some("Susunan".into()), out.path().to_path_buf()).unwrap();

        let mut stages = Vec::new();
        let done = loop {
            let (finished, payload) = rx.recv_timeout(Duration::from_secs(60)).expect("event");
            assert_eq!(payload["jobId"], id);
            assert_eq!(payload["kind"], "organize_assemble");
            if finished {
                break payload;
            }
            stages.push(payload["stage"].as_str().unwrap().to_string());
        };
        assert!(stages.iter().any(|s| s == "pages"));
        assert_eq!(done["status"], "succeeded");
        assert_eq!(done["result"]["pages"], 3);
        assert_eq!(done["result"]["outputPath"], out.path().join("Susunan.pdf").to_str().unwrap());
        assert!(out.path().join("Susunan.pdf").is_file());
    }

    #[test]
    fn a_bad_list_fails_before_a_job_starts() {
        let app = tauri::test::mock_app();
        let runner = JobRunner::new();
        let registry = OrganizeRegistry::new();
        let err = start_assemble(app.handle(), &runner, &registry, vec![page("nope", 1, 0, false)], None, std::env::temp_dir())
            .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert_eq!(runner.active_jobs(), 0);
    }

    #[test]
    fn open_command_gives_a_handle_and_keeps_error_codes() {
        let state = OrganizeState::default();
        let registry = Arc::clone(&state.registry);
        let doc = registry.open(&fixture("photo.pdf")).unwrap();
        assert_eq!(doc.name, "photo.pdf");
        assert_eq!(registry.open(&fixture("encrypted.pdf")).unwrap_err().code(), "password_required");
        assert!(registry.release(&doc.document_id));
    }
}

#[cfg(test)]
mod ipc_tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::WebviewWindowBuilder;

    fn request(command: &str, body: serde_json::Value) -> InvokeRequest {
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    #[test]
    fn open_and_thumbnails_work_through_the_command_layer() {
        let app = mock_builder()
            .manage(OrganizeState::default())
            .manage(RenderState::default())
            .invoke_handler(tauri::generate_handler![core_organize_open, core_organize_thumbnails, core_organize_release])
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../native/dokuwu-core/tests/fixtures/pdf-compress/many.pdf");

        let opened = get_ipc_response(&window, request("core_organize_open", serde_json::json!({ "path": path })))
            .expect("the file opens")
            .deserialize::<serde_json::Value>()
            .unwrap();
        let id = opened["documentId"].as_str().unwrap().to_string();
        assert_eq!(opened["kind"], "pdf");
        let pages = opened["pageCount"].as_u64().unwrap();
        assert!(pages >= 2);

        let reply = get_ipc_response(
            &window,
            request("core_organize_thumbnails", serde_json::json!({ "documentId": id, "start": 1, "count": 2, "width": 100 })),
        )
        .expect("thumbnails render")
        .deserialize::<Vec<u8>>()
        .expect("raw bytes");
        let word = |i: usize| u32::from_le_bytes(reply[i..i + 4].try_into().unwrap());
        assert_eq!((word(0), word(4) as u64, word(8)), (1, pages, 2));
        assert_eq!(word(12), 1);
        assert_eq!(word(16), 100);
        let length = word(24) as usize;
        assert_eq!(&reply[28..36], b"\x89PNG\r\n\x1a\n");
        assert_eq!(word(28 + length), 2);

        let failure = get_ipc_response(
            &window,
            request("core_organize_thumbnails", serde_json::json!({ "documentId": "nope" })),
        )
        .expect_err("an unknown handle fails");
        assert_eq!(failure["code"], "invalid_input");

        let released = get_ipc_response(&window, request("core_organize_release", serde_json::json!({ "documentId": id })))
            .unwrap()
            .deserialize::<bool>()
            .unwrap();
        assert!(released);
    }
}
