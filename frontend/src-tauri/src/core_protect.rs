//! Tauri commands for Protect PDF (`dokuwu_core::ops::pdf_protect`): add a
//! password and remove one.
//!
//! The result goes to the Downloads folder under a free name. The passwords
//! arrive only as arguments of these two commands; they are not logged, not
//! kept in the job record and not part of any event the jobs emit.

use std::path::PathBuf;

use dokuwu_core::job::{JobContext, JobId, JobRunner};
use dokuwu_core::ops::pdf_protect::{protect, remove_password, ProtectOptions, ProtectReport, UnprotectOptions};
use dokuwu_core::{CoreError, CoreResult};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::core_bridge::{start_job, CoreState};

fn downloads<R: Runtime>(app: &AppHandle<R>) -> CoreResult<PathBuf> {
    app.path()
        .download_dir()
        .map_err(|e| CoreError::Internal(format!("cannot find the Downloads folder: {e}")))
}

/// What the page sends to add a password. No `Debug`: it holds the passwords.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectArgs {
    pub user_password: String,
    #[serde(default)]
    pub owner_password: String,
    pub allow_print: bool,
    pub allow_copy: bool,
    pub allow_modify: bool,
    #[serde(default)]
    pub output_name: Option<String>,
}

/// Writes an AES-256 protected copy of the PDF.
#[tauri::command]
pub fn core_pdf_protect_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CoreState>,
    input_path: String,
    options: ProtectArgs,
) -> Result<JobId, CoreError> {
    let dir = downloads(&app)?;
    start_protect(&app, &state.runner, PathBuf::from(input_path), options, dir)
}

pub(crate) fn start_protect<R: Runtime>(
    app: &AppHandle<R>,
    runner: &JobRunner,
    input: PathBuf,
    args: ProtectArgs,
    dir: PathBuf,
) -> CoreResult<JobId> {
    if input.as_os_str().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    start_job(app, runner, "pdf_protect", move |ctx: &JobContext| -> CoreResult<ProtectReport> {
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
        let options = ProtectOptions {
            user_password: args.user_password,
            owner_password: args.owner_password,
            allow_print: args.allow_print,
            allow_copy: args.allow_copy,
            allow_modify: args.allow_modify,
            output_dir: dir,
            output_name: args.output_name,
        };
        protect(&input, &options, ctx)
    })
}

/// What the page sends to remove a password. No `Debug`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnprotectArgs {
    pub password: String,
    #[serde(default)]
    pub output_name: Option<String>,
}

/// Writes a copy of the PDF without its password.
#[tauri::command]
pub fn core_pdf_unprotect_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CoreState>,
    input_path: String,
    options: UnprotectArgs,
) -> Result<JobId, CoreError> {
    let dir = downloads(&app)?;
    start_unprotect(&app, &state.runner, PathBuf::from(input_path), options, dir)
}

pub(crate) fn start_unprotect<R: Runtime>(
    app: &AppHandle<R>,
    runner: &JobRunner,
    input: PathBuf,
    args: UnprotectArgs,
    dir: PathBuf,
) -> CoreResult<JobId> {
    if input.as_os_str().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    start_job(app, runner, "pdf_unprotect", move |ctx: &JobContext| -> CoreResult<ProtectReport> {
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
        let options = UnprotectOptions { password: args.password, output_dir: dir, output_name: args.output_name };
        remove_password(&input, &options, ctx)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_bridge::{FINISHED_EVENT, PROGRESS_EVENT};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;

    /// Runs a job through the real event path and returns every event payload
    /// (progress and the finished one) as text, plus the finished one parsed.
    fn run<F>(kind: &str, start: F) -> (Vec<String>, serde_json::Value)
    where
        F: FnOnce(&AppHandle<tauri::test::MockRuntime>, &JobRunner) -> CoreResult<JobId>,
    {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let (tx, rx) = mpsc::channel::<(bool, String)>();
        let progress_tx = tx.clone();
        handle.listen_any(PROGRESS_EVENT, move |e| {
            let _ = progress_tx.send((false, e.payload().to_string()));
        });
        handle.listen_any(FINISHED_EVENT, move |e| {
            let _ = tx.send((true, e.payload().to_string()));
        });
        let runner = JobRunner::new();
        let id = start(&handle, &runner).unwrap();
        let mut seen = Vec::new();
        loop {
            let (finished, text) = rx.recv_timeout(Duration::from_secs(60)).expect("event");
            let payload: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(payload["jobId"], id);
            assert_eq!(payload["kind"], kind);
            seen.push(text);
            if finished {
                return (seen, payload);
            }
        }
    }

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../native/dokuwu-core/tests/fixtures/pdf-compress").join(name)
    }

    fn protect_args(user: &str, owner: &str) -> ProtectArgs {
        serde_json::from_value(serde_json::json!({
            "userPassword": user, "ownerPassword": owner, "allowPrint": true, "allowCopy": false, "allowModify": true
        }))
        .unwrap()
    }

    #[test]
    fn protect_then_unprotect_round_trips_and_no_event_carries_a_password() {
        let out = tempfile::tempdir().unwrap();
        let dir = out.path().to_path_buf();
        let secret = "s3cret-pass";
        let (events, done) = run("pdf_protect", |app, runner| {
            start_protect(app, runner, fixture("shared.pdf"), protect_args(secret, "boss-pass"), dir)
        });
        assert_eq!(done["status"], "succeeded");
        assert_eq!(done["result"]["pages"], 3);
        let protected = out.path().join("shared_protected.pdf");
        assert_eq!(done["result"]["outputPath"], protected.to_str().unwrap());
        assert!(events.iter().all(|e| !e.contains(secret) && !e.contains("boss-pass")));

        let out2 = tempfile::tempdir().unwrap();
        let dir2 = out2.path().to_path_buf();
        let args: UnprotectArgs = serde_json::from_value(serde_json::json!({ "password": secret })).unwrap();
        let (events, done) = run("pdf_unprotect", |app, runner| start_unprotect(app, runner, protected, args, dir2));
        assert_eq!(done["status"], "succeeded");
        assert_eq!(done["result"]["outputPath"], out2.path().join("shared_protected_unlocked.pdf").to_str().unwrap());
        assert!(events.iter().all(|e| !e.contains(secret)));
    }

    #[test]
    fn errors_keep_their_codes_and_leave_no_file() {
        let out = tempfile::tempdir().unwrap();
        let (events, wrong) = run("pdf_unprotect", |app, runner| {
            let args: UnprotectArgs = serde_json::from_value(serde_json::json!({ "password": "wrong-guess" })).unwrap();
            start_unprotect(app, runner, fixture("encrypted.pdf"), args, out.path().to_path_buf())
        });
        assert_eq!(wrong["error"]["code"], "password_required");
        assert!(events.iter().all(|e| !e.contains("wrong-guess")));
        let (_, again) = run("pdf_protect", |app, runner| {
            start_protect(app, runner, fixture("encrypted.pdf"), protect_args("pw", ""), out.path().to_path_buf())
        });
        assert_eq!(again["error"]["code"], "invalid_input");
        assert!(again["error"]["message"].as_str().unwrap().contains("already encrypted"));
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);

        let app = tauri::test::mock_app();
        let err = start_protect(app.handle(), &JobRunner::new(), PathBuf::new(), protect_args("pw", ""), std::env::temp_dir()).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        assert!(serde_json::from_value::<ProtectArgs>(serde_json::json!({ "userPassword": "x" })).is_err());
    }
}
