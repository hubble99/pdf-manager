//! A small worker pool for per-file jobs.
//!
//! Workers pull the next input from a shared counter, so at most `workers`
//! files are in memory at once, whatever the batch size. A file that fails
//! does not stop the others; cancelling stops before the next file.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;

/// Runs `process` for every input on `workers` threads and returns one result
/// per input, in input order.
///
/// - `process` returns `Err(Cancelled)` to abort the whole batch; any other
///   error is turned into a result by `on_error`.
/// - Progress is reported as `stage`, files finished out of total.
/// - If the job is cancelled, the call returns `Err(Cancelled)` and results of
///   files already finished are dropped (their outputs stay on disk).
pub(crate) fn run_pool<T, P, E>(
    inputs: &[PathBuf],
    workers: usize,
    ctx: &JobContext,
    stage: &str,
    process: P,
    on_error: E,
) -> CoreResult<Vec<T>>
where
    T: Send,
    P: Fn(&Path) -> CoreResult<T> + Sync,
    E: Fn(&Path, CoreError) -> T + Sync,
{
    let total = inputs.len() as u64;
    ctx.report(stage, 0, Some(total));

    let workers = workers.clamp(1, inputs.len().max(1));
    let next = AtomicUsize::new(0);
    let done = AtomicU64::new(0);
    let cancelled = AtomicBool::new(false);
    let slots: Vec<Mutex<Option<T>>> = inputs.iter().map(|_| Mutex::new(None)).collect();

    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if cancelled.load(Ordering::SeqCst) || ctx.check_cancelled().is_err() {
                    cancelled.store(true, Ordering::SeqCst);
                    return;
                }
                let index = next.fetch_add(1, Ordering::SeqCst);
                let Some(source) = inputs.get(index) else {
                    return;
                };
                let entry = match process(source) {
                    Ok(entry) => entry,
                    Err(err) if err.is_cancelled() => {
                        cancelled.store(true, Ordering::SeqCst);
                        return;
                    }
                    Err(err) => on_error(source, err),
                };
                *slots[index].lock().unwrap_or_else(|e| e.into_inner()) = Some(entry);
                let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                ctx.report(stage, finished, Some(total));
            });
        }
    });

    if cancelled.load(Ordering::SeqCst) {
        return Err(CoreError::Cancelled);
    }

    slots
        .into_iter()
        .zip(inputs)
        .map(|(slot, source)| {
            Ok(slot
                .into_inner()
                .unwrap_or_else(|e| e.into_inner())
                .unwrap_or_else(|| {
                    on_error(source, CoreError::Internal("file was not processed".into()))
                }))
        })
        .collect()
}
