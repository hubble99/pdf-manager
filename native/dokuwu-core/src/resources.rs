//! Memory-aware scheduling.
//!
//! Dokuwu puts no limit on input file size, so heavy jobs must keep their memory
//! use independent of it. The rules every engine follows:
//!
//! - take file paths, never whole files as bytes;
//! - process one bounded unit at a time (a page, an image, a chunk);
//! - choose the worker count from free RAM with [`worker_count`];
//! - before each unit, wait on a [`MemoryBrake`] so a machine running low on
//!   memory slows the job down instead of swapping or crashing.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use sysinfo::{MemoryRefreshKind, RefreshKind, System};

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;

pub const MIB: u64 = 1024 * 1024;

/// Source of memory figures. Real code uses [`SystemMemory`]; tests use fakes.
pub trait MemoryProbe: Send + Sync {
    fn available_bytes(&self) -> u64;
    fn total_bytes(&self) -> u64;
}

/// Reads live figures from the operating system.
pub struct SystemMemory {
    sys: Mutex<System>,
}

impl SystemMemory {
    pub fn new() -> Self {
        let sys = System::new_with_specifics(
            RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()),
        );
        Self { sys: Mutex::new(sys) }
    }

    fn refreshed<R>(&self, f: impl FnOnce(&System) -> R) -> R {
        let mut sys = self.sys.lock().unwrap_or_else(|e| e.into_inner());
        sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        f(&sys)
    }
}

impl Default for SystemMemory {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryProbe for SystemMemory {
    fn available_bytes(&self) -> u64 {
        self.refreshed(|s| s.available_memory())
    }

    fn total_bytes(&self) -> u64 {
        self.refreshed(|s| s.total_memory())
    }
}

/// How many workers a job may run in parallel.
///
/// `per_worker_bytes` is the job's estimate of one worker's peak use (for
/// example one decoded page). `reserve_bytes` is left for the app and the rest
/// of the system. The result is at least 1 and at most `max_workers` and the
/// number of CPU threads.
pub fn worker_count(
    probe: &dyn MemoryProbe,
    per_worker_bytes: u64,
    reserve_bytes: u64,
    max_workers: usize,
) -> usize {
    let cpus = thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let cap = max_workers.min(cpus).max(1);
    let spare = probe.available_bytes().saturating_sub(reserve_bytes);
    let by_memory = spare / per_worker_bytes.max(1);
    (by_memory.min(cap as u64) as usize).max(1)
}

/// Pauses a job while free memory is below a floor.
#[derive(Clone)]
pub struct MemoryBrake {
    probe: Arc<dyn MemoryProbe>,
    floor_bytes: u64,
    poll: Duration,
    max_wait: Duration,
}

impl MemoryBrake {
    /// Default: wait while less than `floor_bytes` is free, re-check every
    /// 200 ms, give up with `InsufficientMemory` after 60 s.
    pub fn new(probe: Arc<dyn MemoryProbe>, floor_bytes: u64) -> Self {
        Self {
            probe,
            floor_bytes,
            poll: Duration::from_millis(200),
            max_wait: Duration::from_secs(60),
        }
    }

    pub fn with_timing(mut self, poll: Duration, max_wait: Duration) -> Self {
        self.poll = poll;
        self.max_wait = max_wait;
        self
    }

    /// Returns once enough memory is free. Stays responsive to cancellation
    /// while waiting.
    pub fn wait_for_headroom(&self, ctx: &JobContext) -> CoreResult<()> {
        let started = Instant::now();
        loop {
            ctx.check_cancelled()?;
            let available = self.probe.available_bytes();
            if available >= self.floor_bytes {
                return Ok(());
            }
            if started.elapsed() >= self.max_wait {
                return Err(CoreError::InsufficientMemory {
                    needed_bytes: self.floor_bytes,
                    available_bytes: available,
                });
            }
            ctx.report("waiting_for_memory", 0, None);
            thread::sleep(self.poll);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct FakeMemory {
        available: AtomicU64,
        total: u64,
    }

    impl FakeMemory {
        fn new(available: u64) -> Arc<Self> {
            Arc::new(Self { available: AtomicU64::new(available), total: 16 * 1024 * MIB })
        }
    }

    impl MemoryProbe for FakeMemory {
        fn available_bytes(&self) -> u64 {
            self.available.load(Ordering::SeqCst)
        }
        fn total_bytes(&self) -> u64 {
            self.total
        }
    }

    #[test]
    fn worker_count_follows_free_memory() {
        let cpus = thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        let mem = FakeMemory::new(1024 * MIB);
        // 1 GiB free, 256 MiB reserve, 256 MiB per worker -> 3 by memory.
        assert_eq!(worker_count(mem.as_ref(), 256 * MIB, 256 * MIB, 8), 3.min(cpus));
    }

    #[test]
    fn worker_count_never_drops_below_one() {
        let mem = FakeMemory::new(10 * MIB);
        assert_eq!(worker_count(mem.as_ref(), 512 * MIB, 256 * MIB, 8), 1);
        assert_eq!(worker_count(mem.as_ref(), 0, 0, 0), 1);
    }

    #[test]
    fn worker_count_respects_max() {
        let mem = FakeMemory::new(1024 * 1024 * MIB);
        assert_eq!(worker_count(mem.as_ref(), MIB, 0, 1), 1);
    }

    #[test]
    fn brake_passes_when_memory_is_free() {
        let brake = MemoryBrake::new(FakeMemory::new(2048 * MIB), 512 * MIB);
        brake.wait_for_headroom(&JobContext::detached()).unwrap();
    }

    #[test]
    fn brake_waits_until_memory_frees_up() {
        let mem = FakeMemory::new(100 * MIB);
        let brake = MemoryBrake::new(mem.clone(), 512 * MIB)
            .with_timing(Duration::from_millis(5), Duration::from_secs(5));
        let releaser = {
            let mem = mem.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(50));
                mem.available.store(1024 * MIB, Ordering::SeqCst);
            })
        };
        let started = Instant::now();
        brake.wait_for_headroom(&JobContext::detached()).unwrap();
        assert!(started.elapsed() >= Duration::from_millis(40));
        releaser.join().unwrap();
    }

    #[test]
    fn brake_gives_up_after_max_wait() {
        let brake = MemoryBrake::new(FakeMemory::new(100 * MIB), 512 * MIB)
            .with_timing(Duration::from_millis(5), Duration::from_millis(30));
        let err = brake.wait_for_headroom(&JobContext::detached()).unwrap_err();
        assert_eq!(err.code(), "insufficient_memory");
    }

    #[test]
    fn brake_honours_cancel_while_waiting() {
        let brake = MemoryBrake::new(FakeMemory::new(0), 512 * MIB)
            .with_timing(Duration::from_millis(5), Duration::from_secs(60));
        let ctx = JobContext::detached();
        ctx.cancel_token().cancel();
        assert!(brake.wait_for_headroom(&ctx).unwrap_err().is_cancelled());
    }

    #[test]
    fn system_memory_reports_something() {
        let mem = SystemMemory::new();
        assert!(mem.total_bytes() > 0);
        assert!(mem.available_bytes() <= mem.total_bytes());
    }
}
