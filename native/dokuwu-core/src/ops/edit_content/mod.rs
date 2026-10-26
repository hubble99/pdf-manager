//! Edit Content session host.
//!
//! Everything about an Edit Content session except the PDF work itself: the
//! worker (`native/edit-content-engine`) runs in its own process and loads
//! PDFium there, and this module drives it over framed stdio, owns the
//! revision and history state machine, makes every accepted edit visible
//! through one atomic commit-record switch, keeps request outcomes so a retry
//! is never replayed, limits live sessions and exports the saved PDF.
//!
//! - [`identity`]: the pinned PDFium build.
//! - [`state`]: pure transition rules (policy `edit-content-acceptance/v4`).
//! - [`store`]: the single authoritative commit record (`edit-content-commit-record/v1`).
//! - [`worker`]: the framed-stdio client of one worker process.
//! - [`coordinator`]: one session's accepted state, worker and commit store.
//! - [`registry`]: live sessions, request outcomes and cancellation.
//! - [`protocol`]: the frontend envelope, strict request validation and replies.
//! - [`host`]: the entry point the app calls.

use std::fmt;
use std::io;

pub mod coordinator;
pub mod diagnose;
pub mod host;
pub mod identity;
pub mod protocol;
pub mod registry;
pub mod state;
pub mod store;
pub mod unlock;
pub mod worker;

pub use coordinator::OpenFailure;
pub use host::{EditContentHost, HostConfig, HostError};

/// A failure of the session host. The variants keep the old Python exception
/// classes apart, because the coordinator treats them differently.
#[derive(Debug)]
pub enum EditError {
    /// A safe, known failure before anything was committed.
    Rejected(String),
    /// The committed state cannot be proven. No mutation or replay is allowed.
    Unknown(String),
    Io(String),
    Worker(worker::WorkerError),
    /// The worker refused to prepare a candidate.
    Preparation(worker::PreparationRejected),
    /// The engine itself cannot be used (identity, platform).
    Unavailable(String),
}

impl EditError {
    pub(crate) fn unavailable(message: &str) -> Self {
        Self::Unavailable(message.to_owned())
    }

    pub(crate) fn rejected(message: &str) -> Self {
        Self::Rejected(message.to_owned())
    }

    pub(crate) fn unknown(message: &str) -> Self {
        Self::Unknown(message.to_owned())
    }
}

impl From<io::Error> for EditError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

impl From<worker::WorkerError> for EditError {
    fn from(error: worker::WorkerError) -> Self {
        Self::Worker(error)
    }
}

impl fmt::Display for EditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected(m) | Self::Unknown(m) | Self::Io(m) | Self::Unavailable(m) => f.write_str(m),
            Self::Worker(e) => f.write_str(&e.message),
            Self::Preparation(e) => f.write_str(&e.reason),
        }
    }
}

impl std::error::Error for EditError {}
