//! The Edit Content entry point the app calls.
//!
//! The frontend opens a document by path, sends command envelopes and exports
//! the saved PDF to a folder. Everything else (worker, commit store, history)
//! is behind this type.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};

use super::coordinator::{CoordFailure, OpenFailure, SessionCoordinator};
use super::diagnose::failure_message;
use super::identity;
use super::protocol::{accepted_read_reply, is_opaque_id, outcome_reply, Envelope, HistoryAction, Request};
use super::registry::{CloseError, SessionRegistry, Unavailable};
use super::unlock::unlock_permission_only;
use super::worker::LaunchConfig;
use super::EditError;
use crate::ops::naming::{create_part, PartGuard};

/// The largest PDF Edit Content opens.
pub const MAX_SOURCE_BYTES: u64 = 16 * 1024 * 1024;

const WORKER_ENV: &str = "PDF_MANAGER_EDIT_CONTENT_WORKER";
const LIBRARY_ENV: &str = "PDF_MANAGER_PDFIUM_LIBRARY";

type Operation<'a> = dyn Fn(&SessionCoordinator, &dyn Fn() -> bool) -> Result<Value, CoordFailure> + 'a;

/// A failure the frontend can act on: a stable `code` and a ready message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostError {
    pub code: String,
    pub message: String,
}

impl HostError {
    fn new(code: &str, message: &str) -> Self {
        Self { code: code.to_owned(), message: message.to_owned() }
    }

    fn engine(code: &str) -> Self {
        let known = failure_message(code);
        Self::new(code, known.or_else(|| failure_message("ENGINE_UNAVAILABLE")).unwrap_or("Edit Content engine is unavailable."))
    }

    fn invalid(message: impl AsRef<str>) -> Self {
        Self::new("INVALID_REQUEST", message.as_ref())
    }

