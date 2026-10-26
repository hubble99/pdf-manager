//! Framed-stdio client of one Edit Content worker process.
//!
//! The worker (`edit-content-engine`) loads PDFium in its own process. Each
//! request is a 4-byte big-endian length followed by a JSON envelope
//! (`edit-content-request/v1`); each reply has the same framing
//! (`edit-content-reply/v1`, or `edit-content-preparation/v1` for `apply`).
//! The adapter owns at most one process and one in-flight command, enforces a
//! timeout per command (killing the worker when it is exceeded) and keeps a
//! bounded tail of the worker's diagnostics for logs, never for replies.

use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};

use super::EditError;

pub const REQUEST_SCHEMA: &str = "edit-content-request/v1";
pub const REPLY_SCHEMA: &str = "edit-content-reply/v1";
pub const PREPARATION_SCHEMA: &str = "edit-content-preparation/v1";
pub const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_REPLY_BYTES: usize = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 64 * 1024;

/// A safe adapter failure that never carries private paths or worker stderr.
/// `code` is a stable machine-readable class of failure.
#[derive(Debug, Clone)]
pub struct WorkerError {
    pub message: String,
    pub code: String,
}

impl WorkerError {
    pub fn new(message: &str) -> Self {
        Self { message: message.to_owned(), code: "ENGINE_UNAVAILABLE".to_owned() }
    }

    pub fn with_code(message: &str, code: &str) -> Self {
        Self { message: message.to_owned(), code: code.to_owned() }
    }
}

impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Debug, Clone)]
pub struct PreparationRejected {
    pub reason: String,
    pub unknown: bool,
}

/// A candidate PDF path paired with the worker's validated preparation reply.
#[derive(Debug, Clone)]
pub struct PreparedArtifactLease {
    pub path: PathBuf,
    pub response: Value,
}

#[derive(Debug, Clone)]
pub struct LaunchConfig {
    /// The worker executable, plus any leading arguments.
    pub worker_command: Vec<String>,
    pub pdfium_library: PathBuf,
    pub workspace_root: PathBuf,
    pub startup_timeout: Duration,
    pub inspect_timeout: Duration,
    pub close_timeout: Duration,
    pub parent_process_id: Option<u32>,
    /// Identifies this build; cached inspections of another build are ignored.
    /// Empty turns the inspection cache off.
    pub inspection_cache_id: String,
}

impl LaunchConfig {
    pub fn new(worker_command: Vec<String>, pdfium_library: PathBuf, workspace_root: PathBuf) -> Self {
        Self {
            worker_command,
            pdfium_library,
            workspace_root,
            startup_timeout: Duration::from_secs(30),
            inspect_timeout: Duration::from_secs(30),
            close_timeout: Duration::from_secs(10),
            parent_process_id: None,
            inspection_cache_id: String::new(),
        }
    }
}

type ReplyMessage = Result<Value, String>;

struct Connection {
    child: Child,
    stdin: ChildStdin,
    replies: Receiver<ReplyMessage>,
    stderr_tail: Arc<Mutex<VecDeque<u8>>>,
    session_id: String,
}

struct Slot {
    connection: Option<Connection>,
    session_id: Option<String>,
    source: Option<PathBuf>,
    accepted_revision: i64,
    /// Kept after the process is gone, for logs.
    last_stderr: String,
}

pub struct WorkerAdapter {
    config: Arc<LaunchConfig>,
    slot: Mutex<Slot>,
    cache_dir: Mutex<Option<PathBuf>>,
}

impl Drop for WorkerAdapter {
    /// A session that is dropped, however that happens, never leaves its worker running.
    fn drop(&mut self) {
        self.terminate();
    }
}

fn hex_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

impl WorkerAdapter {
    pub fn new(config: Arc<LaunchConfig>) -> Self {
        Self {
            config,
            slot: Mutex::new(Slot { connection: None, session_id: None, source: None, accepted_revision: 0, last_stderr: String::new() }),
            cache_dir: Mutex::new(None),
        }
    }

    fn slot(&self) -> MutexGuard<'_, Slot> {
        self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Bounded tail of worker diagnostics, for logs only.
    pub fn stderr_tail(&self) -> String {
        let slot = self.slot();
        match &slot.connection {
            Some(connection) => tail_text(&connection.stderr_tail),
            None => slot.last_stderr.clone(),
        }
    }

