//! Tauri commands for Merge PDF, Extract pages and the Merge folder workspace
//! (`dokuwu_core::ops::pdf_merge`, `pdf_extract`, `folder_scan`).
//!
//! Results go to the Downloads folder under a free name (" (1)", " (2)", ...
//! are added instead of overwriting).
//!
//! Merge works on a list of paths. In folder mode the list holds names relative
//! to the chosen folder and `root` is that folder; every name is checked to be
//! a PDF inside it (no `..`, no absolute or drive paths, no link leaving it)
//! before anything is read. Problems and skipped files come back as positions in
//! the list that was sent, so the interface can mark its own rows.

use std::path::PathBuf;

use dokuwu_core::job::{JobContext, JobId, JobRunner};
use dokuwu_core::ops::folder_scan::{resolve_all, scan_folder, ScanResult};
use dokuwu_core::ops::pdf_extract::{extract, ExtractMode, ExtractOptions, ExtractReport};
use dokuwu_core::ops::pdf_merge::{describe, inspect, merge, Described, Inspection, MergeOptions, MergeReport};
use dokuwu_core::{CoreError, CoreResult};
use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::core_bridge::{start_job, CoreState};

fn downloads<R: Runtime>(app: &AppHandle<R>) -> CoreResult<PathBuf> {
    app.path()
        .download_dir()
        .map_err(|e| CoreError::Internal(format!("cannot find the Downloads folder: {e}")))
}

/// The files to work on: the paths as sent, or, with a `root`, names resolved
/// inside that folder.
fn resolve_list(root: Option<&str>, paths: Vec<String>) -> CoreResult<Vec<PathBuf>> {
    match root.map(str::trim).filter(|r| !r.is_empty()) {
        Some(root) => resolve_all(&PathBuf::from(root), &paths),
        None => {
            if paths.iter().any(|p| p.trim().is_empty()) {
                return Err(CoreError::InvalidInput("path is empty".into()));
            }
            Ok(paths.into_iter().map(PathBuf::from).collect())
        }
    }
}

/// Merges the PDFs in the order given.
#[tauri::command]
pub fn core_pdf_merge_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CoreState>,
    paths: Vec<String>,
    root: Option<String>,
    skip_invalid: bool,
    output_name: Option<String>,
) -> Result<JobId, CoreError> {
    let dir = downloads(&app)?;
    start_merge(&app, &state.runner, paths, root, skip_invalid, output_name, dir)
}

pub(crate) fn start_merge<R: Runtime>(
    app: &AppHandle<R>,
    runner: &JobRunner,
    paths: Vec<String>,
    root: Option<String>,
    skip_invalid: bool,
    output_name: Option<String>,
    dir: PathBuf,
) -> CoreResult<JobId> {
    if paths.len() < 2 {
        return Err(CoreError::InvalidInput("At least 2 PDF files are required to merge.".into()));
    }
    let files = resolve_list(root.as_deref(), paths)?;
    start_job(app, runner, "pdf_merge", move |ctx: &JobContext| -> CoreResult<MergeReport> {
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
        let options = MergeOptions { skip_invalid, output_dir: dir, output_name, flush_after_bytes: None };
        merge(&files, &options, ctx)
    })
}

/// Why each file cannot be merged, without merging anything.
#[tauri::command]
pub async fn core_pdf_inspect(paths: Vec<String>, root: Option<String>) -> Result<Inspection, CoreError> {
    let files = resolve_list(root.as_deref(), paths)?;
    blocking(move || inspect(&files, &JobContext::detached())).await
}

/// Size and page count of each file.
#[tauri::command]
pub async fn core_pdf_describe(paths: Vec<String>, root: Option<String>) -> Result<Vec<Described>, CoreError> {
    let files = resolve_list(root.as_deref(), paths)?;
    blocking(move || describe(&files, &JobContext::detached())).await
}

/// The PDFs of a folder and its sub-folders, as a tree.
#[tauri::command]
pub async fn core_folder_scan(root: String) -> Result<ScanResult, CoreError> {
    if root.trim().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    blocking(move || scan_folder(&PathBuf::from(root), &JobContext::detached())).await
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> CoreResult<T> + Send + 'static) -> Result<T, CoreError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| CoreError::Internal(format!("task stopped: {e}")))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractArgs {
    pub mode: ExtractMode,
    #[serde(default)]
    pub page_ranges: String,
    #[serde(default)]
    pub output_name: Option<String>,
}

