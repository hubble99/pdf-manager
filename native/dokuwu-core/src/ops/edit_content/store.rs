//! Private storage for a session's single authoritative commit record.
//!
//! The store never regenerates a PDF. Callers hand it the worker's verified
//! checkpoint metadata and a closed candidate file. A transaction prepares the
//! new files under `staging/`, verifies their hashes, installs them under
//! their final names and then switches one record file in a single atomic
//! step (`MoveFileExW` with write-through on Windows, `rename` plus a directory
//! sync elsewhere). Until that switch the old record is the whole truth; after
//! it nothing but best-effort cleanup runs. A half-written record never
//! becomes visible, and a state that cannot be proven is an unknown outcome
//! that blocks any further mutation.
//!
//! Layout of the session folder: `record.json`, `.lock`, `staging/`,
//! `checkpoints/<id>.pdf`, `outputs/<id>.pdf`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::state::{
    check_id, prepare_transition, Checkpoint, Outcome, Publication, SessionState, TransitionRequest,
    MAX_CHECKPOINT_BYTES,
};
use super::EditError;

/// Absolute ceilings of one transaction: the preparation space is reserved up
/// front and consumed as prepared files replace its bytes, so everything that
/// can run out of space happens before the commit point.
pub const MAX_RECORD_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_PREPARATION_BYTES: i64 = 64 * 1024 * 1024;
pub const STORE_SCHEMA: &str = "edit-content-commit-record/v1";

const COPY_CHUNK: usize = 1024 * 1024;

#[cfg(test)]
type FaultHook = Box<dyn Fn(&str) -> Result<(), EditError> + Send>;

pub type PrepareFn<'a> = &'a mut dyn FnMut(&SessionState, &Path) -> Result<(Checkpoint, PathBuf), EditError>;

pub struct TxRequest<'a> {
    pub request_id: &'a str,
    pub expected_revision: i64,
    pub operation: &'a str,
    pub pending_draft: bool,
}

fn encoded(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("a JSON value always serializes")
}

fn hex(digest: impl AsRef<[u8]>) -> String {
    digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// SHA-256 of a regular, non-link file of at most the checkpoint size.
pub(crate) fn file_hash(path: &Path) -> Result<String, EditError> {
    let meta = fs::symlink_metadata(path).map_err(|_| EditError::rejected("artifact is unavailable"))?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_CHECKPOINT_BYTES as u64 {
        return Err(EditError::rejected("artifact is unavailable"));
    }
    let mut file = File::open(path).map_err(|_| EditError::rejected("artifact is unavailable"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_CHUNK];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hex(hasher.finalize()));
        }
        hasher.update(&buffer[..read]);
    }
}

fn file_size(path: &Path) -> Result<u64, EditError> {
    Ok(fs::metadata(path).map_err(|_| EditError::rejected("artifact is unavailable"))?.len())
}

/// Same-volume atomic move with write-through. Never copies. With `replace`
/// false an existing destination is an error and both files are left alone.
pub(crate) fn atomic_move(source: &Path, destination: &Path, replace: bool) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let wide = |path: &Path| path.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (from, to) = (wide(source), wide(destination));
        let flags = MOVEFILE_WRITE_THROUGH | if replace { MOVEFILE_REPLACE_EXISTING } else { 0 };
        // SAFETY: both buffers are NUL-terminated and live across the call.
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if replace {
            fs::rename(source, destination)?;
        } else {
            // A hard link fails when the destination exists and is atomic.
            fs::hard_link(source, destination)?;
            fs::remove_file(source)?;
        }
        if let Some(parent) = destination.parent() {
            if let Ok(dir) = File::open(parent) {
                let _ = dir.sync_all();
            }
        }
        Ok(())
    }
}

/// Exclusive, non-blocking ownership of a session folder for as long as the
/// handle lives. Closing the handle (or the process dying) releases it.
struct LockFile {
    _file: File,
}

impl LockFile {
    fn acquire(path: &Path) -> io::Result<Self> {
        if fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid lock"));
        }
        let mut file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
        if file.metadata()?.len() == 0 {
            file.write_all(b"0")?;
            file.flush()?;
        }
        lock_exclusive(&file)?;
        Ok(Self { _file: file })
    }
}

