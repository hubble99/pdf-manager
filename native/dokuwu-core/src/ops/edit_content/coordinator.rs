//! One Edit Content session: the sole authority for accepted revision,
//! history and publication state.
//!
//! The coordinator owns the worker adapter and the commit store of a session.
//! The worker only ever *prepares* a candidate on a private copy; nothing it
//! says becomes accepted until the store has verified the candidate and
//! switched the commit record. A worker that dies or times out before that
//! point cannot have crossed the commit, so the accepted document is unchanged
//! and a fresh worker is started on the committed checkpoint.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};

use super::diagnose::diagnose_rejected_source;
use super::identity;
use super::state::{Checkpoint, EditMetadata, Outcome, SessionState, REQUIRED_CHECKS, STALE_REVISION_MESSAGE, VERIFIER_POLICY};
use super::store::{file_hash, CommitStore, TxRequest};
use super::worker::{LaunchConfig, PreparedArtifactLease, WorkerAdapter};
use super::EditError;

pub const STALE_REVISION: &str = "REJECTED_STALE_REVISION";
pub const UNSUPPORTED_STRUCTURE: &str = "REJECTED_UNSUPPORTED_STRUCTURE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Rejected,
    Stale,
    Unknown,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Rejected => "rejected",
            Status::Stale => "stale",
            Status::Unknown => "unknown",
        }
    }
}

/// A failure of a session operation. `Coordinator` is a classified outcome the
/// reply can state; `Other` is anything else (worker, storage), which the
/// registry reports as a generic refusal.
#[derive(Debug)]
pub enum CoordFailure {
    Coordinator { status: Status, reason: String },
    Other(EditError),
}

impl CoordFailure {
    pub fn coordinator(status: Status, reason: impl Into<String>) -> Self {
        Self::Coordinator { status, reason: reason.into() }
    }
}

impl From<EditError> for CoordFailure {
    fn from(error: EditError) -> Self {
        Self::Other(error)
    }
}

impl From<super::worker::WorkerError> for CoordFailure {
    fn from(error: super::worker::WorkerError) -> Self {
        Self::Other(error.into())
    }
}

impl std::fmt::Display for CoordFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Coordinator { reason, .. } => f.write_str(reason),
            Self::Other(error) => error.fmt(f),
        }
    }
}

pub type CoordResult<T> = Result<T, CoordFailure>;

/// Why a document could not be opened, in the vocabulary of the open dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenFailure {
    /// The file itself is the problem; `code` is `PDF_ENCRYPTED`,
    /// `PDF_UNREADABLE` or `REJECTED_UNSUPPORTED_STRUCTURE`.
    File { code: String },
    /// The engine could not be used; `code` is a worker failure class.
    Engine { code: String },
}

/// The accepted state of a session as the frontend sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub session_id: String,
    pub accepted_revision: i64,
    pub checkpoint_id: String,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub saved_hash: String,
    pub last_output_id: Option<String>,
}

pub struct SessionCoordinator {
    adapter: WorkerAdapter,
    store: CommitStore,
    lock: Mutex<()>,
}