    pub fn is_running(&self) -> bool {
        let mut slot = self.slot();
        running(&mut slot)
    }

    /// Starts the worker on `source`. Returns the session identity.
    pub fn start(&self, source: &Path, session_id: Option<&str>, accepted_revision: i64) -> Result<String, WorkerError> {
        let mut slot = self.slot();
        self.start_locked(&mut slot, source, session_id, accepted_revision)
    }

    fn start_locked(&self, slot: &mut Slot, source: &Path, session_id: Option<&str>, accepted_revision: i64) -> Result<String, WorkerError> {
        if running(slot) {
            return Err(WorkerError::new("Content worker is already running"));
        }
        clear(slot);
        let meta = fs::symlink_metadata(source).map_err(|_| WorkerError::new("Content source is unavailable"))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(WorkerError::new("Content source is unavailable"));
        }
        fs::create_dir_all(&self.config.workspace_root).map_err(|_| WorkerError::new("Content workspace is unavailable"))?;
        if accepted_revision < 0 {
            return Err(WorkerError::new("Content revision is invalid"));
        }
        let active_session = session_id.map(str::to_owned).unwrap_or_else(hex_id);
        let (program, leading) = self
            .config
            .worker_command
            .split_first()
            .ok_or_else(|| WorkerError::new("Content worker command is empty"))?;
        let mut command = Command::new(program);
        command
            .args(leading)
            .arg("--pdfium-library")
            .arg(&self.config.pdfium_library)
            .args(["--session-id", &active_session])
            .arg("--workspace-root")
            .arg(&self.config.workspace_root)
            .arg("--source-file")
            .arg(source)
            .args(["--accepted-revision", &accepted_revision.to_string()])
            .arg("--native-inspector");
        if let Some(parent) = self.config.parent_process_id {
            command.args(["--parent-process-id", &parent.to_string()]);
        }
        if let Some(cache) = self.ensure_cache_dir() {
            command.arg("--inspection-cache-dir").arg(cache).args(["--inspection-cache-id", &self.config.inspection_cache_id]);
        }
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|_| WorkerError::with_code("Content worker could not be started", "ENGINE_START_FAILED"))?;
        let stdin = child.stdin.take().expect("piped");
        let stdout = child.stdout.take().expect("piped");
        let stderr = child.stderr.take().expect("piped");
        let (sender, replies) = sync_channel::<ReplyMessage>(1);
        thread::spawn(move || read_replies(stdout, sender));
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        let drain_tail = Arc::clone(&tail);
        thread::spawn(move || drain_stderr(stderr, drain_tail));
        slot.connection = Some(Connection { child, stdin, replies, stderr_tail: tail, session_id: active_session.clone() });
        slot.session_id = Some(active_session.clone());
        slot.source = Some(source.to_owned());
        slot.accepted_revision = accepted_revision;
        Ok(active_session)
    }

    fn ensure_cache_dir(&self) -> Option<PathBuf> {
        if self.config.inspection_cache_id.is_empty() {
            return None;
        }
        let mut cache = self.cache_dir.lock().unwrap_or_else(|p| p.into_inner());
        if cache.is_none() {
            let root = &self.config.workspace_root;
            let cutoff = SystemTime::now() - Duration::from_secs(24 * 3600);
            if let Ok(listing) = fs::read_dir(root) {
                for entry in listing.flatten() {
                    let name = entry.file_name();
                    if !name.to_string_lossy().starts_with("inspection-cache-") {
                        continue;
                    }
                    let stale = entry.metadata().ok().filter(|m| m.is_dir() && !m.file_type().is_symlink()).and_then(|m| m.modified().ok());
                    if stale.is_some_and(|modified| modified < cutoff) {
                        let _ = fs::remove_dir_all(entry.path());
                    }
                }
            }
            *cache = Some(root.join(format!("inspection-cache-{}", hex_id())));
        }
        let directory = cache.clone()?;
        fs::create_dir_all(&directory).ok()?;
        Some(directory)
    }

    /// Removes cached inspections once the session is finished.
    pub fn discard_inspection_cache(&self) {
        let directory = self.cache_dir.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(directory) = directory {
            let _ = fs::remove_dir_all(directory);
        }
    }

    pub fn open(&self) -> Result<Value, WorkerError> {
        let timeout = self.config.startup_timeout;
        self.request(&Request::new("open", None, timeout))
    }

    /// Discovery of the open document, at the worker's own revision.
    pub fn inspect(&self) -> Result<Value, WorkerError> {
        self.inspect_request(None, None, None, None)
    }

    pub fn inspect_request(
        &self,
        expected_revision: Option<i64>,
        request_id: Option<&str>,
        target_id: Option<&str>,
        payload: Option<Value>,
    ) -> Result<Value, WorkerError> {
        let revision = expected_revision.unwrap_or_else(|| self.slot().accepted_revision);
        let mut request = Request::new("inspect", Some(revision), self.config.inspect_timeout);
        request.request_id = request_id.map(str::to_owned);
        request.target_id = target_id.map(str::to_owned);
        request.payload = payload;
        self.request(&request)
    }

    pub fn render(&self, request_id: &str, expected_revision: i64, page_index: i64, width_px: i64, height_px: i64) -> Result<Value, WorkerError> {
        let mut request = Request::new("render", Some(expected_revision), Duration::from_secs(60));
        request.request_id = Some(request_id.to_owned());
        request.payload = Some(json!({ "pageIndex": page_index, "widthPx": width_px, "heightPx": height_px }));
        self.request(&request)
    }

    /// Asks the worker to prepare a candidate for one edit. The worker never
    /// commits; the returned lease is only a verified candidate on disk.
    pub fn prepare_apply(
        &self,
        request_id: &str,
        expected_revision: i64,
        target_id: &str,
        accepted_checkpoint_id: &str,
        accepted_artifact_hash: &str,
        edit: &Value,
    ) -> Result<PreparedArtifactLease, EditError> {
        let mut request = Request::new("apply", Some(expected_revision), Duration::from_secs(120));
        request.request_id = Some(request_id.to_owned());
        request.target_id = Some(target_id.to_owned());
        request.payload = Some(json!({
            "acceptedCheckpointId": accepted_checkpoint_id,
            "acceptedArtifactHash": accepted_artifact_hash,
            "edit": edit,
        }));
        request.response_schema = PREPARATION_SCHEMA;
        let response = self.request(&request)?;
        if response.get("status").and_then(Value::as_str) != Some("prepared") {
            let reason = response
                .get("guardReason")
                .and_then(Value::as_str)
                .unwrap_or("Content candidate preparation failed")
                .to_owned();
            return Err(EditError::Preparation(PreparationRejected {
                reason,
                unknown: response.get("status").and_then(Value::as_str) == Some("unknown"),
            }));
        }
        let token = response.get("result").and_then(|r| r.get("candidateToken")).and_then(Value::as_str);
        let valid = token.is_some_and(|token| {
            token
                .strip_prefix("candidate-")
                .and_then(|rest| rest.split_once('-'))
                .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && a.bytes().chain(b.bytes()).all(|c| c.is_ascii_digit()))
        });
        if !valid {
            self.terminate();
            return Err(WorkerError::new("Content worker returned an invalid candidate identity").into());
        }
        let path = self.resolve_candidate(token.expect("validated"))?;
        Ok(PreparedArtifactLease { path, response })
    }

    pub fn close(&self) -> Result<Value, WorkerError> {
        let mut slot = self.slot();
        self.close_locked(&mut slot)
    }

    fn close_locked(&self, slot: &mut Slot) -> Result<Value, WorkerError> {
        if slot.connection.is_none() {
            return Ok(json!({ "status": "closed" }));
        }
        let revision = slot.accepted_revision;
        let mut request = Request::new("close", Some(revision), self.config.close_timeout);
        request.request_id = None;
        let outcome = (|| {
            let reply = self.request_locked(slot, &request)?;
            let deadline = Instant::now() + self.config.close_timeout;
            let connection = slot.connection.as_mut().expect("checked");
            loop {
                match connection.child.try_wait() {
                    Ok(Some(status)) => {
                        if status.success() {
                            return Ok(reply);
                        }
                        return Err(WorkerError::new("Content worker did not close cleanly"));
                    }
                    Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                    _ => {
                        kill(connection);
                        return Err(WorkerError::new("Content worker did not close cleanly"));
                    }
                }
            }
        })();
        clear(slot);
        outcome
    }

    /// Reopens the worker on `source` (or the previous one) at a revision.
    pub fn restart(&self, source: Option<&Path>, accepted_revision: Option<i64>) -> Result<Value, WorkerError> {
        let mut slot = self.slot();
        let previous_source = source.map(Path::to_owned).or_else(|| slot.source.clone()).ok_or_else(|| WorkerError::new("Content source is unavailable"))?;
        let previous_session = slot.session_id.clone();
        if running(&mut slot) {
            if self.close_locked(&mut slot).is_err() {
                terminate_locked(&mut slot);
            }
        } else {
            clear(&mut slot);
        }
        let revision = accepted_revision.unwrap_or(slot.accepted_revision);
        self.start_locked(&mut slot, &previous_source, previous_session.as_deref(), revision)?;
        let request = Request::new("open", None, self.config.startup_timeout);
        self.request_locked(&mut slot, &request)
    }

    pub fn terminate(&self) {
        let mut slot = self.slot();
        terminate_locked(&mut slot);
    }

    fn request(&self, request: &Request) -> Result<Value, WorkerError> {
        let mut slot = self.slot();
        self.request_locked(&mut slot, request)
    }

    fn request_locked(&self, slot: &mut Slot, request: &Request) -> Result<Value, WorkerError> {
        let Some(connection) = slot.connection.as_mut() else {
            return Err(WorkerError::new("Content worker is unavailable"));
        };
        if !matches!(connection.child.try_wait(), Ok(None)) {
            return Err(WorkerError::new("Content worker is unavailable"));
        }
        let request_id = request.request_id.clone().unwrap_or_else(hex_id);
        let mut envelope = json!({
            "schemaVersion": REQUEST_SCHEMA,
            "requestId": request_id,
            "sessionId": connection.session_id,
            "command": request.command,
            "payload": request.payload.clone().unwrap_or_else(|| json!({})),
        });
        if let Some(revision) = request.expected_revision {
            envelope["expectedAcceptedRevision"] = json!(revision);
        }
        if let Some(target) = &request.target_id {
            envelope["targetId"] = json!(target);
        }
        let payload = serde_json::to_vec(&envelope).expect("an envelope always serializes");
        if payload.len() > MAX_REQUEST_BYTES {
            return Err(WorkerError::new("Content request exceeds the configured limit"));
        }
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&payload);
        if connection.stdin.write_all(&frame).and_then(|()| connection.stdin.flush()).is_err() {
            return Err(WorkerError::new("Content worker is unavailable"));
        }
        let started = Instant::now();
        let outcome = match connection.replies.recv_timeout(request.timeout) {
            Ok(outcome) => outcome,
            Err(RecvTimeoutError::Timeout) => {
                log::warn!(
                    "edit-content worker command={} timed out after {:.1}s; worker stderr tail: {}",
                    request.command,
                    started.elapsed().as_secs_f32(),
                    last_chars(&tail_text(&connection.stderr_tail), 2048)
                );
                kill(connection);
                return Err(WorkerError::with_code("Content worker command timed out", &format!("{}_TIMEOUT", request.command.to_uppercase())));
            }
            Err(RecvTimeoutError::Disconnected) => Err("reply channel closed".to_owned()),
        };
        log::info!("edit-content worker command={} elapsed_ms={}", request.command, started.elapsed().as_millis());
        let reply = match outcome {
            Ok(reply) => reply,
            Err(reason) => {
                log::warn!(
                    "edit-content worker command={} ended unexpectedly ({reason}); worker stderr tail: {}",
                    request.command,
                    last_chars(&tail_text(&connection.stderr_tail), 2048)
                );
                let code = if request.command == "open" { "ENGINE_START_FAILED" } else { "ENGINE_UNAVAILABLE" };
                return Err(WorkerError::with_code("Content worker is unavailable", code));
            }
        };
        let text_of = |key: &str| reply.get(key).and_then(Value::as_str).map(str::to_owned);
        if text_of("schemaVersion").as_deref() != Some(request.response_schema)
            || text_of("requestId").as_deref() != Some(request_id.as_str())
            || text_of("sessionId").as_deref() != Some(connection.session_id.as_str())
        {
            kill(connection);
            return Err(WorkerError::new("Content worker returned an invalid reply"));
        }
        Ok(reply)
    }

    /// The staged candidate the worker named, proven to belong to this worker.
    fn resolve_candidate(&self, token: &str) -> Result<PathBuf, WorkerError> {
        let (session_id, pid) = {
            let slot = self.slot();
            match (&slot.connection, &slot.session_id) {
                (Some(connection), Some(session)) => (session.clone(), connection.child.id()),
                _ => return Err(WorkerError::new("Content worker is unavailable")),
            }
        };
        let expected = json!({
            "schema": "edit-content-workspace/v1",
            "owner": "edit-content-engine",
            "sessionId": session_id,
            "processId": pid,
        });
        let mut matches = Vec::new();
        if let Ok(listing) = fs::read_dir(&self.config.workspace_root) {
            for entry in listing.flatten() {
                if !entry.file_name().to_string_lossy().starts_with("edit-content-") {
                    continue;
                }
                let directory = entry.path();
                let marker = directory.join(".owner.json");
                let is_link = |p: &Path| fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(true);
                if is_link(&directory) || is_link(&marker) {
                    continue;
                }
                let owner: Option<Value> = fs::read_to_string(&marker).ok().and_then(|text| serde_json::from_str(&text).ok());
                if owner.as_ref() != Some(&expected) {
                    continue;
                }
                let candidate = directory.join("staging").join(format!("{token}.pdf"));
                if candidate.is_file() && !is_link(&candidate) {
                    matches.push(candidate);
                }
            }
        }
        if matches.len() != 1 {
            self.terminate();
            return Err(WorkerError::new("Content candidate ownership could not be proven"));
        }
        Ok(matches.remove(0))
    }
}

