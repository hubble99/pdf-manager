//! Tauri commands for page previews and PDF facts (`dokuwu_core::ops::pdf_render`).
//!
//! These are short calls made many times (one per thumbnail), so they are plain
//! commands, not jobs. The render threads live in [`RenderState`] for the whole
//! run of the app.

use std::path::Path;
use std::sync::Arc;

use dokuwu_core::ops::pdf_render::{pdf_info, PdfInfo, QualityHint, RenderService};
use dokuwu_core::{CoreError, CoreResult};
use tauri::ipc::Response;
use tauri::State;

/// App-wide render threads, managed as Tauri state.
#[derive(Default)]
pub struct RenderState {
    pub service: Arc<RenderService>,
}

fn check_path(path: &str) -> CoreResult<()> {
    if path.trim().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    Ok(())
}

/// Page count, size, protection and metadata of a PDF.
#[tauri::command]
pub async fn core_pdf_info(path: String) -> Result<PdfInfo, CoreError> {
    check_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || pdf_info(Path::new(&path)))
        .await
        .map_err(|e| CoreError::Internal(format!("info stopped: {e}")))?
}

/// The PNG bytes of one page (1-based). `quality_hint` is `low`, `auto` or
/// `high`; anything else means `auto`. The bytes travel as a raw IPC response,
/// not as JSON.
#[tauri::command]
pub async fn core_pdf_render_page(
    state: State<'_, RenderState>,
    path: String,
    page: u32,
    dpi: u32,
    quality_hint: Option<String>,
) -> Result<Response, CoreError> {
    check_path(&path)?;
    let hint = QualityHint::parse(quality_hint.as_deref().unwrap_or("auto"));
    let service = Arc::clone(&state.service);
    let png = tauri::async_runtime::spawn_blocking(move || render_png(&service, Path::new(&path), page, dpi, hint))
        .await
        .map_err(|e| CoreError::Internal(format!("render stopped: {e}")))??;
    Ok(Response::new(png))
}

pub(crate) fn render_png(service: &RenderService, path: &Path, page: u32, dpi: u32, hint: QualityHint) -> CoreResult<Vec<u8>> {
    Ok(service.render(path, page, dpi, hint)?.png)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../native/dokuwu-core/tests/fixtures/pdf-compress")
            .join(name)
    }

    #[test]
    fn info_command_reads_a_pdf() {
        let info = tauri::async_runtime::block_on(core_pdf_info(fixture("photo.pdf").to_string_lossy().into_owned())).unwrap();
        assert!(info.pages >= 1);
        assert!(!info.encrypted);
    }

    #[test]
    fn info_command_rejects_an_empty_path() {
        let err = tauri::async_runtime::block_on(core_pdf_info("  ".into())).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
    }

    #[test]
    fn render_gives_a_png_and_keeps_error_codes() {
        let service = RenderService::new();
        let png = render_png(&service, &fixture("photo.pdf"), 1, 72, QualityHint::Low).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let err = render_png(&service, &fixture("encrypted.pdf"), 1, 72, QualityHint::Low).unwrap_err();
        assert_eq!(err.code(), "password_required");
        let err = render_png(&service, &fixture("photo.pdf"), 99, 72, QualityHint::Low).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
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
    fn the_page_command_answers_with_raw_png_bytes() {
        let app = mock_builder()
            .manage(RenderState::default())
            .invoke_handler(tauri::generate_handler![core_pdf_render_page])
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../native/dokuwu-core/tests/fixtures/pdf-compress/photo.pdf");
        let reply = get_ipc_response(
            &window,
            request(
                "core_pdf_render_page",
                serde_json::json!({ "path": path, "page": 1, "dpi": 72, "qualityHint": "low" }),
            ),
        )
        .expect("the command succeeds");
        let bytes = reply.deserialize::<Vec<u8>>().expect("raw bytes");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");

        let failure = get_ipc_response(
            &window,
            request("core_pdf_render_page", serde_json::json!({ "path": "nope.pdf", "page": 1, "dpi": 72 })),
        )
        .expect_err("a missing file fails");
        assert_eq!(failure["code"], "not_found");
    }
}