impl SessionCoordinator {
    fn new(adapter: WorkerAdapter, store: CommitStore) -> Self {
        Self { adapter, store, lock: Mutex::new(()) }
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Starts a worker on `source`, inspects it and creates the session store.
    /// Opening is read-only and idempotent, so one automatic retry on a worker
    /// start, open or inspect failure is safe. A document the engine rejected
    /// is never retried.
    pub fn create(
        config: &Arc<LaunchConfig>,
        storage_parent: &Path,
        source: &Path,
        session_id: &str,
    ) -> Result<Self, OpenFailure> {
        let engine = |code: &str| OpenFailure::Engine { code: code.to_owned() };
        let mut attempt = 1;
        let (adapter, opened, inspected) = loop {
            let adapter = WorkerAdapter::new(Arc::clone(config));
            let attempted = (|| {
                adapter.start(source, Some(session_id), 0)?;
                let opened = adapter.open()?;
                let inspected = adapter.inspect()?;
                Ok::<_, super::worker::WorkerError>((opened, inspected))
            })();
            match attempted {
                Ok((opened, inspected)) => break (adapter, opened, inspected),
                Err(error) => {
                    adapter.terminate();
                    adapter.discard_inspection_cache();
                    if attempt == 2 {
                        return Err(engine(&error.code));
                    }
                    log::warn!("edit-content open failed ({}); retrying once", error.code);
                    attempt += 1;
                }
            }
        };
        let mut store = None;
        let built = (|| -> Result<Self, OpenFailure> {
            let accepted = |reply: &Value| reply.get("status").and_then(Value::as_str) == Some("accepted");
            if !accepted(&opened) || !accepted(&inspected) {
                return Err(OpenFailure::File { code: diagnose_rejected_source(source).to_owned() });
            }
            let result = opened.get("result").cloned().unwrap_or(Value::Null);
            let digest = result.get("sourceSha256").and_then(Value::as_str).map(str::to_owned);
            let size = result.get("sourceBytes").and_then(Value::as_i64);
            let census = object_census(&inspected).map_err(|_| OpenFailure::File { code: UNSUPPORTED_STRUCTURE.to_owned() })?;
            let actual = file_hash(source).ok();
            let actual_size = std::fs::metadata(source).map(|m| m.len() as i64).ok();
            let (Some(digest), Some(size)) = (digest, size) else { return Err(engine("ENGINE_UNAVAILABLE")) };
            if actual.as_deref() != Some(digest.as_str()) || actual_size != Some(size) {
                return Err(engine("ENGINE_UNAVAILABLE"));
            }
            let checkpoint = Checkpoint {
                checkpoint_id: "source".into(),
                accepted_revision: 0,
                parent_accepted_revision: None,
                parent_checkpoint_id: None,
                source_hash: digest.clone(),
                accepted_artifact_hash: digest,
                byte_size: size,
                object_census: census,
                edit: None,
            };
            std::fs::create_dir_all(storage_parent).map_err(|_| engine("ENGINE_UNAVAILABLE"))?;
            let state = SessionState::initial(session_id, checkpoint).map_err(|_| engine("ENGINE_UNAVAILABLE"))?;
            let created = CommitStore::create(&storage_parent.join(session_id), &state, source).map_err(|_| engine("ENGINE_UNAVAILABLE"))?;
            store = Some(created);
            let coordinator = Self::new(WorkerAdapter::new(Arc::clone(config)), store.take().expect("just set"));
            // The worker that inspected the file is replaced by one on the
            // committed checkpoint, so every later request starts the same way.
            adapter.terminate();
            coordinator.restart_current().map_err(|_| engine("ENGINE_UNAVAILABLE"))?;
            Ok(coordinator)
        })();
        match built {
            Ok(coordinator) => {
                adapter.terminate();
                Ok(coordinator)
            }
            Err(failure) => {
                adapter.terminate();
                adapter.discard_inspection_cache();
                if let Some(store) = &store {
                    store.close();
                }
                Err(failure)
            }
        }
    }

    /// Takes over a session folder that is on disk but not live (evicted).
    pub fn reopen(config: &Arc<LaunchConfig>, store_root: &Path, session_id: &str) -> Result<Self, EditError> {
        let store = CommitStore::recover(store_root, session_id)?;
        let coordinator = Self::new(WorkerAdapter::new(Arc::clone(config)), store);
        match coordinator.ensure_worker() {
            Ok(()) => Ok(coordinator),
            Err(failure) => {
                coordinator.adapter.terminate();
                coordinator.adapter.discard_inspection_cache();
                coordinator.store.close();
                Err(match failure {
                    CoordFailure::Other(error) => error,
                    CoordFailure::Coordinator { reason, .. } => EditError::Unknown(reason),
                })
            }
        }
    }

    pub fn inspect(
        &self,
        request_id: Option<&str>,
        expected_revision: Option<i64>,
        target_id: Option<&str>,
        payload: Option<Value>,
    ) -> CoordResult<Value> {
        let _guard = self.guard();
        self.ensure_worker()?;
        let state = self.store.state()?;
        let revision = expected_revision.unwrap_or(state.revision);
        if revision != state.revision {
            return Err(CoordFailure::coordinator(Status::Stale, STALE_REVISION));
        }
        let reply = if request_id.is_none() && expected_revision.is_none() && target_id.is_none() && payload.is_none() {
            self.adapter.inspect()?
        } else {
            self.adapter.inspect_request(Some(revision), request_id, target_id, payload)?
        };
        checked_read_reply(reply, state.revision)
    }

    /// Read-only dry run of the worker's guards for one proposed edit. It
    /// never creates a candidate or changes accepted state.
    pub fn preflight(&self, request_id: &str, expected_revision: i64, target_id: &str, edit: &Value) -> CoordResult<Value> {
        let _guard = self.guard();
        self.ensure_worker()?;
        let state = self.store.state()?;
        if expected_revision != state.revision {
            return Err(CoordFailure::coordinator(Status::Stale, STALE_REVISION));
        }
        let mut payload = json!({ "operation": "preflight" });
        if let (Some(target), Some(edit)) = (payload.as_object_mut(), edit.as_object()) {
            target.extend(edit.clone());
        }
        let reply = self.adapter.inspect_request(Some(state.revision), Some(request_id), Some(target_id), Some(payload))?;
        if reply.get("acceptedRevision").and_then(Value::as_i64) != Some(state.revision) {
            return Err(CoordFailure::coordinator(Status::Unknown, "Content worker revision could not be established"));
        }
        let status = reply.get("status").and_then(Value::as_str);
        let report = reply.get("result").and_then(|r| r.get("preflight")).filter(|r| r.is_object());
        match (status, report) {
            (Some("accepted" | "rejected" | "stale"), Some(report)) => Ok(report.clone()),
            _ => {
                let reason = reply.get("guardReason").and_then(Value::as_str).unwrap_or(UNSUPPORTED_STRUCTURE);
                let status = if status == Some("stale") { Status::Stale } else { Status::Rejected };
                Err(CoordFailure::coordinator(status, reason))
            }
        }
    }

    pub fn render(&self, request_id: &str, expected_revision: i64, page_index: i64, width_px: i64, height_px: i64) -> CoordResult<Value> {
        let _guard = self.guard();
        self.ensure_worker()?;
        let state = self.store.state()?;
        if expected_revision != state.revision {
            return Err(CoordFailure::coordinator(Status::Stale, STALE_REVISION));
        }
        let reply = self.adapter.render(request_id, expected_revision, page_index, width_px, height_px)?;
        checked_read_reply(reply, state.revision)
    }

    /// Prepares and commits one edit; with `save` the verified result is also
    /// published in the same commit.
    pub fn apply(
        &self,
        request_id: &str,
        expected_revision: i64,
        target_id: &str,
        edit: &Value,
        save: bool,
        cancelled: &dyn Fn() -> bool,
    ) -> CoordResult<Outcome> {
        let operation = if save { "save-with-draft" } else { "apply" };
        let started = Instant::now();
        let _guard = self.guard();
        self.ensure_worker_or_unknown()?;
        let mut prepare = |state: &SessionState, _accepted: &Path| -> Result<(Checkpoint, PathBuf), EditError> {
            let lease = self.adapter.prepare_apply(
                request_id,
                expected_revision,
                target_id,
                &state.current().checkpoint_id,
                &state.current().accepted_artifact_hash,
                edit,
            )?;
            checkpoint_from_preparation(state, operation, &lease)
        };
        let request = TxRequest { request_id, expected_revision, operation, pending_draft: true };
        match self.store.transact(&request, Some(&mut prepare), cancelled) {
            Ok(outcome) => {
                let committed = Instant::now();
                self.restart_after_commit();
                log::info!(
                    "edit-content {operation} accepted prepare_commit_ms={} restart_ms={}",
                    (committed - started).as_millis(),
                    committed.elapsed().as_millis()
                );
                Ok(outcome)
            }
            Err(EditError::Preparation(rejected)) => {
                // The candidate was prepared on a private copy and discarded by
                // the worker, so the accepted document it holds is unchanged.
                // Only an unknown outcome needs a fresh worker.
                let restarted = self.restore_after_failure(!rejected.unknown);
                log::info!(
                    "edit-content {operation} rejected reason={} elapsed_ms={} worker_restarted={restarted}",
                    rejected.reason,
                    started.elapsed().as_millis()
                );
                let status = if rejected.unknown { Status::Unknown } else { Status::Rejected };
                Err(CoordFailure::coordinator(status, rejected.reason))
            }
            Err(EditError::Unknown(reason)) => {
                self.adapter.terminate();
                Err(CoordFailure::coordinator(Status::Unknown, reason))
            }
            Err(other) => {
                // The coordinator is the sole commit authority. If preparation
                // did not return, this request cannot have crossed its commit.
                self.restore_after_failure(false);
                Err(refusal(&other))
            }
        }
    }

    pub fn save(&self, request_id: &str, expected_revision: i64, cancelled: &dyn Fn() -> bool) -> CoordResult<Outcome> {
        self.history_or_save(request_id, expected_revision, "save", cancelled)
    }

    pub fn undo(&self, request_id: &str, expected_revision: i64, pending_draft: bool, cancelled: &dyn Fn() -> bool) -> CoordResult<Outcome> {
        if pending_draft {
            return Err(CoordFailure::coordinator(Status::Rejected, "apply or explicitly discard the draft first"));
        }
        self.history_or_save(request_id, expected_revision, "undo", cancelled)
    }

    pub fn redo(&self, request_id: &str, expected_revision: i64, pending_draft: bool, cancelled: &dyn Fn() -> bool) -> CoordResult<Outcome> {
        if pending_draft {
            return Err(CoordFailure::coordinator(Status::Rejected, "apply or explicitly discard the draft first"));
        }
        self.history_or_save(request_id, expected_revision, "redo", cancelled)
    }

    fn history_or_save(&self, request_id: &str, revision: i64, operation: &str, cancelled: &dyn Fn() -> bool) -> CoordResult<Outcome> {
        let _guard = self.guard();
        self.ensure_worker_or_unknown()?;
        let request = TxRequest { request_id, expected_revision: revision, operation, pending_draft: false };
        match self.store.transact(&request, None, cancelled) {
            Ok(outcome) => {
                if operation != "save" {
                    self.restart_after_commit();
                }
                Ok(outcome)
            }
            Err(EditError::Unknown(reason)) => {
                self.adapter.terminate();
                Err(CoordFailure::coordinator(Status::Unknown, reason))
            }
            Err(other) => Err(refusal(&other)),
        }
    }

    pub fn state(&self, pending_draft: bool) -> Result<SessionView, EditError> {
        let _guard = self.guard();
        let state = self.store.state()?;
        Ok(SessionView {
            session_id: state.session_id.clone(),
            accepted_revision: state.revision,
            checkpoint_id: state.current().checkpoint_id.clone(),
            dirty: state.dirty(pending_draft),
            can_undo: state.cursor > 0,
            can_redo: state.cursor + 1 < state.checkpoints.len(),
            saved_hash: state.saved_hash.clone(),
            last_output_id: state.last_output_id.clone(),
        })
    }

    /// The verified file of a published output.
    pub fn verified_output(&self, output_id: &str) -> Result<(PathBuf, super::state::Publication), EditError> {
        self.store.verified_output(output_id)
    }

    pub fn close(&self) {
        let _guard = self.guard();
        let _ = self.adapter.close();
        self.adapter.terminate();
        self.adapter.discard_inspection_cache();
        self.store.close();
    }

    fn ensure_worker_or_unknown(&self) -> CoordResult<()> {
        match self.ensure_worker() {
            Err(CoordFailure::Other(EditError::Unknown(reason))) => {
                self.adapter.terminate();
                Err(CoordFailure::coordinator(Status::Unknown, reason))
            }
            other => other,
        }
    }

    fn ensure_worker(&self) -> CoordResult<()> {
        let state = self.store.state()?;
        if !self.adapter.is_running() {
            self.adapter.start(&self.store.checkpoint_path()?, Some(&state.session_id), state.revision)?;
            let opened = self.adapter.open()?;
            if opened.get("status").and_then(Value::as_str) != Some("accepted")
                || opened.get("acceptedRevision").and_then(Value::as_i64) != Some(state.revision)
            {
                self.adapter.terminate();
                return Err(CoordFailure::coordinator(Status::Unknown, "committed checkpoint could not be reopened"));
            }
        }
        Ok(())
    }

    fn restart_current(&self) -> CoordResult<()> {
        let state = self.store.state()?;
        let reply = self.adapter.restart(Some(&self.store.checkpoint_path()?), Some(state.revision))?;
        if reply.get("status").and_then(Value::as_str) != Some("accepted")
            || reply.get("acceptedRevision").and_then(Value::as_i64) != Some(state.revision)
        {
            self.adapter.terminate();
            return Err(CoordFailure::coordinator(Status::Unknown, "committed checkpoint could not be reopened"));
        }
        Ok(())
    }

    /// The commit already happened; a later call retries from committed bytes.
    fn restart_after_commit(&self) {
        if self.restart_current().is_err() {
            self.adapter.terminate();
        }
    }

    /// True when a replacement worker was started.
    fn restore_after_failure(&self, worker_state_clean: bool) -> bool {
        if worker_state_clean && self.adapter.is_running() {
            return false;
        }
        if self.restart_current().is_err() {
            self.adapter.terminate();
        }
        true
    }
}

/// Turns the worker's preparation reply into a checkpoint, accepting nothing
/// the reply does not prove: the binding to the current checkpoint, every
/// required check, the pinned engine identity and the candidate's bytes.
fn checkpoint_from_preparation(state: &SessionState, operation: &str, lease: &PreparedArtifactLease) -> Result<(Checkpoint, PathBuf), EditError> {
    let response = &lease.response;
    let incomplete = || EditError::rejected("incomplete preparation evidence");
    let result = response.get("result").filter(|r| r.is_object());
    let bound = response.get("status").and_then(Value::as_str) == Some("prepared")
        && response.get("acceptedRevision").and_then(Value::as_i64) == Some(state.revision)
        && result.is_some_and(|r| r.get("acceptedCheckpointId").and_then(Value::as_str) == Some(state.current().checkpoint_id.as_str()));
    if !bound {
        return Err(EditError::rejected("invalid preparation binding"));
    }
    let result = result.expect("checked");
    let object_of = |value: Option<&Value>| value.filter(|v| v.is_object()).cloned().ok_or_else(incomplete);
    let expectation = object_of(result.get("editExpectation"))?;
    let verification = object_of(result.get("verificationResults"))?;
    let engine = object_of(result.get("engineIdentity"))?;
    let verifier = object_of(result.get("verifierIdentity"))?;
    let target = expectation.get("target").filter(|t| t.is_object()).ok_or_else(|| EditError::rejected("preparation verification identity is invalid"))?;
    let checks: Vec<String> = verification
        .get("checks")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(|item| item.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>())
        .and_then(|items| items)
        .ok_or_else(|| EditError::rejected("preparation verification identity is invalid"))?;
    let mut sorted: Vec<&str> = checks.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted.dedup();
    let mut required = REQUIRED_CHECKS.to_vec();
    required.sort_unstable();
    let (sha, build, wrapper) = identity::current()?.verification_identity();
    let baseline = state.current().accepted_artifact_hash.as_str();
    let candidate_hash = result.get("candidateHash").and_then(Value::as_str);
    if sorted != required
        || checks.len() != REQUIRED_CHECKS.len()
        || result.get("baselineHash").and_then(Value::as_str) != Some(baseline)
        || verification.get("baselineHash").and_then(Value::as_str) != Some(baseline)
        || candidate_hash.is_none()
        || candidate_hash != verification.get("candidateHash").and_then(Value::as_str)
        || engine != json!({ "sha256": sha, "build": build, "wrapper": wrapper })
        || verifier != json!({ "policy": VERIFIER_POLICY })
    {
        return Err(EditError::rejected("preparation verification identity is invalid"));
    }
    let int = |value: Option<&Value>| value.and_then(Value::as_i64).ok_or_else(incomplete);
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned).ok_or_else(incomplete);
    let source_scope = target
        .get("objectPath")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(Value::as_i64).collect::<Option<Vec<_>>>())
        .and_then(|items| items)
        .ok_or_else(incomplete)?;
    let metadata = EditMetadata {
        request_id: text(response.get("requestId"))?,
        operation: operation.to_owned(),
        page_index: int(target.get("pageIndex"))?,
        source_scope,
        scalar_start: int(expectation.get("scalarStart"))?,
        scalar_end: int(expectation.get("scalarEnd"))?,
        before_text: text(target.get("text"))?,
        after_text: text(expectation.get("resultingText"))?,
        occurrence_before: int(verification.get("oldOccurrencesBefore"))?,
        occurrence_after: int(verification.get("oldOccurrencesAfter"))?,
        object_delta: int(expectation.get("objectCountDelta"))?,
        baseline_hash: baseline.to_owned(),
        engine_sha256: sha,
        engine_build: build,
        wrapper,
        verifier_policy: VERIFIER_POLICY.to_owned(),
        checks,
    };
    let census = verification
        .get("objectCensus")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(Value::as_i64).collect::<Option<Vec<_>>>())
        .and_then(|items| items)
        .ok_or_else(incomplete)?;
    let checkpoint = Checkpoint {
        checkpoint_id: format!("checkpoint_{}", uuid::Uuid::new_v4().simple()),
        accepted_revision: state.revision + 1,
        parent_accepted_revision: Some(state.revision),
        parent_checkpoint_id: Some(state.current().checkpoint_id.clone()),
        source_hash: state.source.source_hash.clone(),
        accepted_artifact_hash: candidate_hash.expect("checked").to_owned(),
        byte_size: int(result.get("candidateBytes"))?,
        object_census: census,
        edit: Some(metadata),
    };
    checkpoint.validate()?;
    let size = std::fs::metadata(&lease.path).map(|m| m.len() as i64).ok();
    if file_hash(&lease.path).ok().as_deref() != Some(checkpoint.accepted_artifact_hash.as_str()) || size != Some(checkpoint.byte_size) {
        return Err(EditError::rejected("prepared candidate bytes changed"));
    }
    Ok((checkpoint, lease.path.clone()))
}