struct Request {
    command: &'static str,
    expected_revision: Option<i64>,
    timeout: Duration,
    request_id: Option<String>,
    target_id: Option<String>,
    payload: Option<Value>,
    response_schema: &'static str,
}

impl Request {
    fn new(command: &'static str, expected_revision: Option<i64>, timeout: Duration) -> Self {
        Self { command, expected_revision, timeout, request_id: None, target_id: None, payload: None, response_schema: REPLY_SCHEMA }
    }
}

fn running(slot: &mut Slot) -> bool {
    slot.connection.as_mut().is_some_and(|connection| matches!(connection.child.try_wait(), Ok(None)))
}

fn kill(connection: &mut Connection) {
    if matches!(connection.child.try_wait(), Ok(None)) {
        let _ = connection.child.kill();
    }
    let _ = connection.child.wait();
}

fn terminate_locked(slot: &mut Slot) {
    if let Some(connection) = slot.connection.as_mut() {
        kill(connection);
    }
    clear(slot);
}

/// Drops the connection (closing its pipes) and keeps the diagnostics.
fn clear(slot: &mut Slot) {
    if let Some(mut connection) = slot.connection.take() {
        kill(&mut connection);
        slot.last_stderr = tail_text(&connection.stderr_tail);
    }
}

fn tail_text(tail: &Mutex<VecDeque<u8>>) -> String {
    let bytes: Vec<u8> = tail.lock().unwrap_or_else(|p| p.into_inner()).iter().copied().collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn last_chars(text: &str, count: usize) -> String {
    let skip = text.chars().count().saturating_sub(count);
    text.chars().skip(skip).collect()
}

fn read_exact_or_end(stream: &mut impl Read, length: usize) -> Option<Vec<u8>> {
    let mut data = vec![0_u8; length];
    stream.read_exact(&mut data).ok()?;
    Some(data)
}

fn read_replies(mut stdout: impl Read, sender: SyncSender<ReplyMessage>) {
    loop {
        let Some(header) = read_exact_or_end(&mut stdout, 4) else {
            let _ = sender.try_send(Err("end of stream".into()));
            return;
        };
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        if length == 0 || length > MAX_REPLY_BYTES {
            let _ = sender.try_send(Err("invalid frame length".into()));
            return;
        }
        let Some(payload) = read_exact_or_end(&mut stdout, length) else {
            let _ = sender.try_send(Err("end of stream".into()));
            return;
        };
        match serde_json::from_slice::<Value>(&payload) {
            Ok(reply) if reply.is_object() => {
                if sender.send(Ok(reply)).is_err() {
                    return;
                }
            }
            _ => {
                let _ = sender.try_send(Err("invalid reply".into()));
                return;
            }
        }
    }
}

fn drain_stderr(mut stderr: impl Read, tail: Arc<Mutex<VecDeque<u8>>>) {
    let mut chunk = [0_u8; 4096];
    while let Ok(read) = stderr.read(&mut chunk) {
        if read == 0 {
            return;
        }
        let mut tail = tail.lock().unwrap_or_else(|p| p.into_inner());
        tail.extend(&chunk[..read]);
        while tail.len() > STDERR_TAIL_BYTES {
            tail.pop_front();
        }
    }
}
