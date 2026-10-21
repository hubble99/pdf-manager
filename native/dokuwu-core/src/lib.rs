//! Dokuwu's shared native engine.
//!
//! This crate holds the feature logic that runs in Rust instead of the Python
//! sidecar. It has no Tauri dependency: the app's `src-tauri` crate wraps each
//! operation in a Tauri command and turns progress into window events, and
//! tests call the operations directly.
//!
//! Building blocks every operation uses:
//! - [`error::CoreError`]: one error type, serialized as `{ code, message }`;
//! - [`job`]: background jobs with throttled progress and cancellation;
//! - [`resources`]: free-memory based worker count and a memory brake, so
//!   memory use stays independent of input file size.

pub mod error;
pub mod job;
pub mod ops;
pub mod resources;

pub use error::{CoreError, CoreResult};
pub use job::{CancelToken, JobContext, JobId, JobOutcome, JobRunner, Progress, ProgressSink};

use serde::Serialize;

use resources::{MemoryProbe, SystemMemory};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreInfo {
    pub version: String,
    pub cpu_threads: usize,
    pub total_memory_bytes: u64,
    pub available_memory_bytes: u64,
}

/// Version and machine figures, for diagnostics and the settings page.
pub fn core_info() -> CoreInfo {
    let mem = SystemMemory::new();
    CoreInfo {
        version: VERSION.to_owned(),
        cpu_threads: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        total_memory_bytes: mem.total_bytes(),
        available_memory_bytes: mem.available_bytes(),
    }
}