/// A store refusal as a reply: an older revision is `stale` with its stable code.
fn refusal(error: &EditError) -> CoordFailure {
    match error {
        EditError::Rejected(message) if message == STALE_REVISION_MESSAGE => CoordFailure::coordinator(Status::Stale, STALE_REVISION),
        other => CoordFailure::coordinator(Status::Rejected, other.to_string()),
    }
}

fn checked_read_reply(reply: Value, revision: i64) -> CoordResult<Value> {
    if reply.get("acceptedRevision").and_then(Value::as_i64) != Some(revision) {
        return Err(CoordFailure::coordinator(Status::Unknown, "Content worker revision could not be established"));
    }
    if reply.get("status").and_then(Value::as_str) != Some("accepted") {
        let reason = reply.get("guardReason").and_then(Value::as_str).unwrap_or(UNSUPPORTED_STRUCTURE).to_owned();
        let status = if reply.get("status").and_then(Value::as_str) == Some("stale") { Status::Stale } else { Status::Rejected };
        return Err(CoordFailure::coordinator(status, reason));
    }
    Ok(reply)
}

/// Objects per page (text and view-only), from the worker's discovery.
fn object_census(inspected: &Value) -> Result<Vec<i64>, ()> {
    let discovery = inspected.get("result").and_then(|r| r.get("discovery")).ok_or(())?;
    let pages = discovery.get("pages").and_then(Value::as_array).ok_or(())?;
    let text = discovery.get("textObjects").and_then(Value::as_array).ok_or(())?;
    let opaque = discovery.get("viewOnlyObjects").and_then(Value::as_array).ok_or(())?;
    let mut counts = vec![0_i64; pages.len()];
    for item in text.iter().chain(opaque.iter()) {
        let index = item.get("pageIndex").and_then(Value::as_i64).ok_or(())?;
        let slot = usize::try_from(index).ok().and_then(|i| counts.get_mut(i)).ok_or(())?;
        *slot += 1;
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_census_counts_text_and_view_only_objects_per_page() {
        let inspected = json!({"result": {"discovery": {
            "pages": [{}, {}],
            "textObjects": [{"pageIndex": 0}, {"pageIndex": 1}, {"pageIndex": 1}],
            "viewOnlyObjects": [{"pageIndex": 0}],
        }}});
        assert_eq!(object_census(&inspected), Ok(vec![2, 2]));
        for broken in [
            json!({"result": {"discovery": {"pages": [{}], "textObjects": [{"pageIndex": 3}], "viewOnlyObjects": []}}}),
            json!({"result": {"discovery": {"pages": [{}], "textObjects": [{"pageIndex": -1}], "viewOnlyObjects": []}}}),
            json!({"result": {"discovery": {"pages": [{}], "textObjects": [{}], "viewOnlyObjects": []}}}),
            json!({"result": {"discovery": {"pages": [{}], "textObjects": []}}}),
            json!({}),
        ] {
            assert_eq!(object_census(&broken), Err(()));
        }
    }

    #[test]
    fn read_replies_must_carry_the_accepted_revision() {
        let ok = json!({"status": "accepted", "acceptedRevision": 3});
        assert!(checked_read_reply(ok, 3).is_ok());
        let wrong = json!({"status": "accepted", "acceptedRevision": 2});
        assert!(matches!(checked_read_reply(wrong, 3), Err(CoordFailure::Coordinator { status: Status::Unknown, .. })));
        let stale = json!({"status": "stale", "acceptedRevision": 3, "guardReason": STALE_REVISION});
        assert!(matches!(checked_read_reply(stale, 3), Err(CoordFailure::Coordinator { status: Status::Stale, .. })));
        let rejected = json!({"status": "rejected", "acceptedRevision": 3});
        match checked_read_reply(rejected, 3) {
            Err(CoordFailure::Coordinator { status: Status::Rejected, reason }) => assert_eq!(reason, UNSUPPORTED_STRUCTURE),
            other => panic!("{other:?}"),
        }
    }
}