/// Takes pages out of a PDF: one PDF, or a ZIP of PDFs.
#[tauri::command]
pub fn core_pdf_extract_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CoreState>,
    input_path: String,
    options: ExtractArgs,
) -> Result<JobId, CoreError> {
    let dir = downloads(&app)?;
    start_extract(&app, &state.runner, PathBuf::from(input_path), options, dir)
}

pub(crate) fn start_extract<R: Runtime>(
    app: &AppHandle<R>,
    runner: &JobRunner,
    input: PathBuf,
    args: ExtractArgs,
    dir: PathBuf,
) -> CoreResult<JobId> {
    if input.as_os_str().is_empty() {
        return Err(CoreError::InvalidInput("path is empty".into()));
    }
    start_job(app, runner, "pdf_extract", move |ctx: &JobContext| -> CoreResult<ExtractReport> {
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
        let options = ExtractOptions {
            mode: args.mode,
            page_ranges: args.page_ranges,
            output_dir: dir,
            output_name: args.output_name,
            flush_after_bytes: None,
        };
        extract(&input, &options, ctx)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_bridge::{FINISHED_EVENT, PROGRESS_EVENT};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;

    /// Runs a job through the real event path and returns (progress, finished).
    fn run<F>(kind: &str, start: F) -> (Vec<serde_json::Value>, serde_json::Value)
    where
        F: FnOnce(&AppHandle<tauri::test::MockRuntime>, &JobRunner) -> CoreResult<JobId>,
    {
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
        let id = start(&handle, &runner).unwrap();
        let mut progress = Vec::new();
        loop {
            let (finished, payload) = rx.recv_timeout(Duration::from_secs(60)).expect("event");
            assert_eq!(payload["jobId"], id);
            assert_eq!(payload["kind"], kind);
            if finished {
                return (progress, payload);
            }
            progress.push(payload);
        }
    }

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../native/dokuwu-core/tests/fixtures/pdf-compress")
    }

    fn path(name: &str) -> String {
        fixtures().join(name).to_string_lossy().into_owned()
    }

    #[test]
    fn merge_reports_files_then_writes_the_pdf() {
        let out = tempfile::tempdir().unwrap();
        let dir = out.path().to_path_buf();
        let (progress, done) = run("pdf_merge", |app, runner| {
            start_merge(app, runner, vec![path("shared.pdf"), path("tiny.pdf")], None, false, Some("Gabungan".into()), dir)
        });
        assert!(progress.iter().any(|p| p["stage"] == "files"));
        assert_eq!(done["status"], "succeeded");
        let report = &done["result"];
        assert_eq!(report["mergedFiles"], 2);
        assert_eq!(report["totalPages"], 4);
        assert_eq!(report["skipped"], serde_json::json!([]));
        assert_eq!(report["outputPath"], out.path().join("Gabungan.pdf").to_str().unwrap());
        assert!(out.path().join("Gabungan.pdf").is_file());
    }

    #[test]
    fn folder_mode_resolves_names_inside_the_folder_and_reports_positions() {
        let src = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(src.path().join("Sub")).unwrap();
        std::fs::copy(fixtures().join("shared.pdf"), src.path().join("a.pdf")).unwrap();
        std::fs::copy(fixtures().join("tiny.pdf"), src.path().join("Sub/b.pdf")).unwrap();
        std::fs::copy(fixtures().join("encrypted.pdf"), src.path().join("Sub/locked.pdf")).unwrap();
        let root = src.path().to_string_lossy().into_owned();
        let names = vec!["a.pdf".to_string(), "Sub/locked.pdf".to_string(), "Sub/b.pdf".to_string()];
        let dir = out.path().to_path_buf();
        let (_, done) = run("pdf_merge", |app, runner| {
            start_merge(app, runner, names, Some(root), true, None, dir)
        });
        assert_eq!(done["status"], "succeeded");
        let report = &done["result"];
        assert_eq!(report["mergedFiles"], 2);
        assert_eq!(report["skipped"], serde_json::json!([{ "index": 1, "reason": "encrypted" }]));
        assert_eq!(report["outputPath"], out.path().join("merged_output.pdf").to_str().unwrap());
    }

    #[test]
    fn folder_mode_refuses_paths_that_leave_the_folder_before_a_job_starts() {
        let src = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        let runner = JobRunner::new();
        let root = src.path().to_string_lossy().into_owned();
        for bad in ["../x.pdf", "/etc/x.pdf", "C:\\x.pdf", "\\\\srv\\share\\x.pdf", "x.txt"] {
            let err = start_merge(
                app.handle(),
                &runner,
                vec!["ok.pdf".into(), bad.into()],
                Some(root.clone()),
                false,
                None,
                std::env::temp_dir(),
            )
            .unwrap_err();
            assert_eq!(err.code(), "invalid_input", "{bad}");
        }
        assert_eq!(runner.active_jobs(), 0);
    }

    #[test]
    fn merge_needs_two_files_and_strict_errors_keep_their_codes() {
        let app = tauri::test::mock_app();
        let runner = JobRunner::new();
        let err = start_merge(app.handle(), &runner, vec![path("tiny.pdf")], None, false, None, std::env::temp_dir()).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        let out = tempfile::tempdir().unwrap();
        let dir = out.path().to_path_buf();
        let (_, done) = run("pdf_merge", |app, runner| {
            start_merge(app, runner, vec![path("tiny.pdf"), path("encrypted.pdf")], None, false, None, dir)
        });
        assert_eq!(done["status"], "failed");
        assert_eq!(done["error"]["code"], "invalid_input");
        assert!(done["error"]["message"].as_str().unwrap().contains("'encrypted.pdf' is encrypted"));
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
    }

    #[test]
    fn inspect_describe_and_scan_answer_directly() {
        let paths = vec![path("shared.pdf"), path("encrypted.pdf"), path("gone.pdf")];
        let inspection = tauri::async_runtime::block_on(core_pdf_inspect(paths.clone(), None)).unwrap();
        assert_eq!(inspection.usable, 1);
        assert_eq!(inspection.problems.len(), 2);
        let described = tauri::async_runtime::block_on(core_pdf_describe(paths, None)).unwrap();
        assert_eq!(described[0].pages, Some(3));
        assert_eq!(described[1].pages, None);

        let scan = tauri::async_runtime::block_on(core_folder_scan(fixtures().to_string_lossy().into_owned())).unwrap();
        assert!(scan.pdf_count >= 10);
        assert!(scan.root.files.contains(&"shared.pdf".to_string()));
        let err = tauri::async_runtime::block_on(core_folder_scan(String::new())).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        let err = tauri::async_runtime::block_on(core_pdf_inspect(vec!["x.pdf".into()], Some(fixtures().join("..").to_string_lossy().into_owned())))
            .map(|i| i.usable);
        // A name inside the folder that does not exist is a problem, not an error.
        assert_eq!(err.unwrap(), 0);
    }

    fn extract_args(mode: &str, ranges: &str) -> ExtractArgs {
        serde_json::from_value(serde_json::json!({ "mode": mode, "pageRanges": ranges })).unwrap()
    }

    #[test]
    fn extract_writes_a_zip_for_separate_ranges() {
        let out = tempfile::tempdir().unwrap();
        let dir = out.path().to_path_buf();
        let (progress, done) = run("pdf_extract", |app, runner| {
            start_extract(app, runner, PathBuf::from(path("shared.pdf")), extract_args("separate_range", "1,2-3"), dir)
        });
        assert!(progress.iter().any(|p| p["stage"] == "pages"));
        assert_eq!(done["status"], "succeeded");
        let report = &done["result"];
        assert_eq!((report["pagesExtracted"].as_u64(), report["files"].as_u64(), report["isZip"].as_bool()), (Some(3), Some(2), Some(true)));
        assert_eq!(report["outputPath"], out.path().join("extracted_shared.zip").to_str().unwrap());
    }

    #[test]
    fn extract_errors_keep_their_codes_and_mode_names_are_checked() {
        let out = tempfile::tempdir().unwrap();
        let (_, locked) = run("pdf_extract", |app, runner| {
            start_extract(app, runner, PathBuf::from(path("encrypted.pdf")), extract_args("combine", "1"), out.path().to_path_buf())
        });
        assert_eq!(locked["error"]["code"], "password_required");
        let (_, bad) = run("pdf_extract", |app, runner| {
            start_extract(app, runner, PathBuf::from(path("shared.pdf")), extract_args("combine", "9"), out.path().to_path_buf())
        });
        assert_eq!(bad["error"]["code"], "invalid_input");
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
        assert!(serde_json::from_value::<ExtractArgs>(serde_json::json!({ "mode": "everything" })).is_err());
        let app = tauri::test::mock_app();
        let err = start_extract(app.handle(), &JobRunner::new(), PathBuf::new(), extract_args("combine", "1"), std::env::temp_dir()).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
    }
}
