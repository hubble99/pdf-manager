//! Tauri commands for housekeeping (`dokuwu_core::ops::housekeeping`) and the
//! readiness check the splash screen waits on.

use std::time::Duration;

use dokuwu_core::ops::housekeeping::{clear_temp, AppDirs, Scope};
use dokuwu_core::CoreError;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// Scratch folders older than this are leftovers of a crashed run.
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub app_version: String,
    pub core_version: &'static str,
}

/// The core answers as soon as the app runs; the splash screen closes on this.
#[tauri::command]
pub fn core_health<R: Runtime>(app: AppHandle<R>) -> Health {
    Health {
        app_version: app.package_info().version.to_string(),
        core_version: dokuwu_core::VERSION,
    }
}

/// Opens the system Downloads folder in the file manager. The path comes from
/// the OS, so a redirected or OneDrive Downloads folder works too.
#[tauri::command]
pub fn core_open_downloads<R: Runtime>(app: AppHandle<R>) -> Result<(), CoreError> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| CoreError::Internal(format!("no downloads folder: {e}")))?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| CoreError::Internal(format!("cannot open the folder: {e}")))
}

/// App start: remove scratch folders a crashed run left behind. Runs on a
/// background thread; a failure is ignored.
pub fn sweep_stale_scratch() {
    std::thread::spawn(|| {
        clear_temp(&AppDirs::detect(), Scope::Stale { min_age: STALE_AFTER });
    });
}

/// App exit, after jobs were cancelled: remove what this run created.
pub fn clear_on_exit() {
    clear_temp(&AppDirs::detect(), Scope::Exit { pid: std::process::id() });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_reports_versions() {
        let app = tauri::test::mock_app();
        let health = core_health(app.handle().clone());
        assert_eq!(health.core_version, dokuwu_core::VERSION);
        assert!(!health.app_version.is_empty());
    }
}