    fn session(error: Unavailable) -> Self {
        match error {
            Unavailable::NotFound => Self::new("SESSION_NOT_FOUND", error.message()),
            Unavailable::Unknown => Self::new("SESSION_UNVERIFIED", error.message()),
        }
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for HostError {}

impl From<OpenFailure> for HostError {
    fn from(failure: OpenFailure) -> Self {
        match failure {
            OpenFailure::File { code } | OpenFailure::Engine { code } => Self::engine(&code),
        }
    }
}

#[derive(Debug, Clone)]
pub struct HostConfig {
    /// One folder per session: commit record, checkpoints and outputs.
    pub sessions_root: PathBuf,
    /// Candidates the worker prepares before they are committed.
    pub worker_workspace: PathBuf,
    /// Where the private copy of an opened document is made.
    pub scratch_root: PathBuf,
    pub worker_command: Vec<String>,
    pub pdfium_library: PathBuf,
    /// The packaged `edit-content` folder; its identity must match this build.
    pub resource_root: Option<PathBuf>,
    pub app_version: String,
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

impl HostConfig {
    /// The configuration of a running app. `resource_root` is the packaged
    /// `edit-content` folder (None in development); `dev_root` is the
    /// repository, where a development build finds its worker.
    ///
    /// `PDF_MANAGER_EDIT_CONTENT_WORKER` and `PDF_MANAGER_PDFIUM_LIBRARY` replace
    /// the worker executable and the PDFium library.
    pub fn resolve(resource_root: Option<PathBuf>, dev_root: &Path, app_version: &str) -> Self {
        let data = home_dir().unwrap_or_else(std::env::temp_dir).join("PDFManager").join("data");
        let exe = if cfg!(windows) { "edit-content-engine.exe" } else { "edit-content-engine" };
        let library = if cfg!(windows) { "pdfium.dll" } else { "libpdfium.so" };
        let (mut worker, mut pdfium) = match &resource_root {
            Some(root) => (root.join(exe), root.join(identity::current().map(|i| i.library_file.as_str()).unwrap_or(library))),
            None => {
                let engine = dev_root.join("native").join("edit-content-engine");
                (engine.join("target").join("debug").join(exe), engine.join(library))
            }
        };
        if let Some(value) = std::env::var_os(WORKER_ENV).filter(|v| !v.is_empty()) {
            worker = PathBuf::from(value);
        }
        if let Some(value) = std::env::var_os(LIBRARY_ENV).filter(|v| !v.is_empty()) {
            pdfium = PathBuf::from(value);
        }
        Self {
            sessions_root: data.join("edit-content-sessions"),
            worker_workspace: data.join("edit-content-worker"),
            scratch_root: std::env::temp_dir(),
            worker_command: vec![worker.to_string_lossy().into_owned()],
            pdfium_library: pdfium,
            resource_root,
            app_version: app_version.to_owned(),
        }
    }

    fn launch_config(&self) -> Result<LaunchConfig, EditError> {
        let identity = identity::current()?;
        if let Some(root) = &self.resource_root {
            identity::validate_runtime(root)?;
        }
        let mut launch = LaunchConfig::new(self.worker_command.clone(), self.pdfium_library.clone(), self.worker_workspace.clone());
        launch.parent_process_id = Some(std::process::id());
        launch.inspection_cache_id = format!("{}/{}", self.app_version, identity.library_sha256);
        Ok(launch)
    }
}

pub struct EditContentHost {
    registry: SessionRegistry,
    scratch_root: PathBuf,
    scratch_counter: AtomicU64,
}

impl EditContentHost {
    pub fn new(config: HostConfig) -> Self {
        let scratch_root = config.scratch_root.clone();
        let sessions_root = config.sessions_root.clone();
        let cached: Mutex<Option<Arc<LaunchConfig>>> = Mutex::new(None);
        let factory = Box::new(move || {
            let mut cached = cached.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(launch) = cached.as_ref() {
                return Ok(Arc::clone(launch));
            }
            let launch = Arc::new(config.launch_config()?);
            *cached = Some(Arc::clone(&launch));
            Ok(launch)
        });
        Self { registry: SessionRegistry::new(factory, sessions_root), scratch_root, scratch_counter: AtomicU64::new(0) }
    }

    pub fn registry(&self) -> &SessionRegistry {
        &self.registry
    }

    /// Opens a PDF by path. The document is copied privately first: the
    /// original is never changed, and a permission-only protection is removed
    /// from the copy only.
    pub fn open(&self, source: &Path) -> Result<Value, HostError> {
        let copy = PrivateCopy::make(&self.scratch_root, &self.scratch_counter, source)?;
        let permissions_removed = unlock_permission_only(copy.path());
        let opened = self.registry.open(copy.path())?;
        let state = opened.coordinator.state(false).map_err(|_| HostError::engine("ENGINE_UNAVAILABLE"))?;
        let discovery = opened.inspected.get("result").and_then(|r| r.get("discovery")).cloned().unwrap_or_else(|| json!({}));
        let request_id = format!("open-{}", uuid::Uuid::new_v4().simple());
        Ok(accepted_read_reply(
            &request_id,
            &state.session_id,
            state.accepted_revision,
            json!({ "state": state, "discovery": discovery, "permissionsRemoved": permissions_removed }),
        ))
    }

    /// Runs one envelope. The reply carries the outcome; a repeated request id
    /// returns the recorded outcome and is never executed twice.
    pub fn command(&self, session_id: &str, envelope: Value) -> Result<Value, HostError> {
        let envelope = Envelope::parse(envelope).map_err(|e| HostError::invalid(e.0))?;
        if envelope.session_id != session_id {
            return Err(HostError::invalid("Request command or session does not match this endpoint."));
        }
        let request = Request::from_envelope(&envelope).map_err(|e| HostError::invalid(e.0))?;
        let request_id = envelope.request_id.as_str();
        let revision = envelope.expected_accepted_revision;
        let target = envelope.target_id.as_deref();
        let run = |operation: &Operation| {
            self.registry.run(session_id, request_id, |coordinator, cancelled| operation(coordinator, cancelled))
        };
        let reply = match request {
            Request::Discovery => run(&|c, _| read(c, session_id, request_id, revision, target, None)),
            Request::HitTest(payload) => run(&|c, _| read(c, session_id, request_id, revision, target, Some(payload.clone()))),
            Request::ValidateRange { target_id, payload } => {
                run(&|c, _| read(c, session_id, request_id, revision, Some(&target_id), Some(payload.clone())))
            }
            Request::Preflight { target_id, edit } => run(&|c, _| {
                let report = c.preflight(request_id, revision, &target_id, &edit)?;
                let list = |key: &str| report.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
                let public = json!({
                    "eligible": report.get("eligible").and_then(Value::as_bool).unwrap_or(false),
                    "guardReasons": list("guardReasons"),
                    "primaryGuardReason": report.get("primaryGuardReason").cloned().unwrap_or(Value::Null),
                    "detailCodes": list("detailCodes"),
                    "unsupportedCodePoints": list("unsupportedCodePoints"),
                });
                Ok(accepted_read_reply(request_id, session_id, revision, json!({ "preflight": public })))
            }),
            Request::Render { page_index, width_px, height_px } => run(&|c, _| {
                let reply = c.render(request_id, revision, page_index, width_px, height_px)?;
                let accepted = reply.get("acceptedRevision").and_then(Value::as_i64).unwrap_or(revision);
                Ok(accepted_read_reply(request_id, session_id, accepted, reply.get("result").cloned().unwrap_or_else(|| json!({}))))
            }),
            Request::Apply { target_id, edit } => run(&|c, cancelled| {
                let outcome = c.apply(request_id, revision, &target_id, &edit, false, cancelled)?;
                Ok(outcome_reply(&outcome, &c.state(false)?))
            }),
            Request::History { action, pending_draft } => run(&|c, cancelled| {
                let outcome = match action {
                    HistoryAction::Undo => c.undo(request_id, revision, pending_draft, cancelled)?,
                    HistoryAction::Redo => c.redo(request_id, revision, pending_draft, cancelled)?,
                };
                Ok(outcome_reply(&outcome, &c.state(false)?))
            }),
            Request::Save { target_id, draft } => run(&|c, cancelled| {
                let outcome = match &draft {
                    None => c.save(request_id, revision, cancelled)?,
                    Some(edit) => c.apply(request_id, revision, target_id.as_deref().unwrap_or(""), edit, true, cancelled)?,
                };
                Ok(outcome_reply(&outcome, &c.state(false)?))
            }),
            Request::Close { pending_draft, decision } => return self.close_session(session_id, request_id, revision, pending_draft, decision),
        };
        Ok(reply)
    }

    fn close_session(
        &self,
        session_id: &str,
        request_id: &str,
        revision: i64,
        pending_draft: bool,
        decision: super::protocol::CloseDecision,
    ) -> Result<Value, HostError> {
        let coordinator = self.registry.get(session_id).map_err(HostError::session)?;
        let state = coordinator.state(pending_draft).map_err(|_| HostError::session(Unavailable::Unknown))?;
        let refusal = |status: &str, reason: &str, error: &str| {
            super::protocol::reply(request_id, session_id, status, state.accepted_revision, json!({ "state": state }), Some(reason), Some(error))
        };
        if revision != state.accepted_revision {
            return Ok(refusal("stale", "REJECTED_STALE_REVISION", "The document changed before close."));
        }
        if (pending_draft || state.dirty) && decision != super::protocol::CloseDecision::Discard {
            return Ok(refusal("rejected", "REJECTED_UNSUPPORTED_STRUCTURE", "Save or explicitly discard changes before closing."));
        }
        match self.registry.close(session_id) {
            Ok(()) => {}
            Err(CloseError::NotFound) => return Err(HostError::session(Unavailable::NotFound)),
            Err(CloseError::Busy) => return Err(HostError::new("SESSION_BUSY", "Active Edit Content requests did not stop before close.")),
        }
        Ok(accepted_read_reply(request_id, session_id, state.accepted_revision, json!({ "closed": true })))
    }

    /// Tells a running request to stop at its next checkpoint.
    pub fn cancel(&self, session_id: &str, request_id: &str) -> Result<Value, HostError> {
        if !is_opaque_id(request_id) {
            return Err(HostError::invalid("Invalid request identity."));
        }
        let accepted = self.registry.cancel(session_id, request_id).map_err(HostError::session)?;
        Ok(json!({ "status": if accepted { "accepted" } else { "not-running" }, "requestId": request_id }))
    }

    /// Copies a published output into `dir` under a free name and returns its
    /// path. The bytes are verified against the commit record first.
    pub fn export(&self, session_id: &str, output_id: &str, dir: &Path, name: Option<&str>) -> Result<PathBuf, HostError> {
        let missing = || HostError::new("OUTPUT_NOT_FOUND", "Published output was not found.");
        if !is_opaque_id(output_id) {
            return Err(missing());
        }
        let (bytes, _) = self.registry.output_bytes(session_id, output_id).map_err(|error| match error {
            EditError::Unknown(_) | EditError::Io(_) => HostError::new("OUTPUT_UNVERIFIED", "Published output could not be verified."),
            _ => missing(),
        })?;
        let fallback = format!("edit-content-{}", &output_id[..output_id.len().min(8)]);
        let stem = crate::ops::naming::sanitize_stem(name.filter(|n| !n.trim().is_empty()).unwrap_or(&fallback));
        write_new(dir, &stem, &bytes).map_err(|_| HostError::new("EXPORT_FAILED", "The PDF could not be saved to the folder."))
    }

    /// Cancels active requests and closes every worker; committed stores stay.
    pub fn shutdown(&self) -> Result<usize, HostError> {
        self.registry
            .close_all()
            .map_err(|_| HostError::new("SESSION_BUSY", "Active Edit Content requests did not stop before shutdown."))
    }
}

fn read(
    coordinator: &SessionCoordinator,
    session_id: &str,
    request_id: &str,
    revision: i64,
    target: Option<&str>,
    payload: Option<Value>,
) -> Result<Value, CoordFailure> {
    let reply = coordinator.inspect(Some(request_id), Some(revision), target, payload)?;
    let result = reply.get("result").cloned().unwrap_or(Value::Null);
    let mut public = serde_json::Map::new();
    for key in ["discovery", "hitTest", "unicodeRange", "exactObjectTextMatched"] {
        if let Some(value) = result.get(key) {
            public.insert(key.to_owned(), value.clone());
        }
    }
    let accepted = reply.get("acceptedRevision").and_then(Value::as_i64).unwrap_or(revision);
    Ok(accepted_read_reply(request_id, session_id, accepted, Value::Object(public)))
}

fn write_new(dir: &Path, stem: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let (mut file, part) = create_part(dir, stem, "pdf")?;
    let guard = PartGuard::new(part);
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    guard.publish(dir, stem, "pdf")
}

/// A private, read-only-by-convention copy of the document being opened,
/// removed when dropped.
struct PrivateCopy {
    dir: PathBuf,
    file: PathBuf,
}

impl PrivateCopy {
    fn make(scratch_root: &Path, counter: &AtomicU64, source: &Path) -> Result<Self, HostError> {
        let is_pdf = source.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
        if !is_pdf {
            return Err(HostError::new("UNSUPPORTED_FILE", "Edit Content accepts PDF files only."));
        }
        let unreadable = || HostError::new("PDF_UNREADABLE", failure_message("PDF_UNREADABLE").unwrap_or("The PDF could not be read."));
        let mut input = File::open(source).map_err(|_| unreadable())?;
        if !input.metadata().map_err(|_| unreadable())?.is_file() {
            return Err(unreadable());
        }
        let dir = scratch_root.join(format!("dokuwu-editcontent-{}-{}", std::process::id(), counter.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&dir).map_err(|_| HostError::engine("ENGINE_UNAVAILABLE"))?;
        let copy = Self { file: dir.join(format!("{}.pdf", uuid::Uuid::new_v4().simple())), dir };
        let mut output = File::create(&copy.file).map_err(|_| HostError::engine("ENGINE_UNAVAILABLE"))?;
        // Bounded, so a file that grows while it is copied cannot exceed the limit.
        let mut limited = (&mut input).take(MAX_SOURCE_BYTES + 1);
        let total = io::copy(&mut limited, &mut output).map_err(|_| unreadable())?;
        drop(output);
        if total > MAX_SOURCE_BYTES {
            return Err(HostError::new("FILE_TOO_LARGE", "PDF exceeds the 16 MiB Edit Content limit."));
        }
        if total == 0 {
            return Err(HostError::new("FILE_EMPTY", "PDF file is empty."));
        }
        Ok(copy)
    }

    fn path(&self) -> &Path {
        &self.file
    }
}

impl Drop for PrivateCopy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counter() -> AtomicU64 {
        AtomicU64::new(0)
    }

    #[test]
    fn only_pdf_files_within_the_limit_are_copied_and_the_copy_is_removed() {
        let temp = tempfile::tempdir().unwrap();
        let scratch = temp.path().join("scratch");
        let code = |path: &Path| PrivateCopy::make(&scratch, &counter(), path).err().map(|e| e.code);
        let text = temp.path().join("notes.txt");
        fs::write(&text, b"x").unwrap();
        assert_eq!(code(&text).as_deref(), Some("UNSUPPORTED_FILE"));
        assert_eq!(code(&temp.path().join("missing.pdf")).as_deref(), Some("PDF_UNREADABLE"));
        let empty = temp.path().join("empty.pdf");
        fs::write(&empty, b"").unwrap();
        assert_eq!(code(&empty).as_deref(), Some("FILE_EMPTY"));
        let big = temp.path().join("big.pdf");
        File::create(&big).unwrap().set_len(MAX_SOURCE_BYTES + 1).unwrap();
        assert_eq!(code(&big).as_deref(), Some("FILE_TOO_LARGE"));
        let exact = temp.path().join("exact.PDF");
        File::create(&exact).unwrap().set_len(MAX_SOURCE_BYTES).unwrap();
        let kept;
        {
            let copy = PrivateCopy::make(&scratch, &counter(), &exact).unwrap();
            assert_eq!(fs::metadata(copy.path()).unwrap().len(), MAX_SOURCE_BYTES);
            kept = copy.dir.clone();
            assert!(kept.is_dir());
        }
        assert!(!kept.exists());
        assert!(exact.exists(), "the original is untouched");
        for rejected in ["big.pdf", "empty.pdf"] {
            assert_eq!(fs::read_dir(&scratch).unwrap().count(), 0, "{rejected} left no copy");
        }
    }

    #[test]
    fn export_names_never_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let first = write_new(temp.path(), "report", b"one").unwrap();
        let second = write_new(temp.path(), "report", b"two").unwrap();
        assert_eq!(first.file_name().unwrap(), "report.pdf");
        assert_eq!(second.file_name().unwrap(), "report (1).pdf");
        assert_eq!(fs::read(&first).unwrap(), b"one");
        assert_eq!(fs::read(&second).unwrap(), b"two");
        let leftovers: Vec<_> = fs::read_dir(temp.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(leftovers.len(), 2, "{leftovers:?}");
    }

    #[test]
    fn engine_failures_carry_their_code_and_a_ready_message() {
        let timeout = HostError::engine("OPEN_TIMEOUT");
        assert_eq!(timeout.code, "OPEN_TIMEOUT");
        assert!(timeout.message.contains("too long"));
        let odd = HostError::engine("SOMETHING_ELSE");
        assert_eq!(odd.code, "SOMETHING_ELSE");
        assert_eq!(odd.message, "Edit Content engine is unavailable.");
        assert_eq!(HostError::from(OpenFailure::File { code: "PDF_ENCRYPTED".into() }).code, "PDF_ENCRYPTED");
    }
}
