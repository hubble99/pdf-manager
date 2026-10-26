//! Live Edit Content sessions, request outcomes and cancellation.
//!
//! At most two sessions are live at once. A window that was reloaded or
//! crashed never closes its private session, so the least recently used idle
//! session is closed to make room; its committed history stays on disk and the
//! session is recovered if it is asked for again.

use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::coordinator::{CoordFailure, OpenFailure, SessionCoordinator, Status, UNSUPPORTED_STRUCTURE};
use super::diagnose::failure_message;
use super::protocol::{duplicate, reply, safe_error};
use super::state::Publication;
use super::store::CommitStore;
use super::worker::LaunchConfig;
use super::EditError;

pub const MAX_ACTIVE_SESSIONS: usize = 2;
const STOP_TIMEOUT: Duration = Duration::from_secs(12);

/// A requested session is absent or cannot safely continue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    NotFound,
    /// Recovery could not be verified, so nothing may continue on it.
    Unknown,
}

impl Unavailable {
    pub fn message(self) -> &'static str {
        match self {
            Self::NotFound => "Content session was not found.",
            Self::Unknown => "Content recovery could not be verified.",
        }
    }
}

pub type ConfigFactory = Box<dyn Fn() -> Result<Arc<LaunchConfig>, EditError> + Send + Sync>;

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Arc<SessionCoordinator>>,
    outcomes: HashMap<String, HashMap<String, Value>>,
    in_flight: HashMap<(String, String), Arc<AtomicBool>>,
    closing: HashSet<String>,
    closed: HashSet<String>,
    last_used: HashMap<String, Instant>,
    /// Sessions being created; they hold a slot before they are live.
    opening: usize,
    shutting_down: bool,
}

pub struct SessionRegistry {
    config: ConfigFactory,
    storage_root: PathBuf,
    inner: Mutex<Inner>,
    idle: Condvar,
    close_lock: Mutex<()>,
}

pub struct Opened {
    pub coordinator: Arc<SessionCoordinator>,
    pub inspected: Value,
}

fn generic_failure(request_id: &str, session_id: &str, revision: i64, result: Value) -> Value {
    reply(
        request_id,
        session_id,
        "rejected",
        revision,
        result,
        Some(UNSUPPORTED_STRUCTURE),
        Some("Edit Content could not complete this request safely."),
    )
}

impl SessionRegistry {
    pub fn new(config: ConfigFactory, storage_root: PathBuf) -> Self {
        Self { config, storage_root, inner: Mutex::new(Inner::default()), idle: Condvar::new(), close_lock: Mutex::new(()) }
    }

    pub fn storage_root(&self) -> &Path {
        &self.storage_root
    }

