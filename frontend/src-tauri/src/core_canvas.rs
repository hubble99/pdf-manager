//! Tauri commands for the Canvas editor's pages and font library
//! (`dokuwu_core::ops::pdf_render` and `dokuwu_core::ops::font_library`).
//!
//! The editor names a PDF by its path. It asks once for the size of every page
//! (`core_canvas_pages_meta`, nothing is rendered) and then for page images one
//! at a time, at the dpi the zoom needs (`core_canvas_render_page`, one raw
//! binary reply). Fonts the user adds live in the app's data folder.
//!
//! Saving is a job (`core_canvas_save_start`) that stamps the annotations onto
//! the PDF and writes the result to the Downloads folder. The annotations can
//! be hundreds of megabytes of picture data, so the editor first hands them
//! over as one raw message (`core_canvas_stash_annotations`) that lands in a
//! scratch file, and the job reads and deletes that file.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use dokuwu_core::job::{JobContext, JobId, JobRunner};
use dokuwu_core::ops::canvas_save::{save_canvas, SaveOptions, SaveReport};
use dokuwu_core::ops::font_library::{default_dir, FontInfo, FontLibrary};
use dokuwu_core::ops::pdf_render::{pages_meta, PagesMeta, RenderedPage};
use dokuwu_core::{CoreError, CoreResult};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::core_bridge::{start_job, CoreState};
use crate::core_pdf_render::RenderState;

/// The font library of the app, managed as Tauri state.
pub struct FontState {
    pub library: Arc<FontLibrary>,
}

impl Default for FontState {
    fn default() -> Self {
        let dir = default_dir().unwrap_or_else(|| std::env::temp_dir().join("dokuwu-fonts"));
        Self { library: Arc::new(FontLibrary::new(dir)) }
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> CoreResult<T> + Send + 'static) -> Result<T, CoreError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| CoreError::Internal(format!("task stopped: {e}")))?
}

fn check_path(path: &str) -> CoreResult<()> {
    if path.trim().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    Ok(())
}

/// Sizes of all pages as rendered at `dpi` (default 200), without rendering.
#[tauri::command]
pub async fn core_canvas_pages_meta(path: String, dpi: Option<u32>) -> Result<PagesMeta, CoreError> {
    check_path(&path)?;
    blocking(move || pages_meta(Path::new(&path), dpi.unwrap_or(200))).await
}

/// One page (1-based) for the editor at `dpi` (72 to 500, lowered to stay under
/// 60 megapixels). The reply is binary: little endian `width, height, dpi`, then
/// the PNG bytes.
#[tauri::command]
pub async fn core_canvas_render_page(
    state: State<'_, RenderState>,
    path: String,
    page: u32,
    dpi: u32,
) -> Result<Response, CoreError> {
    check_path(&path)?;
    let service = Arc::clone(&state.service);
    let rendered = blocking(move || service.render_editor(Path::new(&path), page, dpi)).await?;
    Ok(Response::new(encode_page(&rendered)))
}

pub(crate) fn encode_page(page: &RenderedPage) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + page.png.len());
    out.extend_from_slice(&page.width.to_le_bytes());
    out.extend_from_slice(&page.height.to_le_bytes());
    out.extend_from_slice(&page.dpi.to_le_bytes());
    out.extend_from_slice(&page.png);
    out
}

const STASH_DIR: &str = "dokuwu-canvas-annotations";
/// A stash file nobody picked up (the app was closed mid-save) is removed after this long.
const STASH_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

fn stash_dir() -> PathBuf {
    std::env::temp_dir().join(STASH_DIR)
}

/// Writes `bytes` to a new scratch file and returns its path.
fn stash(dir: &Path, bytes: &[u8]) -> CoreResult<PathBuf> {
    std::fs::create_dir_all(dir).map_err(|e| CoreError::io(dir, e))?;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age > STASH_MAX_AGE);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let path = dir.join(format!("{}.json", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|e| CoreError::io(&path, e))?;
    Ok(path)
}