#[cfg(windows)]
fn lock_exclusive(file: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY};
    use windows_sys::Win32::System::IO::OVERLAPPED;
    // SAFETY: a zeroed OVERLAPPED selects offset 0; the handle is valid for the call.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    let locked = unsafe {
        LockFileEx(file.as_raw_handle() as _, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &mut overlapped)
    };
    if locked == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn lock_exclusive(file: &File) -> io::Result<()> {
    use std::os::unix::io::AsRawFd;
    // SAFETY: the descriptor is valid for the call.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

struct Inner {
    source_hash: Option<String>,
    blocked: bool,
    lock: Option<LockFile>,
    #[cfg(test)]
    fault: Option<FaultHook>,
    #[cfg(test)]
    max_preparation: i64,
}

/// What a transaction has created, so it can be undone or tidied up.
#[derive(Default)]
struct Work {
    record: Option<PathBuf>,
    reservation: Option<PathBuf>,
    installed: Vec<PathBuf>,
    switched: bool,
}

pub struct CommitStore {
    root: PathBuf,
    session_id: String,
    inner: Mutex<Inner>,
}

impl CommitStore {
    /// Owns an existing session folder. `source_hash` is checked against the
    /// record when known.
    pub fn open(root: &Path, session_id: &str, source_hash: Option<&str>) -> Result<Self, EditError> {
        let root = std::path::absolute(root)?;
        let store = Self {
            root,
            session_id: session_id.to_owned(),
            inner: Mutex::new(Inner {
                source_hash: source_hash.map(str::to_owned),
                blocked: false,
                lock: None,
                #[cfg(test)]
                fault: None,
                #[cfg(test)]
                max_preparation: MAX_PREPARATION_BYTES,
            }),
        };
        let meta = fs::symlink_metadata(&store.root).map_err(|_| EditError::unknown("owned Content store is unavailable"))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(EditError::unknown("owned Content store is unavailable"));
        }
        if store.root.ancestors().skip(1).any(|parent| {
            fs::symlink_metadata(parent).map(|m| m.file_type().is_symlink()).unwrap_or(false)
        }) {
            return Err(EditError::unknown("Content store ownership is uncertain"));
        }
        let lock = LockFile::acquire(&store.root.join(".lock"))
            .map_err(|_| EditError::unknown("Content store is already owned or unavailable"))?;
        store.guard().lock = Some(lock);
        Ok(store)
    }

    /// Locks and verifies the committed record and every referenced artifact.
    /// The record is a local integrity checksum, not an authentication token.
    /// Recovery never selects a staging file or guesses the newest checkpoint.
    pub fn recover(root: &Path, session_id: &str) -> Result<Self, EditError> {
        let store = Self::open(root, session_id, None)?;
        let state = store.state()?;
        store.guard().source_hash = Some(state.source.source_hash.clone());
        Ok(store)
    }

    /// A new session folder holding the source as checkpoint `source`.
    pub fn create(root: &Path, state: &SessionState, source: &Path) -> Result<Self, EditError> {
        state.validate()?;
        if state.revision != 0 || state.current() != &state.source || !state.publications.is_empty() || !state.outcomes.is_empty() {
            return Err(EditError::rejected("initialization requires the source baseline"));
        }
        let root = std::path::absolute(root)?;
        fs::create_dir(&root)?;
        let store = Self::open(&root, &state.session_id, Some(&state.source.source_hash))?;
        // Uncertain initialization is retained for diagnosis, never promoted.
        for name in ["staging", "checkpoints", "outputs"] {
            fs::create_dir(root.join(name))?;
        }
        let mut inner = store.guard();
        store.install(
            &inner,
            source,
            &store.artifact("checkpoints", &state.source.checkpoint_id)?,
            &state.source.accepted_artifact_hash,
            state.source.byte_size,
        )?;
        let path = store.prepare_record(&inner, state)?;
        atomic_move(&path, &root.join("record.json"), false)?;
        store.read_checked(&mut inner)?;
        drop(inner);
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    fn guard(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn boundary(&self, _inner: &Inner, _name: &str) -> Result<(), EditError> {
        // There is no production fault or bypass switch; tests install one.
        #[cfg(test)]
        if let Some(fault) = &_inner.fault {
            fault(_name)?;
        }
        Ok(())
    }

    fn max_preparation(&self, _inner: &Inner) -> i64 {
        #[cfg(test)]
        return _inner.max_preparation;
        #[cfg(not(test))]
        MAX_PREPARATION_BYTES
    }

    fn artifact(&self, area: &str, identity: &str) -> Result<PathBuf, EditError> {
        check_id(identity)?;
        if !matches!(area, "checkpoints" | "outputs") {
            return Err(EditError::rejected("invalid artifact area"));
        }
        let directory = self.root.join(area);
        let path = directory.join(format!("{identity}.pdf"));
        let is_link = |p: &Path| fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false);
        let is_dir = fs::symlink_metadata(&directory).map(|m| m.is_dir()).unwrap_or(false);
        if is_link(&directory) || !is_dir || is_link(&path) {
            return Err(EditError::unknown("artifact ownership is uncertain"));
        }
        Ok(path)
    }

    fn staging(&self) -> Result<PathBuf, EditError> {
        let directory = self.root.join("staging");
        let meta = fs::symlink_metadata(&directory).map_err(|_| EditError::unknown("staging ownership is uncertain"))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(EditError::unknown("staging ownership is uncertain"));
        }
        Ok(directory.join(uuid::Uuid::new_v4().simple().to_string()))
    }

    /// Copies `source` to `destination` through staging, proving the bytes
    /// before and after, and leaves the installed file read-only.
    fn install(&self, inner: &Inner, source: &Path, destination: &Path, expected_hash: &str, size: i64) -> Result<(), EditError> {
        let changed = || EditError::rejected("prepared bytes changed");
        if size > MAX_CHECKPOINT_BYTES || file_hash(source)? != expected_hash || file_size(source)? != size as u64 {
            return Err(changed());
        }
        let temporary = self.staging()?;
        let result = (|| -> Result<(), EditError> {
            {
                let mut reader = File::open(source)?;
                let mut writer = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
                let mut remaining = size as u64;
                let mut buffer = vec![0_u8; COPY_CHUNK];
                while remaining > 0 {
                    let want = remaining.min(COPY_CHUNK as u64) as usize;
                    let read = reader.read(&mut buffer[..want])?;
                    if read == 0 {
                        return Err(changed());
                    }
                    writer.write_all(&buffer[..read])?;
                    remaining -= read as u64;
                }
                if reader.read(&mut buffer[..1])? != 0 {
                    return Err(changed());
                }
                writer.flush()?;
                self.boundary(inner, "before-file-flush")?;
                writer.sync_all()?;
            }
            if file_hash(&temporary)? != expected_hash {
                return Err(changed());
            }
            self.boundary(inner, "before-artifact-install")?;
            atomic_move(&temporary, destination, false)?;
            let mut permissions = fs::metadata(destination)?.permissions();
            permissions.set_readonly(true);
            fs::set_permissions(destination, permissions)?;
            Ok(())
        })();
        if temporary.exists() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn prepare_record(&self, inner: &Inner, state: &SessionState) -> Result<PathBuf, EditError> {
        let record = self.record_bytes(state)?;
        if record.len() as u64 > MAX_RECORD_BYTES {
            return Err(EditError::rejected("commit record exceeds the bounded preparation budget"));
        }
        let temporary = self.staging()?;
        let written = (|| -> Result<(), EditError> {
            let mut writer = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
            writer.write_all(&record)?;
            writer.flush()?;
            self.boundary(inner, "before-record-flush")?;
            writer.sync_all()?;
            Ok(())
        })();
        match written {
            Ok(()) => Ok(temporary),
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                Err(error)
            }
        }
    }

    fn record_bytes(&self, state: &SessionState) -> Result<Vec<u8>, EditError> {
        let payload = serde_json::to_value(state).map_err(|_| EditError::rejected("state cannot be recorded"))?;
        let sha256 = hex(Sha256::digest(encoded(&payload)));
        Ok(encoded(&serde_json::json!({ "schema": STORE_SCHEMA, "state": payload, "sha256": sha256 })))
    }

    fn reserve(&self, inner: &Inner, byte_count: i64) -> Result<PathBuf, EditError> {
        if !(0 < byte_count && byte_count <= self.max_preparation(inner)) {
            return Err(EditError::rejected("transaction exceeds the preparation budget"));
        }
        let reservation = self.staging()?;
        let written = (|| -> io::Result<()> {
            let mut writer = OpenOptions::new().write(true).create_new(true).open(&reservation)?;
            let block = vec![0_u8; COPY_CHUNK];
            let mut remaining = byte_count as usize;
            while remaining > 0 {
                let chunk = remaining.min(block.len());
                writer.write_all(&block[..chunk])?;
                remaining -= chunk;
            }
            writer.flush()?;
            Ok(())
        })();
        let synced = written.and_then(|()| {
            self.boundary_io(inner, "before-reservation-flush")?;
            OpenOptions::new().write(true).open(&reservation)?.sync_all()
        });
        match synced {
            Ok(()) => Ok(reservation),
            Err(_) => {
                let _ = fs::remove_file(&reservation);
                Err(EditError::rejected("insufficient preparation space"))
            }
        }
    }

    fn boundary_io(&self, inner: &Inner, name: &str) -> io::Result<()> {
        self.boundary(inner, name).map_err(|e| io::Error::other(e.to_string()))
    }

    /// Releases only the bytes the next prepared artifact will use.
    fn consume_reservation(&self, reservation: &Path, byte_count: i64) -> Result<(), EditError> {
        let lost = || EditError::rejected("preparation space reservation was lost");
        let current = fs::metadata(reservation).map_err(|_| lost())?.len();
        if byte_count < 0 || byte_count as u64 > current {
            return Err(lost());
        }
        let held = OpenOptions::new().write(true).open(reservation).map_err(|_| lost())?;
        held.set_len(current - byte_count as u64).map_err(|_| lost())?;
        held.sync_all().map_err(|_| lost())?;
        Ok(())
    }

    fn read_checked(&self, inner: &mut Inner) -> Result<SessionState, EditError> {
        let verify = || -> Result<SessionState, EditError> {
            let record = self.root.join("record.json");
            let meta = fs::symlink_metadata(&record).map_err(|_| EditError::rejected("record"))?;
            if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_RECORD_BYTES {
                return Err(EditError::rejected("record"));
            }
            let payload: Value = serde_json::from_slice(&fs::read(&record)?).map_err(|_| EditError::rejected("record"))?;
            let object = payload.as_object().ok_or_else(|| EditError::rejected("record"))?;
            if object.len() != 3 || object.get("schema").and_then(Value::as_str) != Some(STORE_SCHEMA) {
                return Err(EditError::rejected("record"));
            }
            let (state_value, digest) = match (object.get("state"), object.get("sha256").and_then(Value::as_str)) {
                (Some(state), Some(digest)) => (state, digest),
                _ => return Err(EditError::rejected("record")),
            };
            if hex(Sha256::digest(encoded(state_value))) != digest {
                return Err(EditError::rejected("record"));
            }
            let state: SessionState = serde_json::from_value(state_value.clone()).map_err(|_| EditError::rejected("record"))?;
            state.validate()?;
            if state.session_id != self.session_id
                || inner.source_hash.as_deref().is_some_and(|expected| state.source.source_hash != expected)
            {
                return Err(EditError::rejected("record"));
            }
            self.check_files(&state)?;
            Ok(state)
        };
        verify().map_err(|_| {
            inner.blocked = true;
            EditError::unknown("committed Content state cannot be verified")
        })
    }

    fn check_files(&self, state: &SessionState) -> Result<(), EditError> {
        let changed = |reason: &str| EditError::rejected(reason);
        for checkpoint in std::iter::once(&state.source).chain(state.checkpoints.iter()) {
            let path = self.artifact("checkpoints", &checkpoint.checkpoint_id)?;
            if file_hash(&path)? != checkpoint.accepted_artifact_hash || file_size(&path)? != checkpoint.byte_size as u64 {
                return Err(changed("checkpoint bytes changed"));
            }
        }
        for output in &state.publications {
            let path = self.artifact("outputs", &output.output_id)?;
            if file_hash(&path)? != output.artifact_hash || file_size(&path)? != output.byte_size as u64 {
                return Err(changed("published bytes changed"));
            }
        }
        Ok(())
    }

    fn state_locked(&self, inner: &mut Inner) -> Result<SessionState, EditError> {
        if inner.lock.is_none() || inner.blocked {
            return Err(EditError::unknown("Content store requires reconciliation"));
        }
        self.read_checked(inner)
    }

    /// The committed state, verified against its files on every call.
    pub fn state(&self) -> Result<SessionState, EditError> {
        let mut inner = self.guard();
        self.state_locked(&mut inner)
    }

    /// The file of the current accepted checkpoint.
    pub fn checkpoint_path(&self) -> Result<PathBuf, EditError> {
        let mut inner = self.guard();
        let state = self.state_locked(&mut inner)?;
        self.artifact("checkpoints", &state.current().checkpoint_id)
    }

    /// The file of a published output, after proving its bytes once more.
    pub fn verified_output(&self, output_id: &str) -> Result<(PathBuf, Publication), EditError> {
        let mut inner = self.guard();
        let state = self.state_locked(&mut inner)?;
        let output = state
            .publications
            .iter()
            .find(|item| item.output_id == output_id)
            .ok_or_else(|| EditError::rejected("output is not published"))?
            .clone();
        let path = self.artifact("outputs", output_id)?;
        let size = file_size(&path).ok();
        if size != Some(output.byte_size as u64) || file_hash(&path).ok().as_deref() != Some(output.artifact_hash.as_str()) {
            inner.blocked = true;
            return Err(EditError::unknown("published bytes changed"));
        }
        Ok((path, output))
    }

    /// Runs one transaction from worker preparation through record
    /// publication, without retry. `prepare` is the verified-worker handoff,
    /// never request-supplied metadata. An error before the switch retains the
    /// complete previous state.
    pub fn transact(
        &self,
        request: &TxRequest<'_>,
        prepare: Option<PrepareFn<'_>>,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Outcome, EditError> {
        let mut inner = self.guard();
        let old = self.state_locked(&mut inner)?;
        if let Some(known) = old.known_outcome(request.request_id) {
            return Ok(known.clone());
        }
        if request.expected_revision != old.revision {
            return Err(EditError::rejected(super::state::STALE_REVISION_MESSAGE));
        }
        if cancelled() {
            return Err(EditError::rejected("cancelled before commit"));
        }
        let mut work = Work::default();
        let result = self.run_transaction(&mut inner, &old, request, prepare, cancelled, &mut work);
        let result = match result {
            Ok(outcome) => Ok(outcome),
            Err(error) => {
                // The move could have succeeded before an error was observed.
                match self.read_checked(&mut inner) {
                    Err(unknown) => Err(unknown),
                    Ok(current) => {
                        if let Some(committed) = current.known_outcome(request.request_id) {
                            Ok(committed.clone())
                        } else if work.switched || current != old {
                            inner.blocked = true;
                            Err(EditError::unknown("commit outcome requires reconciliation"))
                        } else {
                            for path in &work.installed {
                                self.remove_owned_unreferenced(path);
                            }
                            Err(error)
                        }
                    }
                }
            }
        };
        if let Some(reservation) = &work.reservation {
            let _ = fs::remove_file(reservation);
        }
        if let Some(record) = &work.record {
            // A failed cleanup cannot overturn committed state.
            if record.exists() && !inner.blocked {
                let _ = fs::remove_file(record);
            }
        }
        result
    }

    fn run_transaction(
        &self,
        inner: &mut Inner,
        old: &SessionState,
        request: &TxRequest<'_>,
        prepare: Option<PrepareFn<'_>>,
        cancelled: &dyn Fn() -> bool,
        work: &mut Work,
    ) -> Result<Outcome, EditError> {
        let editing = matches!(request.operation, "apply" | "save-with-draft");
        let mut checkpoint: Option<Checkpoint> = None;
        let mut candidate = self.artifact("checkpoints", &old.current().checkpoint_id)?;
        match prepare {
            Some(prepare) if editing => {
                self.boundary(inner, "before-worker")?;
                let (prepared, path) = prepare(old, &candidate)?;
                checkpoint = Some(prepared);
                candidate = path;
                self.boundary(inner, "after-worker")?;
            }
            None if editing => return Err(EditError::rejected("verified worker preparation is required")),
            Some(_) => return Err(EditError::rejected("unchanged save/history must not invoke the worker")),
            None => {}
        }
        let publication = if matches!(request.operation, "save" | "save-with-draft") {
            let content = checkpoint.as_ref().unwrap_or_else(|| old.current());
            Some(Publication {
                output_id: uuid::Uuid::new_v4().simple().to_string(),
                artifact_hash: content.accepted_artifact_hash.clone(),
                byte_size: content.byte_size,
            })
        } else {
            None
        };
        let transition = prepare_transition(
            old,
            &TransitionRequest {
                request_id: request.request_id,
                expected_revision: request.expected_revision,
                operation: request.operation,
                pending_draft: request.pending_draft,
                checkpoint: checkpoint.as_ref(),
                publication: publication.as_ref(),
            },
        )?;
        let record_size = self.record_bytes(&transition.next_state)?.len() as i64;
        let install_bytes = checkpoint.as_ref().map_or(0, |c| c.byte_size) + publication.as_ref().map_or(0, |p| p.byte_size);
        let reservation = self.reserve(inner, (record_size + install_bytes).max(1))?;
        work.reservation = Some(reservation.clone());
        if let Some(checkpoint) = &checkpoint {
            self.consume_reservation(&reservation, checkpoint.byte_size)?;
            let destination = self.artifact("checkpoints", &checkpoint.checkpoint_id)?;
            self.install(inner, &candidate, &destination, &checkpoint.accepted_artifact_hash, checkpoint.byte_size)?;
            work.installed.push(destination.clone());
            candidate = destination;
        }
        if let Some(publication) = &publication {
            self.consume_reservation(&reservation, publication.byte_size)?;
            let destination = self.artifact("outputs", &publication.output_id)?;
            self.install(inner, &candidate, &destination, &publication.artifact_hash, publication.byte_size)?;
            work.installed.push(destination);
        }
        self.boundary(inner, "after-files-prepared")?;
        self.consume_reservation(&reservation, record_size)?;
        let record = self.prepare_record(inner, &transition.next_state)?;
        work.record = Some(record.clone());
        // Last checks belong before the one commit point.
        if self.read_checked(inner)? != *old || cancelled() {
            return Err(EditError::rejected("cancelled or stale before commit"));
        }
        self.check_files(&transition.next_state)?;
        self.boundary(inner, "before-record-switch")?;
        if cancelled() {
            return Err(EditError::rejected("cancelled before commit"));
        }
        atomic_move(&record, &self.root.join("record.json"), true)?;
        work.switched = true;
        self.boundary(inner, "after-record-switch")?;
        // No transaction-critical work remains after this point.
        for identity in &transition.evicted_checkpoint_ids {
            self.remove_owned_unreferenced(&self.artifact("checkpoints", identity)?);
        }
        self.boundary(inner, "before-reply")?;
        Ok(transition.outcome)
    }

    /// Only for this transaction's newly installed files, or checkpoints the
    /// committed record no longer references. No scan, no guessing, no
    /// recursive removal.
    fn remove_owned_unreferenced(&self, path: &Path) {
        let Some(parent) = path.parent() else { return };
        if parent != self.root.join("checkpoints") && parent != self.root.join("outputs") {
            return;
        }
        if fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
            return;
        }
        if let Ok(meta) = fs::metadata(path) {
            let mut permissions = meta.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            let _ = fs::set_permissions(path, permissions);
        }
        // A private orphan is never promoted or allowed to undo a commit.
        let _ = fs::remove_file(path);
    }

    /// Gives up ownership of the folder; nothing is deleted.
    pub fn close(&self) {
        self.guard().lock = None;
    }
}

#[cfg(test)]
mod tests;