    fn guard(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Closes the least recently used session that has no running request.
    fn evict_stalest_idle(&self) {
        let victim = {
            let inner = self.guard();
            if inner.sessions.len() + inner.opening < MAX_ACTIVE_SESSIONS {
                return;
            }
            let busy: HashSet<&String> = inner.in_flight.keys().map(|(session, _)| session).collect();
            inner
                .sessions
                .keys()
                .filter(|id| !busy.contains(id) && !inner.closing.contains(*id))
                .min_by_key(|id| inner.last_used.get(*id).copied())
                .cloned()
        };
        if let Some(victim) = victim {
            if self.close(&victim).is_err() {
                log::warn!("edit-content could not evict idle session");
            }
        }
    }

    pub fn open(&self, source: &Path) -> Result<Opened, OpenFailure> {
        let unavailable = || OpenFailure::Engine { code: "ENGINE_UNAVAILABLE".to_owned() };
        self.evict_stalest_idle();
        {
            let mut inner = self.guard();
            if inner.shutting_down || inner.sessions.len() + inner.opening >= MAX_ACTIVE_SESSIONS {
                return Err(unavailable());
            }
            inner.opening += 1;
        }
        let session_id = uuid::Uuid::new_v4().simple().to_string();
        let built = (|| {
            let config = (self.config)().map_err(|_| unavailable())?;
            let coordinator = SessionCoordinator::create(&config, &self.storage_root, source, &session_id)?;
            match coordinator.inspect(None, None, None, None) {
                Ok(inspected) => Ok((coordinator, inspected)),
                Err(failure) => {
                    coordinator.close();
                    Err(match failure {
                        CoordFailure::Coordinator { reason, .. } if failure_message(&reason).is_some() => OpenFailure::File { code: reason },
                        _ => unavailable(),
                    })
                }
            }
        })();
        let mut inner = self.guard();
        inner.opening -= 1;
        let (coordinator, inspected) = built?;
        if inner.shutting_down {
            drop(inner);
            coordinator.close();
            return Err(unavailable());
        }
        let coordinator = Arc::new(coordinator);
        inner.sessions.insert(session_id.clone(), Arc::clone(&coordinator));
        inner.outcomes.insert(session_id.clone(), HashMap::new());
        inner.last_used.insert(session_id, Instant::now());
        Ok(Opened { coordinator, inspected })
    }

    pub fn get(&self, session_id: &str) -> Result<Arc<SessionCoordinator>, Unavailable> {
        let mut inner = self.guard();
        self.get_locked(&mut inner, session_id)
    }

    fn get_locked(&self, inner: &mut Inner, session_id: &str) -> Result<Arc<SessionCoordinator>, Unavailable> {
        if inner.shutting_down || inner.closing.contains(session_id) || inner.closed.contains(session_id) {
            return Err(Unavailable::NotFound);
        }
        if let Some(coordinator) = inner.sessions.get(session_id) {
            let coordinator = Arc::clone(coordinator);
            inner.last_used.insert(session_id.to_owned(), Instant::now());
            return Ok(coordinator);
        }
        let root = self.recovery_root(session_id)?;
        if inner.sessions.len() + inner.opening >= MAX_ACTIVE_SESSIONS {
            return Err(Unavailable::NotFound);
        }
        let config = (self.config)().map_err(|_| Unavailable::Unknown)?;
        let coordinator = Arc::new(SessionCoordinator::reopen(&config, &root, session_id).map_err(|_| Unavailable::Unknown)?);
        inner.sessions.insert(session_id.to_owned(), Arc::clone(&coordinator));
        inner.outcomes.insert(session_id.to_owned(), HashMap::new());
        inner.last_used.insert(session_id.to_owned(), Instant::now());
        Ok(coordinator)
    }

    /// API session ids are server-generated capabilities, never file paths.
    fn recovery_root(&self, session_id: &str) -> Result<PathBuf, Unavailable> {
        let well_formed = session_id.len() == 32 && session_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !well_formed {
            return Err(Unavailable::NotFound);
        }
        let root = self.storage_root.join(session_id);
        if root.is_dir() {
            Ok(root)
        } else {
            Err(Unavailable::NotFound)
        }
    }

    /// The bytes of a published output. Committed outputs outlive workers,
    /// normal close and app restarts.
    pub fn output_bytes(&self, session_id: &str, output_id: &str) -> Result<(Vec<u8>, Publication), EditError> {
        let inner = self.guard();
        let (path, publication) = match inner.sessions.get(session_id) {
            Some(coordinator) => coordinator.verified_output(output_id)?,
            None => {
                let root = self.recovery_root(session_id).map_err(|_| EditError::rejected("session was not found"))?;
                let store = CommitStore::recover(&root, session_id)?;
                let found = store.verified_output(output_id);
                store.close();
                found?
            }
        };
        let bytes = std::fs::read(&path)?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        if bytes.len() as i64 != publication.byte_size || digest != publication.artifact_hash {
            return Err(EditError::unknown("published bytes changed"));
        }
        Ok((bytes, publication))
    }

    /// Runs one request against a session and records its outcome so a retry
    /// of the same request id returns it instead of replaying.
    pub fn run(
        &self,
        session_id: &str,
        request_id: &str,
        operation: impl FnOnce(&SessionCoordinator, &dyn Fn() -> bool) -> Result<Value, CoordFailure>,
    ) -> Value {
        let key = (session_id.to_owned(), request_id.to_owned());
        let (coordinator, cancelled) = {
            // Admission and shutdown share one lock: no request can enter after
            // shutdown has taken its cancellation snapshot.
            let mut inner = self.guard();
            let coordinator = match self.get_locked(&mut inner, session_id) {
                Ok(coordinator) => coordinator,
                Err(Unavailable::Unknown) => {
                    return reply(request_id, session_id, "unknown", 0, json!({}), None, Some(Unavailable::Unknown.message()));
                }
                Err(Unavailable::NotFound) => {
                    return reply(request_id, session_id, "rejected", 0, json!({}), Some(Unavailable::NotFound.message()), Some(Unavailable::NotFound.message()));
                }
            };
            if let Some(previous) = inner.outcomes.get(session_id).and_then(|outcomes| outcomes.get(request_id)) {
                return duplicate(previous);
            }
            if inner.in_flight.contains_key(&key) {
                drop(inner);
                // Never wait on a coordinator while holding the registry lock;
                // cancellation and completion must remain able to acquire it.
                let revision = coordinator.state(false).map(|state| state.accepted_revision).unwrap_or(0);
                return reply(request_id, session_id, "unknown", revision, json!({}), None, Some("The request outcome is still being established."));
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            inner.in_flight.insert(key.clone(), Arc::clone(&cancelled));
            (coordinator, cancelled)
        };
        let outcome = catch_unwind(AssertUnwindSafe(|| operation(&coordinator, &|| cancelled.load(Ordering::SeqCst))));
        let state = |pending: bool| coordinator.state(pending).ok();
        let reply_value = match outcome {
            Ok(Ok(reply)) => reply,
            Ok(Err(CoordFailure::Coordinator { status, reason })) => {
                let current = state(false);
                let revision = current.as_ref().map_or(0, |s| s.accepted_revision);
                let result = current.as_ref().map_or_else(|| json!({}), |s| json!({ "state": s }));
                let unknown = status == Status::Unknown;
                reply(request_id, session_id, status.as_str(), revision, result, (!unknown).then_some(reason.as_str()), Some(safe_error(&reason)))
            }
            Ok(Err(CoordFailure::Other(EditError::Unknown(_)))) => {
                reply(request_id, session_id, "unknown", 0, json!({}), None, Some("The request outcome could not be established."))
            }
            Ok(Err(CoordFailure::Other(_))) | Err(_) => {
                let current = state(false);
                let revision = current.as_ref().map_or(0, |s| s.accepted_revision);
                let result = current.as_ref().map_or_else(|| json!({}), |s| json!({ "state": s }));
                generic_failure(request_id, session_id, revision, result)
            }
        };
        let mut inner = self.guard();
        inner.outcomes.entry(session_id.to_owned()).or_default().insert(request_id.to_owned(), reply_value.clone());
        inner.in_flight.remove(&key);
        self.idle.notify_all();
        reply_value
    }

    /// True when a running request of that id was told to stop.
    pub fn cancel(&self, session_id: &str, request_id: &str) -> Result<bool, Unavailable> {
        self.get(session_id)?;
        let inner = self.guard();
        Ok(match inner.in_flight.get(&(session_id.to_owned(), request_id.to_owned())) {
            Some(event) => {
                event.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        })
    }

    pub fn close(&self, session_id: &str) -> Result<(), CloseError> {
        let _serial = self.close_lock.lock().unwrap_or_else(|p| p.into_inner());
        let coordinator = {
            let mut inner = self.guard();
            let coordinator = inner.sessions.get(session_id).cloned().ok_or(CloseError::NotFound)?;
            inner.closing.insert(session_id.to_owned());
            for ((session, _), event) in &inner.in_flight {
                if session == session_id {
                    event.store(true, Ordering::SeqCst);
                }
            }
            let (guard, timeout) = self
                .idle
                .wait_timeout_while(inner, STOP_TIMEOUT, |inner| inner.in_flight.keys().any(|(session, _)| session == session_id))
                .unwrap_or_else(|p| p.into_inner());
            if timeout.timed_out() {
                drop(guard);
                return Err(CloseError::Busy);
            }
            coordinator
        };
        // Ownership is kept until close has run, so shutdown can retry after a
        // failure without losing the worker.
        coordinator.close();
        let mut inner = self.guard();
        inner.sessions.remove(session_id);
        inner.outcomes.remove(session_id);
        inner.last_used.remove(session_id);
        inner.closing.remove(session_id);
        inner.closed.insert(session_id.to_owned());
        self.idle.notify_all();
        Ok(())
    }

    /// Cancels active requests and closes every worker without deleting
    /// committed stores. Returns how many sessions were closed.
    pub fn close_all(&self) -> Result<usize, CloseError> {
        let events: Vec<Arc<AtomicBool>> = {
            let mut inner = self.guard();
            inner.shutting_down = true;
            inner.in_flight.values().cloned().collect()
        };
        for event in events {
            event.store(true, Ordering::SeqCst);
        }
        let ids: Vec<String> = {
            let inner = self.guard();
            let (inner, timeout) = self.idle.wait_timeout_while(inner, STOP_TIMEOUT, |inner| !inner.in_flight.is_empty()).unwrap_or_else(|p| p.into_inner());
            if timeout.timed_out() {
                return Err(CloseError::Busy);
            }
            inner.sessions.keys().cloned().collect()
        };
        let mut closed = 0;
        let mut failed = false;
        for id in ids {
            match self.close(&id) {
                Ok(()) => closed += 1,
                Err(CloseError::NotFound) => {}
                Err(_) => failed = true,
            }
        }
        if failed {
            return Err(CloseError::Busy);
        }
        Ok(closed)
    }

    pub fn live_sessions(&self) -> usize {
        self.guard().sessions.len()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseError {
    NotFound,
    /// Requests did not stop in time.
    Busy,
}