/// Keeps a stash path from naming any other file: it must be a `.json` file
/// directly inside `dir`.
fn check_stash(dir: &Path, path: &str) -> CoreResult<PathBuf> {
    check_path(path)?;
    let path = PathBuf::from(path);
    let inside = path.parent() == Some(dir) && path.extension().is_some_and(|e| e == "json");
    if !inside {
        return Err(CoreError::InvalidInput("the annotations were not handed over through the editor".into()));
    }
    Ok(path)
}

/// Takes the annotations of a save as one raw message (a UTF-8 JSON array, one
/// entry per page), keeps them in a scratch file and gives back its path.
#[tauri::command]
pub async fn core_canvas_stash_annotations(request: Request<'_>) -> Result<String, CoreError> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err(CoreError::InvalidInput("the annotations must be sent as raw bytes".into())),
    };
    let path = blocking(move || stash(&stash_dir(), &bytes)).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// Stamps the stashed annotations onto the PDF at `source` and writes the
/// result to the Downloads folder.
#[tauri::command]
pub fn core_canvas_save_start<R: Runtime>(
    app: AppHandle<R>,
    core: State<'_, CoreState>,
    fonts: State<'_, FontState>,
    source: String,
    annotations_path: String,
    output_name: Option<String>,
) -> Result<JobId, CoreError> {
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| CoreError::Internal(format!("cannot find the Downloads folder: {e}")))?;
    start_save(&app, &core.runner, &fonts.library, &stash_dir(), source, annotations_path, output_name, dir)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn start_save<R: Runtime>(
    app: &AppHandle<R>,
    runner: &JobRunner,
    library: &Arc<FontLibrary>,
    stash_dir: &Path,
    source: String,
    annotations_path: String,
    output_name: Option<String>,
    output_dir: PathBuf,
) -> CoreResult<JobId> {
    check_path(&source)?;
    let annotations = check_stash(stash_dir, &annotations_path)?;
    if !annotations.is_file() {
        return Err(CoreError::NotFound { path: annotations });
    }
    let library = Arc::clone(library);
    start_job(app, runner, "canvas_save", move |ctx: &JobContext| -> CoreResult<SaveReport> {
        let result = (|| {
            std::fs::create_dir_all(&output_dir).map_err(|e| CoreError::io(&output_dir, e))?;
            let options = SaveOptions { output_dir: output_dir.clone(), output_name, fonts: Some(&*library) };
            save_canvas(Path::new(&source), &annotations, &options, ctx)
        })();
        // The scratch file is of no use to anyone after the save, however it ended.
        let _ = std::fs::remove_file(&annotations);
        result
    })
}

/// The fonts in the library.
#[tauri::command]
pub fn core_font_list(state: State<'_, FontState>) -> Vec<FontInfo> {
    state.library.list()
}

/// Adds a `.ttf` or `.otf` file to the library.
#[tauri::command]
pub async fn core_font_add(state: State<'_, FontState>, path: String) -> Result<FontInfo, CoreError> {
    check_path(&path)?;
    let library = Arc::clone(&state.library);
    blocking(move || library.add(Path::new(&path))).await
}

/// Removes a font from the library; false when there was none with that id.
#[tauri::command]
pub async fn core_font_remove(state: State<'_, FontState>, id: String) -> Result<bool, CoreError> {
    let library = Arc::clone(&state.library);
    blocking(move || library.remove(&id)).await
}

