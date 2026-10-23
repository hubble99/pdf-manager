//! Tauri commands for the Canvas editor's pages and font library
//! (`dokuwu_core::ops::pdf_render` and `dokuwu_core::ops::font_library`).
//!
//! The editor names a PDF by its path. It asks once for the size of every page
//! (`core_canvas_pages_meta`, nothing is rendered) and then for page images one
//! at a time, at the dpi the zoom needs (`core_canvas_render_page`, one raw
//! binary reply). Fonts the user adds live in the app's data folder.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dokuwu_core::ops::font_library::{default_dir, FontInfo, FontLibrary};
use dokuwu_core::ops::pdf_render::{pages_meta, PagesMeta, RenderedPage};
use dokuwu_core::{CoreError, CoreResult};
use tauri::ipc::Response;
use tauri::State;

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

/// The bytes of a PDF the editor has open. Only for saving through the old
/// backend, which still takes an upload; goes away with it.
#[tauri::command]
pub async fn core_canvas_read_pdf(path: String) -> Result<Response, CoreError> {
    check_path(&path)?;
    let bytes = blocking(move || std::fs::read(&path).map_err(|e| CoreError::io(&path, e))).await?;
    Ok(Response::new(bytes))
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

    #[test]
    fn the_pdf_read_command_gives_the_file_bytes() {
        let path = pdf("tiny.pdf");
        assert!(tauri::async_runtime::block_on(core_canvas_read_pdf(path.to_string_lossy().into_owned())).is_ok());
        let err = tauri::async_runtime::block_on(core_canvas_read_pdf("nope.pdf".into())).err().unwrap();
        assert_eq!(err.code(), "not_found");
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
                core_canvas_read_pdf,
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

        let bytes = get_ipc_response(
            &window,
            request("core_canvas_read_pdf", serde_json::json!({ "path": root.join("pdf-compress/tiny.pdf") })),
        )
        .expect("read pdf")
        .deserialize::<Vec<u8>>()
        .expect("raw bytes");
        assert_eq!(&bytes[..5], b"%PDF-");

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
