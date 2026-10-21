//! Background jobs with progress and cancellation.
//!
//! Every long operation runs on its own thread so the UI never blocks. The
//! work function receives a [`JobContext`]: it calls `check_cancelled()` between
//! units of work (a page, an image, a chunk) and `report()` to publish progress.
//! The runner knows nothing about Tauri; the app passes in a progress sink and a
//! completion callback that turn these into window events.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{CoreError, CoreResult};

pub type JobId = u64;

/// Shared flag set by the UI and polled by the work function.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// `Err(CoreError::Cancelled)` once cancelled, so work can use `?`.
    pub fn check(&self) -> CoreResult<()> {
        if self.is_cancelled() {
            Err(CoreError::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Short machine-readable step name, e.g. `"hashing"` or `"page"`.
    pub stage: String,
    pub done: u64,
    /// `None` when the amount of work is not known up front.
    pub total: Option<u64>,
}

/// Receives `(job id, progress)`. Called on the job's thread.
pub type ProgressSink = Arc<dyn Fn(JobId, &Progress) + Send + Sync>;

/// Minimum gap between two progress reports of the same stage. Keeps the IPC
/// channel quiet when a job reports thousands of small steps.
pub const DEFAULT_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

pub struct JobContext {
    id: JobId,
    cancel: CancelToken,
    sink: Option<ProgressSink>,
    min_interval: Duration,
    last: Mutex<Option<(Instant, String)>>,
}

impl JobContext {
    pub fn new(id: JobId, cancel: CancelToken, sink: Option<ProgressSink>) -> Self {
        Self {
            id,
            cancel,
            sink,
            min_interval: DEFAULT_PROGRESS_INTERVAL,
            last: Mutex::new(None),
        }
    }

    /// A context with no progress sink, for running an operation inline
    /// (tests, or a caller that does not need events).
    pub fn detached() -> Self {
        Self::new(0, CancelToken::new(), None)
    }

    /// The runner's id for this job; 0 for a detached context.
    pub fn id(&self) -> JobId {
        self.id
    }

    pub fn with_min_interval(mut self, interval: Duration) -> Self {
        self.min_interval = interval;
        self
    }

    pub fn cancel_token(&self) -> &CancelToken {
        &self.cancel
    }

    pub fn check_cancelled(&self) -> CoreResult<()> {
        self.cancel.check()
    }

    /// Publishes progress. Reports are throttled, except that a new stage and
    /// the final step (`done == total`) are always delivered.
    pub fn report(&self, stage: &str, done: u64, total: Option<u64>) {
        let Some(sink) = &self.sink else { return };
        let now = Instant::now();
        {
            let mut last = lock(&self.last);
            let finished = total == Some(done);
            let due = match last.as_ref() {
                None => true,
                Some((at, last_stage)) => {
                    last_stage != stage || finished || now.duration_since(*at) >= self.min_interval
                }
            };
            if !due {
                return;
            }
            *last = Some((now, stage.to_owned()));
        }
        sink(self.id, &Progress {
            stage: stage.to_owned(),
            done,
            total,
        });
    }
}

/// How a job ended. Serialized with a `status` tag for the frontend.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum JobOutcome<T> {
    Succeeded { result: T },
    Failed { error: CoreError },
    Cancelled,
}

impl<T> From<CoreResult<T>> for JobOutcome<T> {
    fn from(res: CoreResult<T>) -> Self {
        match res {
            Ok(result) => JobOutcome::Succeeded { result },
            Err(CoreError::Cancelled) => JobOutcome::Cancelled,
            Err(error) => JobOutcome::Failed { error },
        }
    }
}

/// Starts jobs on background threads and keeps their cancel tokens.
#[derive(Clone, Default)]
pub struct JobRunner {
    active: Arc<Mutex<HashMap<JobId, CancelToken>>>,
    next_id: Arc<AtomicU64>,
}

impl JobRunner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Runs `work` on a new thread and calls `on_done` on that thread when it
    /// ends. A panic inside `work` is reported as `CoreError::Internal`.
    pub fn spawn<T, F, D>(
        &self,
        kind: &str,
        sink: Option<ProgressSink>,
        work: F,
        on_done: D,
    ) -> CoreResult<JobId>
    where
        T: Send + 'static,
        F: FnOnce(&JobContext) -> CoreResult<T> + Send + 'static,
        D: FnOnce(JobId, JobOutcome<T>) + Send + 'static,
    {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let token = CancelToken::new();
        lock(&self.active).insert(id, token.clone());

        let active = Arc::clone(&self.active);
        let spawned = thread::Builder::new()
            .name(format!("dokuwu-{kind}-{id}"))
            .spawn(move || {
                let ctx = JobContext::new(id, token, sink);
                let result = catch_unwind(AssertUnwindSafe(|| work(&ctx)))
                    .unwrap_or_else(|panic| Err(CoreError::Internal(panic_message(&panic))));
                // Unregister first so a late cancel() reports false.
                lock(&active).remove(&id);
                on_done(id, result.into());
            });

        match spawned {
            Ok(_) => Ok(id),
            Err(err) => {
                lock(&self.active).remove(&id);
                Err(CoreError::Internal(format!("cannot start job thread: {err}")))
            }
        }
    }

    /// Requests cancellation. Returns false when the job is unknown or already
    /// finished. The job stops at its next `check_cancelled()`.
    pub fn cancel(&self, id: JobId) -> bool {
        match lock(&self.active).get(&id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    pub fn cancel_all(&self) {
        for token in lock(&self.active).values() {
            token.cancel();
        }
    }

    pub fn active_jobs(&self) -> usize {
        lock(&self.active).len()
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panicking job must not take the runner down with it.
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn panic_message(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        format!("job panicked: {s}")
    } else if let Some(s) = panic.downcast_ref::<String>() {
        format!("job panicked: {s}")
    } else {
        "job panicked".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn collecting_sink() -> (ProgressSink, Arc<Mutex<Vec<Progress>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = Arc::clone(&seen);
        let sink: ProgressSink = Arc::new(move |_, p: &Progress| seen2.lock().unwrap().push(p.clone()));
        (sink, seen)
    }

    #[test]
    fn report_throttles_but_keeps_stage_changes_and_final_step() {
        let (sink, seen) = collecting_sink();
        let ctx = JobContext::new(1, CancelToken::new(), Some(sink))
            .with_min_interval(Duration::from_secs(3600));
        for i in 0..=100 {
            ctx.report("a", i, Some(100));
        }
        ctx.report("b", 0, None);
        let seen = seen.lock().unwrap();
        let steps: Vec<_> = seen.iter().map(|p| (p.stage.as_str(), p.done)).collect();
        assert_eq!(steps, vec![("a", 0), ("a", 100), ("b", 0)]);
    }

    #[test]
    fn successful_job_reports_result_and_unregisters() {
        let runner = JobRunner::new();
        let (tx, rx) = mpsc::channel();
        let id = runner
            .spawn("t", None, |_| Ok(42), move |id, out| tx.send((id, out)).unwrap())
            .unwrap();
        let (done_id, outcome) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(done_id, id);
        assert!(matches!(outcome, JobOutcome::Succeeded { result: 42 }));
        assert_eq!(runner.active_jobs(), 0);
        assert!(!runner.cancel(id));
    }

    #[test]
    fn cancel_stops_a_running_job() {
        let runner = JobRunner::new();
        let (started_tx, started_rx) = mpsc::channel();
        let (tx, rx) = mpsc::channel();
        let id = runner
            .spawn(
                "loop",
                None,
                move |ctx| {
                    started_tx.send(()).unwrap();
                    loop {
                        ctx.check_cancelled()?;
                        thread::sleep(Duration::from_millis(1));
                    }
                    #[allow(unreachable_code)]
                    Ok(())
                },
                move |_, out| tx.send(out).unwrap(),
            )
            .unwrap();
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(runner.cancel(id));
        let outcome = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(outcome, JobOutcome::Cancelled));
    }

    #[test]
    fn panic_becomes_internal_error() {
        let runner = JobRunner::new();
        let (tx, rx) = mpsc::channel();
        runner
            .spawn::<(), _, _>("boom", None, |_| panic!("kaboom"), move |_, out| tx.send(out).unwrap())
            .unwrap();
        match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
            JobOutcome::Failed { error } => {
                assert_eq!(error.code(), "internal");
                assert!(error.to_string().contains("kaboom"));
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
        assert_eq!(runner.active_jobs(), 0);
    }

    #[test]
    fn job_ids_are_unique() {
        let runner = JobRunner::new();
        let (tx, rx) = mpsc::channel();
        let mut ids = Vec::new();
        for _ in 0..4 {
            let tx = tx.clone();
            ids.push(runner.spawn("n", None, |_| Ok(()), move |_, _| tx.send(()).unwrap()).unwrap());
        }
        for _ in 0..4 {
            rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn outcome_serializes_with_status_tag() {
        let ok: JobOutcome<u32> = Ok(7).into();
        let cancelled: JobOutcome<u32> = Err(CoreError::Cancelled).into();
        let failed: JobOutcome<u32> = Err(CoreError::Unsupported("x".into())).into();
        assert_eq!(serde_json::to_value(ok).unwrap(), serde_json::json!({"status": "succeeded", "result": 7}));
        assert_eq!(serde_json::to_value(cancelled).unwrap(), serde_json::json!({"status": "cancelled"}));
        let failed = serde_json::to_value(failed).unwrap();
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["error"]["code"], "unsupported");
    }
}