/// The file bytes of a font, for the webview's `FontFace`.
#[tauri::command]
pub async fn core_font_read(state: State<'_, FontState>, id: String) -> Result<Response, CoreError> {
    let library = Arc::clone(&state.library);
    let bytes = blocking(move || {
        library
            .read(&id)?
            .ok_or_else(|| CoreError::NotFound { path: PathBuf::from(format!("font {id}")) })
    })
    .await?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pdf(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../native/dokuwu-core/tests/fixtures/pdf-compress")
            .join(name)
    }

    fn font(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../native/dokuwu-core/tests/fixtures/fonts")
            .join(name)
    }

    #[test]
    fn page_frames_carry_the_size_and_the_png() {
        let service = dokuwu_core::ops::pdf_render::RenderService::new();
        let page = service.render_editor(&pdf("photo.pdf"), 1, 100).unwrap();
        let frame = encode_page(&page);
        let word = |i: usize| u32::from_le_bytes(frame[i * 4..i * 4 + 4].try_into().unwrap());
        assert_eq!((word(0), word(1), word(2)), (page.width, page.height, page.dpi));
        assert_eq!(&frame[12..20], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn pages_meta_command_lists_pages_and_keeps_error_codes() {
        let meta = tauri::async_runtime::block_on(core_canvas_pages_meta(pdf("many.pdf").to_string_lossy().into_owned(), None))
            .unwrap();
        assert_eq!(meta.total as usize, meta.pages.len());
        assert!(meta.total > 1);
        let err = tauri::async_runtime::block_on(core_canvas_pages_meta(pdf("encrypted.pdf").to_string_lossy().into_owned(), None))
            .unwrap_err();
        assert_eq!(err.code(), "password_required");
        let err = tauri::async_runtime::block_on(core_canvas_pages_meta("  ".into(), None)).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        let err = tauri::async_runtime::block_on(core_canvas_pages_meta("nope.pdf".into(), None)).unwrap_err();
        assert_eq!(err.code(), "not_found");
    }

    fn save_events(app: &tauri::AppHandle<tauri::test::MockRuntime>) -> std::sync::mpsc::Receiver<(bool, serde_json::Value)> {
        use crate::core_bridge::{FINISHED_EVENT, PROGRESS_EVENT};
        use tauri::Listener;
        let (tx, rx) = std::sync::mpsc::channel::<(bool, serde_json::Value)>();
        let progress_tx = tx.clone();
        app.listen_any(PROGRESS_EVENT, move |e| {
            let _ = progress_tx.send((false, serde_json::from_str(e.payload()).unwrap()));
        });
        app.listen_any(FINISHED_EVENT, move |e| {
            let _ = tx.send((true, serde_json::from_str(e.payload()).unwrap()));
        });
        rx
    }

    fn finish(rx: &std::sync::mpsc::Receiver<(bool, serde_json::Value)>, id: JobId) -> (Vec<String>, serde_json::Value) {
        let mut stages = Vec::new();
        loop {
            let (finished, payload) = rx.recv_timeout(Duration::from_secs(60)).expect("event");
            assert_eq!(payload["jobId"], id);
            assert_eq!(payload["kind"], "canvas_save");
            if finished {
                return (stages, payload);
            }
            stages.push(payload["stage"].as_str().unwrap().to_string());
        }
    }

    #[test]
    fn saving_stamps_the_annotations_writes_the_pdf_and_removes_the_scratch_file() {
        let scratch = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let annotations = serde_json::json!([{
            "canvas_width": 100, "canvas_height": 100,
            "native_objects": [{ "type": "rect", "x": 10, "y": 10, "width": 40, "height": 20, "strokeColor": "#ff0000", "strokeWidth": 2, "fillColor": "#ffff00", "fillOpacity": 100 }],
        }]);
        let stashed = stash(scratch.path(), annotations.to_string().as_bytes()).unwrap();

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let rx = save_events(&handle);
        let fonts = Arc::new(FontLibrary::new(scratch.path().join("fonts")));
        let id = start_save(
            &handle,
            &JobRunner::new(),
            &fonts,
            scratch.path(),
            pdf("tiny.pdf").to_string_lossy().into_owned(),
            stashed.to_string_lossy().into_owned(),
            Some("Hasil".into()),
            out.path().to_path_buf(),
        )
        .unwrap();
        let (stages, done) = finish(&rx, id);
        assert!(stages.iter().any(|s| s == "pages"));
        assert_eq!(done["status"], "succeeded", "{done}");
        assert_eq!(done["result"]["stampedPages"], 1);
        assert_eq!(done["result"]["outputPath"], out.path().join("Hasil.pdf").to_str().unwrap());
        assert!(out.path().join("Hasil.pdf").is_file());
        assert!(!stashed.exists(), "the scratch file is removed");
    }

    #[test]
    fn a_failed_save_reports_the_error_and_still_removes_the_scratch_file() {
        let scratch = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let stashed = stash(scratch.path(), b"{}").unwrap();
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let rx = save_events(&handle);
        let fonts = Arc::new(FontLibrary::new(scratch.path().join("fonts")));
        let id = start_save(
            &handle,
            &JobRunner::new(),
            &fonts,
            scratch.path(),
            pdf("tiny.pdf").to_string_lossy().into_owned(),
            stashed.to_string_lossy().into_owned(),
            None,
            out.path().to_path_buf(),
        )
        .unwrap();
        let (_, done) = finish(&rx, id);
        assert_eq!(done["status"], "failed");
        assert_eq!(done["error"]["code"], "invalid_input");
        assert!(!stashed.exists());
        assert!(std::fs::read_dir(out.path()).unwrap().next().is_none(), "no half-written file");
    }

    #[test]
    fn only_files_handed_over_through_the_editor_can_be_read_as_annotations() {
        let scratch = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        let runner = JobRunner::new();
        let fonts = Arc::new(FontLibrary::new(scratch.path().join("fonts")));
        let start = |source: &str, annotations: &str| {
            start_save(app.handle(), &runner, &fonts, scratch.path(), source.into(), annotations.into(), None, scratch.path().join("out"))
        };
        let tiny = pdf("tiny.pdf").to_string_lossy().into_owned();
        // Another folder, another extension and a path that climbs out are all refused.
        assert_eq!(start(&tiny, &pdf("tiny.pdf").to_string_lossy()).unwrap_err().code(), "invalid_input");
        let outside = tempfile::tempdir().unwrap();
        let elsewhere = stash(outside.path(), b"[]").unwrap();
        assert_eq!(start(&tiny, &elsewhere.to_string_lossy()).unwrap_err().code(), "invalid_input");
        let climbing = scratch.path().join("..").join("x.json");
        assert_eq!(start(&tiny, &climbing.to_string_lossy()).unwrap_err().code(), "invalid_input");
        assert_eq!(start(" ", &elsewhere.to_string_lossy()).unwrap_err().code(), "invalid_input");
        // A missing stash file is reported before a job starts.
        let missing = scratch.path().join("gone.json");
        assert_eq!(start(&tiny, &missing.to_string_lossy()).unwrap_err().code(), "not_found");
        assert_eq!(runner.active_jobs(), 0);
    }

    #[test]
    fn old_scratch_files_are_cleaned_up_when_a_new_one_is_stashed() {
        let scratch = tempfile::tempdir().unwrap();
        let old = stash(scratch.path(), b"[]").unwrap();
        let handle = std::fs::File::options().write(true).open(&old).unwrap();
        handle.set_modified(SystemTime::now() - STASH_MAX_AGE - Duration::from_secs(60)).unwrap();
        drop(handle);
        let fresh = stash(scratch.path(), b"[]").unwrap();
        assert!(!old.exists());
        assert!(fresh.exists());
    }

    #[test]
    fn fonts_can_be_added_listed_read_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let state = FontState { library: Arc::new(FontLibrary::new(dir.path())) };
        let library = Arc::clone(&state.library);
        let added = library.add(&font("RedHatMono-Regular.ttf")).unwrap();
        assert_eq!(library.list().len(), 1);
        assert!(library.read(&added.id).unwrap().is_some());
        assert!(library.remove(&added.id).unwrap());
        assert!(library.list().is_empty());
        assert!(!library.remove(&added.id).unwrap());
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
    fn the_commands_answer_over_ipc() {
        let fonts = tempfile::tempdir().unwrap();
        let app = mock_builder()
            .manage(RenderState::default())
            .manage(FontState { library: Arc::new(FontLibrary::new(fonts.path())) })
            .invoke_handler(tauri::generate_handler![
                core_canvas_pages_meta,
                core_canvas_render_page,
                core_canvas_stash_annotations,
                core_canvas_save_start,
                core_font_list,
                core_font_add,
                core_font_remove,
                core_font_read,
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native/dokuwu-core/tests/fixtures");

        let reply = get_ipc_response(
            &window,
            request("core_canvas_pages_meta", serde_json::json!({ "path": root.join("pdf-compress/many.pdf"), "dpi": 100 })),
        )
        .expect("pages meta");
        let meta: serde_json::Value = reply.deserialize().expect("json");
        assert!(meta["total"].as_u64().unwrap() > 1);
        assert_eq!(meta["pages"][0]["dpi"], 100);

        let reply = get_ipc_response(
            &window,
            request("core_canvas_render_page", serde_json::json!({ "path": root.join("pdf-compress/photo.pdf"), "page": 1, "dpi": 72 })),
        )
        .expect("render");
        let frame = reply.deserialize::<Vec<u8>>().expect("raw bytes");
        assert_eq!(&frame[12..20], b"\x89PNG\r\n\x1a\n");

        // The annotations arrive as one raw message and land in a scratch file.
        let raw_request = InvokeRequest {
            body: InvokeBody::Raw(br#"[""]"#.to_vec()),
            headers: {
                let mut headers = tauri::http::HeaderMap::new();
                headers.insert("Content-Type", "application/octet-stream".parse().unwrap());
                headers
            },
            ..request("core_canvas_stash_annotations", serde_json::json!({}))
        };
        let stashed: String = get_ipc_response(&window, raw_request).expect("stash").deserialize().expect("path");
        assert_eq!(std::fs::read(&stashed).unwrap(), br#"[""]"#);
        std::fs::remove_file(&stashed).unwrap();
        let refused = get_ipc_response(&window, request("core_canvas_stash_annotations", serde_json::json!({ "x": 1 })))
            .expect_err("JSON bodies are refused");
        assert_eq!(refused["code"], "invalid_input");

        let failure = get_ipc_response(
            &window,
            request("core_canvas_render_page", serde_json::json!({ "path": root.join("pdf-compress/encrypted.pdf"), "page": 1, "dpi": 72 })),
        )
        .expect_err("protected");
        assert_eq!(failure["code"], "password_required");

        let added = get_ipc_response(
            &window,
            request("core_font_add", serde_json::json!({ "path": root.join("fonts/RedHatMono-Regular.ttf") })),
        )
        .expect("add font");
        let added: serde_json::Value = added.deserialize().expect("json");
        let id = added["id"].as_str().unwrap().to_string();
        assert_eq!(added["family"], "Red Hat Mono");

        let list = get_ipc_response(&window, request("core_font_list", serde_json::json!({}))).expect("list");
        let list: serde_json::Value = list.deserialize().expect("json");
        assert_eq!(list.as_array().unwrap().len(), 1);

        let bytes = get_ipc_response(&window, request("core_font_read", serde_json::json!({ "id": id })))
            .expect("read font")
            .deserialize::<Vec<u8>>()
            .expect("raw bytes");
        assert_eq!(&bytes[..4], &[0, 1, 0, 0]);

        let missing = get_ipc_response(&window, request("core_font_read", serde_json::json!({ "id": "nope" })))
            .expect_err("unknown font");
        assert_eq!(missing["code"], "not_found");

        let refused = get_ipc_response(
            &window,
            request("core_font_add", serde_json::json!({ "path": root.join("pdf-compress/tiny.pdf") })),
        )
        .expect_err("not a font");
        assert_eq!(refused["code"], "invalid_input");

        let removed = get_ipc_response(&window, request("core_font_remove", serde_json::json!({ "id": id })))
            .expect("remove");
        assert_eq!(removed.deserialize::<bool>().unwrap(), true);
    }
}
