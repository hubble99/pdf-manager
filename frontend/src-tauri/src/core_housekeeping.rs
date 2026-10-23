//! Tauri commands for housekeeping (`dokuwu_core::ops::housekeeping`) and the
//! readiness check the splash screen waits on.

use std::time::Duration;

use dokuwu_core::ops::housekeeping::{clear_temp, AppDirs, ClearReport, Scope};
use dokuwu_core::{CoreError, CoreResult, JobRunner};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::core_bridge::CoreState;

/// True while some feature still calls the Python sidecar. `remove-python-sidecar`
/// sets this to false (and then deletes it together with the sidecar).
pub const SIDECAR_REQUIRED: bool = true;

/// Scratch folders older than this are leftovers of a crashed run.
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub app_version: String,
    pub core_version: &'static str,
    pub sidecar_required: bool,
}

/// The core answers as soon as the app runs; the splash screen closes on this
/// (plus the sidecar's own health while `sidecar_required`).
#[tauri::command]
pub fn core_health<R: Runtime>(app: AppHandle<R>) -> Health {
    Health {
        app_version: app.package_info().version.to_string(),
        core_version: dokuwu_core::VERSION,
        sidecar_required: SIDECAR_REQUIRED,
    }
}

/// Removes temporary and legacy output files. Refused while a job runs, so a
/// working copy is never deleted under it.
#[tauri::command]
pub async fn core_clear_temp(state: State<'_, CoreState>) -> Result<ClearReport, CoreError> {
    ensure_idle(&state.runner)?;
    tauri::async_runtime::spawn_blocking(|| clear_temp(&AppDirs::detect(), Scope::All))
        .await
        .map_err(|e| CoreError::Internal(format!("cleanup stopped: {e}")))
}

fn ensure_idle(runner: &JobRunner) -> CoreResult<()> {
    if runner.active_jobs() > 0 {
        return Err(CoreError::Busy("a job is still running".into()));
    }
    Ok(())
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
        assert!(health.sidecar_required);
        assert!(!health.app_version.is_empty());
    }

    #[test]
    fn clearing_is_refused_while_a_job_runs() {
        let runner = JobRunner::new();
        assert!(ensure_idle(&runner).is_ok());
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        runner
            .spawn("t", None, move |_| { let _ = rx.recv(); Ok(()) }, |_, _| {})
            .unwrap();
        let err = ensure_idle(&runner).unwrap_err();
        assert_eq!(err.code(), "busy");
        tx.send(()).unwrap();
    }
}
