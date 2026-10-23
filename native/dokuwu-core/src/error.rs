//! One error type for every core operation.
//!
//! The frontend receives errors as `{ code, message }`. `code` is stable and
//! meant for branching in TypeScript; `message` is for logs and fallback text.

use std::io;
use std::path::{Path, PathBuf};

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// The job was cancelled by the user. Not a failure.
    #[error("operation cancelled")]
    Cancelled,

    #[error("file not found: {}", path.display())]
    NotFound { path: PathBuf },

    #[error("cannot access {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("unsupported: {0}")]
    Unsupported(String),

    /// The document is encrypted with an open password.
    #[error("the document is password protected")]
    PasswordRequired,

    /// Free memory stayed below the job's floor for too long.
    #[error("not enough free memory (need {needed_bytes} bytes, {available_bytes} available)")]
    InsufficientMemory {
        needed_bytes: u64,
        available_bytes: u64,
    },

    /// A job is running and the request would pull files out from under it.
    #[error("busy: {0}")]
    Busy(String),

    #[error("internal error: {0}")]
    Internal(String),
}

impl CoreError {
    /// Wraps an I/O error with the path it happened on. A missing file becomes
    /// `NotFound` so callers can tell it apart from permission or disk errors.
    pub fn io(path: impl AsRef<Path>, source: io::Error) -> Self {
        let path = path.as_ref().to_path_buf();
        if source.kind() == io::ErrorKind::NotFound {
            CoreError::NotFound { path }
        } else {
            CoreError::Io { path, source }
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            CoreError::Cancelled => "cancelled",
            CoreError::NotFound { .. } => "not_found",
            CoreError::Io { .. } => "io",
            CoreError::InvalidInput(_) => "invalid_input",
            CoreError::Unsupported(_) => "unsupported",
            CoreError::PasswordRequired => "password_required",
            CoreError::InsufficientMemory { .. } => "insufficient_memory",
            CoreError::Busy(_) => "busy",
            CoreError::Internal(_) => "internal",
        }
    }

    pub fn is_cancelled(&self) -> bool {
        matches!(self, CoreError::Cancelled)
    }
}

impl Serialize for CoreError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("CoreError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_maps_to_not_found() {
        let err = CoreError::io("x.pdf", io::Error::from(io::ErrorKind::NotFound));
        assert_eq!(err.code(), "not_found");
    }

    #[test]
    fn other_io_errors_keep_their_source() {
        let err = CoreError::io("x.pdf", io::Error::from(io::ErrorKind::PermissionDenied));
        assert_eq!(err.code(), "io");
        assert!(err.to_string().contains("x.pdf"));
    }

    #[test]
    fn serializes_as_code_and_message() {
        let json = serde_json::to_value(CoreError::InvalidInput("bad".into())).unwrap();
        assert_eq!(json["code"], "invalid_input");
        assert_eq!(json["message"], "invalid input: bad");
    }
}
