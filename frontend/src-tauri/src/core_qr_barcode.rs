//! Tauri commands for QR codes and barcodes (`dokuwu_core::ops::qr` and
//! `dokuwu_core::ops::barcode`).
//!
//! Generation takes a few milliseconds, so these are plain commands rather than
//! jobs: the image bytes come straight back over IPC (as an `ArrayBuffer` in
//! the webview). They run on the blocking pool so a long text never stalls the
//! UI thread.

use dokuwu_core::ops::{barcode, qr};
use dokuwu_core::{CoreError, CoreResult};
use tauri::ipc::Response;

async fn blocking_image<F>(generate: F) -> Result<Response, CoreError>
where
    F: FnOnce() -> CoreResult<qr::Generated> + Send + 'static,
{
    let image = tauri::async_runtime::spawn_blocking(generate)
        .await
        .map_err(|e| CoreError::Internal(format!("generation stopped: {e}")))??;
    Ok(Response::new(image.bytes))
}

/// A QR code as PNG or SVG bytes. `size` is pixels per module (1 to 20),
/// `error_correction` is L, M, Q or H and `border` the quiet zone in modules
/// (4 when left out).
#[tauri::command]
pub async fn core_qr_generate(
    content: String,
    size: u32,
    error_correction: String,
    format: String,
    border: Option<u32>,
) -> Result<Response, CoreError> {
    let border = border.unwrap_or(qr::DEFAULT_BORDER);
    blocking_image(move || qr::generate(&content, size, &error_correction, &format, border)).await
}

/// A barcode as PNG or SVG bytes. `barcode_type` is `code128`, `ean13`, `ean8`
/// or `code39`.
#[tauri::command]
pub async fn core_barcode_generate(
    content: String,
    barcode_type: String,
    format: String,
) -> Result<Response, CoreError> {
    blocking_image(move || barcode::generate(&content, &barcode_type, &format)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{ipc::InvokeBody, Manager, WebviewWindowBuilder};

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        mock_builder()
            .invoke_handler(tauri::generate_handler![
                core_qr_generate,
                core_barcode_generate
            ])
            .build(mock_context(noop_assets()))
            .expect("mock app")
    }

    fn call(
        app: &tauri::App<tauri::test::MockRuntime>,
        command: &str,
        args: serde_json::Value,
    ) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        let webview = match app.get_webview_window("main") {
            Some(existing) => existing,
            None => WebviewWindowBuilder::new(app, "main", Default::default())
                .build()
                .expect("window"),
        };
        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                // The app's own origin, which differs per platform.
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    fn bytes(body: tauri::ipc::InvokeResponseBody) -> Vec<u8> {
        match body {
            tauri::ipc::InvokeResponseBody::Raw(bytes) => bytes,
            tauri::ipc::InvokeResponseBody::Json(json) => panic!("expected raw bytes, got {json}"),
        }
    }

    #[test]
    fn qr_command_returns_png_bytes() {
        let app = app();
        let body = call(
            &app,
            "core_qr_generate",
            serde_json::json!({ "content": "hello", "size": 4, "errorCorrection": "M", "format": "png" }),
        )
        .expect("ok");
        assert_eq!(&bytes(body)[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn qr_command_returns_svg_bytes_and_honours_border() {
        let app = app();
        let body = call(
            &app,
            "core_qr_generate",
            serde_json::json!({ "content": "hello", "size": 4, "errorCorrection": "L", "format": "svg", "border": 0 }),
        )
        .expect("ok");
        let svg = String::from_utf8(bytes(body)).unwrap();
        assert!(
            svg.contains("width=\"21mm\""),
            "version 1, no border: {}",
            &svg[..200]
        );
    }

    #[test]
    fn barcode_command_returns_png_bytes() {
        let app = app();
        let body = call(
            &app,
            "core_barcode_generate",
            serde_json::json!({ "content": "Dokuwu-2026", "barcodeType": "code128", "format": "png" }),
        )
        .expect("ok");
        assert_eq!(&bytes(body)[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn errors_reach_the_page_as_code_and_message() {
        let app = app();
        let err = call(
            &app,
            "core_barcode_generate",
            serde_json::json!({ "content": "1234567890", "barcodeType": "ean13", "format": "png" }),
        )
        .expect_err("invalid digits");
        assert_eq!(err["code"], "invalid_input");
        assert_eq!(
            err["message"],
            "invalid input: EAN-13 requires exactly 12 or 13 numeric digits."
        );

        let err = call(
            &app,
            "core_qr_generate",
            serde_json::json!({ "content": " ", "size": 10, "errorCorrection": "M", "format": "png" }),
        )
        .expect_err("empty");
        assert_eq!(err["message"], "invalid input: Content cannot be empty.");
    }
}
