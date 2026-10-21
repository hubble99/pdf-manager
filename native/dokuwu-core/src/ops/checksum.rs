//! SHA-256 of a file, streamed in fixed-size chunks.
//!
//! The first core operation, kept deliberately simple: it proves the path in,
//! progress, cancel and result out wiring, and its memory use is one buffer no
//! matter how large the file is. Later engines reuse it to fingerprint inputs
//! and outputs.

use std::fs::File;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;

const CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDigest {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
}

pub fn sha256_file(path: &Path, ctx: &JobContext) -> CoreResult<FileDigest> {
    let mut file = File::open(path).map_err(|e| CoreError::io(path, e))?;
    let meta = file.metadata().map_err(|e| CoreError::io(path, e))?;
    if !meta.is_file() {
        return Err(CoreError::InvalidInput(format!("not a file: {}", path.display())));
    }
    let total = meta.len();

    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut done: u64 = 0;
    ctx.report("hashing", 0, Some(total));
    loop {
        ctx.check_cancelled()?;
        let n = match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(CoreError::io(path, e)),
        };
        hasher.update(&buf[..n]);
        done += n as u64;
        // A file that grows while we read must not report more than 100%.
        ctx.report("hashing", done.min(total), Some(total));
    }
    ctx.report("hashing", total, Some(total));

    Ok(FileDigest {
        path: path.to_path_buf(),
        size_bytes: done,
        sha256: to_hex(&hasher.finalize()),
    })
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}
