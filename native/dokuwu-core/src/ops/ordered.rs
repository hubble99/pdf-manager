//! Ordered parallel pipeline.
//!
//! Workers produce items out of order; the calling thread consumes them in
//! order (to append them to a ZIP or a PDF). A window limits how far workers
//! may run ahead of the consumer, so memory holds at most `window` finished
//! items whatever the number of items.

use std::collections::BTreeMap;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;

struct Shared<T> {
    next: usize,
    written: usize,
    ready: BTreeMap<usize, T>,
    error: Option<CoreError>,
    stop: bool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs `produce` for items `0..count` on `workers` threads and hands the
/// results to `consume` in index order on the calling thread.
///
/// - `init` runs once per worker thread and builds that thread's state (for
///   example a PDF opened by the thread that renders from it).
/// - The first error, from any step, stops the pipeline and is returned.
/// - A cancelled job stops it with `Err(Cancelled)`.
pub(crate) fn run_ordered<S, T, I, P, C>(
    count: usize,
    workers: usize,
    window: usize,
    ctx: &JobContext,
    init: I,
    produce: P,
    mut consume: C,
) -> CoreResult<()>
where
    T: Send,
    I: Fn() -> CoreResult<S> + Sync,
    P: Fn(&mut S, usize) -> CoreResult<T> + Sync,
    C: FnMut(usize, T) -> CoreResult<()>,
{
    let workers = workers.clamp(1, count.max(1));
    let window = window.max(workers);
    let shared = Mutex::new(Shared { next: 0, written: 0, ready: BTreeMap::new(), error: None, stop: false });
    let room = Condvar::new();
    let arrived = Condvar::new();

    let result = thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                let mut state = match init() {
                    Ok(state) => state,
                    Err(err) => {
                        let mut g = lock(&shared);
                        g.error.get_or_insert(err);
                        g.stop = true;
                        arrived.notify_all();
                        room.notify_all();
                        return;
                    }
                };
                loop {
                    let index = {
                        let mut g = lock(&shared);
                        loop {
                            if g.stop || g.next >= count {
                                return;
                            }
                            if g.next - g.written < window {
                                break;
                            }
                            g = room.wait_timeout(g, Duration::from_millis(200)).unwrap_or_else(|e| e.into_inner()).0;
                        }
                        let index = g.next;
                        g.next += 1;
                        index
                    };
                    let outcome = produce(&mut state, index);
                    let mut g = lock(&shared);
                    match outcome {
                        Ok(item) => {
                            g.ready.insert(index, item);
                        }
                        Err(err) => {
                            g.error.get_or_insert(err);
                            g.stop = true;
                            room.notify_all();
                        }
                    }
                    arrived.notify_all();
                }
            });
        }

        // Consumer.
        let mut outcome: CoreResult<()> = Ok(());
        let mut g = lock(&shared);
        'consume: while g.written < count {
            if let Some(err) = g.error.take() {
                outcome = Err(err);
                break;
            }
            if ctx.check_cancelled().is_err() {
                outcome = Err(CoreError::Cancelled);
                break;
            }
            let at = g.written;
            if let Some(item) = g.ready.remove(&at) {
                drop(g);
                if let Err(err) = consume(at, item) {
                    outcome = Err(err);
                    g = lock(&shared);
                    break 'consume;
                }
                g = lock(&shared);
                g.written += 1;
                room.notify_all();
            } else {
                g = arrived.wait_timeout(g, Duration::from_millis(100)).unwrap_or_else(|e| e.into_inner()).0;
            }
        }
        g.stop = true;
        room.notify_all();
        outcome
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn items_arrive_in_order_whatever_the_work_order() {
        let ctx = JobContext::detached();
        let mut seen = Vec::new();
        run_ordered(
            40,
            4,
            6,
            &ctx,
            || Ok(()),
            |_, i| {
                // Early items take longest.
                thread::sleep(Duration::from_millis(((40 - i) % 7) as u64));
                Ok(i * 2)
            },
            |i, v| {
                assert_eq!(v, i * 2);
                seen.push(i);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(seen, (0..40).collect::<Vec<_>>());
    }

    #[test]
    fn workers_never_run_further_ahead_than_the_window() {
        let ctx = JobContext::detached();
        let started = AtomicUsize::new(0);
        let consumed = AtomicUsize::new(0);
        run_ordered(
            60,
            3,
            4,
            &ctx,
            || Ok(()),
            |_, _| {
                let s = started.fetch_add(1, Ordering::SeqCst) + 1;
                assert!(s <= consumed.load(Ordering::SeqCst) + 4 + 3, "ran ahead");
                Ok(())
            },
            |_, _| {
                thread::sleep(Duration::from_millis(1));
                consumed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap();
    }

    #[test]
    fn the_first_error_stops_everything() {
        let ctx = JobContext::detached();
        let err = run_ordered(
            20,
            2,
            4,
            &ctx,
            || Ok(()),
            |_, i| if i == 5 { Err(CoreError::InvalidInput("boom".into())) } else { Ok(i) },
            |_, _| Ok(()),
        )
        .unwrap_err();
        assert_eq!(err.code(), "invalid_input");
        let err = run_ordered(
            5,
            2,
            4,
            &ctx,
            || -> CoreResult<()> { Err(CoreError::Internal("init".into())) },
            |_, i| Ok(i),
            |_, _| Ok(()),
        )
        .unwrap_err();
        assert_eq!(err.code(), "internal");
    }

    #[test]
    fn a_consumer_error_and_cancellation_stop_the_workers() {
        let ctx = JobContext::detached();
        let err = run_ordered(
            20,
            2,
            4,
            &ctx,
            || Ok(()),
            |_, i| Ok(i),
            |i, _| if i == 3 { Err(CoreError::Internal("write".into())) } else { Ok(()) },
        )
        .unwrap_err();
        assert_eq!(err.code(), "internal");

        let ctx = JobContext::detached();
        ctx.cancel_token().cancel();
        let err = run_ordered(20, 2, 4, &ctx, || Ok(()), |_, i| Ok(i), |_, _| Ok(())).unwrap_err();
        assert!(err.is_cancelled());
    }
}
