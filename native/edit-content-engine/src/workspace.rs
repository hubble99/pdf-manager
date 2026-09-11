use crate::sha256_reader;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_WORKING_SET_BYTES: u64 = 64 * 1024 * 1024;
const WORKSPACE_SCHEMA: &str = "edit-content-workspace/v1";
const WORKSPACE_OWNER: &str = "edit-content-engine";
const WORKSPACE_PREFIX: &str = "edit-content-";
const MARKER_NAME: &str = ".owner.json";

#[derive(Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub(crate) fn check(&self) -> Result<(), WorkspaceError> {
        if self.0.load(Ordering::SeqCst) {
            Err(WorkspaceError::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum WorkspaceError {
    Cancelled,
    InvalidSource,
    SourceTooLarge,
    SourceChanged,
    PathEscapesWorkspace,
    Io,
}

#[derive(Debug, Clone, Copy)]
pub enum WorkspaceArea {
    Working,
    Checkpoints,
    Staging,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnershipMarker {
    schema: String,
    owner: String,
    session_id: String,
    process_id: u32,
}

pub struct SessionWorkspace {
    directory: PathBuf,
    source: PathBuf,
    working: PathBuf,
    checkpoints: PathBuf,
    staging: PathBuf,
    source_hash: String,
    source_bytes: u64,
}

impl SessionWorkspace {
    pub fn create(
        root: &Path,
        source: &Path,
        session_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<Self, WorkspaceError> {
        cancellation.check()?;
        if session_id.trim().is_empty() {
            return Err(WorkspaceError::InvalidSource);
        }

        let source_metadata =
            fs::symlink_metadata(source).map_err(|_| WorkspaceError::InvalidSource)?;
        if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
            return Err(WorkspaceError::InvalidSource);
        }
        if source_metadata.len() > MAX_SOURCE_BYTES {
            return Err(WorkspaceError::SourceTooLarge);
        }

        fs::create_dir_all(root).map_err(|_| WorkspaceError::Io)?;
        set_private_directory(root)?;
        let canonical_root = fs::canonicalize(root).map_err(|_| WorkspaceError::Io)?;
        let canonical_source =
            fs::canonicalize(source).map_err(|_| WorkspaceError::InvalidSource)?;
        if canonical_source.starts_with(&canonical_root) {
            return Err(WorkspaceError::InvalidSource);
        }
        cleanup_owned_orphans(&canonical_root, session_id)?;
        cancellation.check()?;

        let before_hash = hash_file(&canonical_source)?;
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| WorkspaceError::Io)?
            .as_nanos();
        let directory =
            canonical_root.join(format!("{WORKSPACE_PREFIX}{}-{unique}", std::process::id()));
        fs::create_dir(&directory).map_err(|_| WorkspaceError::Io)?;

        let result = (|| {
            set_private_directory(&directory)?;
            let marker = OwnershipMarker {
                schema: WORKSPACE_SCHEMA.into(),
                owner: WORKSPACE_OWNER.into(),
                session_id: session_id.into(),
                process_id: std::process::id(),
            };
            let marker_path = directory.join(MARKER_NAME);
            let marker_bytes = serde_json::to_vec(&marker).map_err(|_| WorkspaceError::Io)?;
            write_new_file(&marker_path, &marker_bytes, false)?;

            let source_dir = directory.join("source");
            let working_dir = directory.join("working");
            let checkpoints_dir = directory.join("checkpoints");
            let staging_dir = directory.join("staging");
            for path in [&source_dir, &working_dir, &checkpoints_dir, &staging_dir] {
                fs::create_dir(path).map_err(|_| WorkspaceError::Io)?;
                set_private_directory(path)?;
            }

            let private_source = source_dir.join("document.pdf");
            let copied_hash = copy_with_hash(&canonical_source, &private_source, cancellation)?;
            let after_hash = hash_file(&canonical_source)?;
            if before_hash != copied_hash || before_hash != after_hash {
                return Err(WorkspaceError::SourceChanged);
            }
            set_read_only(&private_source)?;

            let working = working_dir.join("current.pdf");
            copy_verified(&private_source, &working, &before_hash, cancellation, false)?;
            let checkpoint = checkpoints_dir.join("accepted-0.pdf");
            copy_verified(
                &private_source,
                &checkpoint,
                &before_hash,
                cancellation,
                true,
            )?;

            let working_set = source_metadata.len().saturating_mul(3);
            if working_set > MAX_WORKING_SET_BYTES {
                return Err(WorkspaceError::SourceTooLarge);
            }

            Ok(Self {
                directory: directory.clone(),
                source: private_source,
                working,
                checkpoints: checkpoints_dir,
                staging: staging_dir,
                source_hash: before_hash,
                source_bytes: source_metadata.len(),
            })
        })();

        if result.is_err() {
            let _ = remove_owned_workspace(&directory);
        }
        result
    }

    pub fn source_path(&self) -> &Path {
        &self.source
    }

    pub fn source_hash(&self) -> &str {
        &self.source_hash
    }

    pub fn source_bytes(&self) -> u64 {
        self.source_bytes
    }

    pub fn working_path(&self) -> &Path {
        &self.working
    }

    pub fn contained_path(
        &self,
        area: WorkspaceArea,
        relative: &Path,
    ) -> Result<PathBuf, WorkspaceError> {
        if relative.as_os_str().is_empty()
            || relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(WorkspaceError::PathEscapesWorkspace);
        }
        let base = match area {
            WorkspaceArea::Working => self.working.parent().ok_or(WorkspaceError::Io)?,
            WorkspaceArea::Checkpoints => &self.checkpoints,
            WorkspaceArea::Staging => &self.staging,
        };
        let candidate = base.join(relative);
        if !candidate.starts_with(base) {
            return Err(WorkspaceError::PathEscapesWorkspace);
        }
        Ok(candidate)
    }

    pub fn verify_source_hash(&self) -> Result<(), WorkspaceError> {
        if hash_file(&self.source)? == self.source_hash {
            Ok(())
        } else {
            Err(WorkspaceError::SourceChanged)
        }
    }

    pub fn cleanup(self) -> Result<(), WorkspaceError> {
        self.verify_source_hash()?;
        let marker = self.directory.join(MARKER_NAME);
        if !marker.is_file() {
            return Err(WorkspaceError::Io);
        }
        remove_owned_workspace(&self.directory)
    }
}

pub fn cleanup_owned_orphans(root: &Path, session_id: &str) -> Result<usize, WorkspaceError> {
    let canonical_root = fs::canonicalize(root).map_err(|_| WorkspaceError::Io)?;
    let mut removed = 0;
    for entry in fs::read_dir(&canonical_root).map_err(|_| WorkspaceError::Io)? {
        let entry = entry.map_err(|_| WorkspaceError::Io)?;
        let file_name = entry.file_name();
        if !file_name.to_string_lossy().starts_with(WORKSPACE_PREFIX) {
            continue;
        }
        let candidate = entry.path();
        let metadata = fs::symlink_metadata(&candidate).map_err(|_| WorkspaceError::Io)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let marker_path = candidate.join(MARKER_NAME);
        let marker_metadata = match fs::symlink_metadata(&marker_path) {
            Ok(value) if value.is_file() && !value.file_type().is_symlink() => value,
            _ => continue,
        };
        if marker_metadata.len() > 4096 {
            continue;
        }
        let marker: OwnershipMarker = match fs::read(&marker_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(value) => value,
            None => continue,
        };
        if marker.schema != WORKSPACE_SCHEMA
            || marker.owner != WORKSPACE_OWNER
            || marker.session_id != session_id
        {
            continue;
        }
        let canonical_candidate = match fs::canonicalize(&candidate) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if canonical_candidate.parent() != Some(canonical_root.as_path()) {
            continue;
        }
        remove_owned_workspace(&canonical_candidate)?;
        removed += 1;
    }
    Ok(removed)
}

fn copy_verified(
    source: &Path,
    destination: &Path,
    expected_hash: &str,
    cancellation: &CancellationToken,
    read_only: bool,
) -> Result<(), WorkspaceError> {
    let hash = copy_with_hash(source, destination, cancellation)?;
    if hash != expected_hash {
        return Err(WorkspaceError::SourceChanged);
    }
    if read_only {
        set_read_only(destination)?;
    }
    Ok(())
}

fn copy_with_hash(
    source: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
) -> Result<String, WorkspaceError> {
    let mut input = File::open(source).map_err(|_| WorkspaceError::Io)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| WorkspaceError::Io)?;
    set_private_file(destination)?;
    copy_stream_with_hash(&mut input, &mut output, cancellation)
}

fn copy_stream_with_hash<R: Read, W: Write>(
    input: &mut R,
    output: &mut W,
    cancellation: &CancellationToken,
) -> Result<String, WorkspaceError> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        cancellation.check()?;
        let count = input.read(&mut buffer).map_err(|_| WorkspaceError::Io)?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|_| WorkspaceError::Io)?;
        bytes.extend_from_slice(&buffer[..count]);
    }
    output.flush().map_err(|_| WorkspaceError::Io)?;
    sha256_reader(&mut bytes.as_slice()).map_err(|_| WorkspaceError::Io)
}

fn hash_file(path: &Path) -> Result<String, WorkspaceError> {
    let mut file = File::open(path).map_err(|_| WorkspaceError::Io)?;
    sha256_reader(&mut file).map_err(|_| WorkspaceError::Io)
}

fn write_new_file(path: &Path, bytes: &[u8], read_only: bool) -> Result<(), WorkspaceError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| WorkspaceError::Io)?;
    file.write_all(bytes).map_err(|_| WorkspaceError::Io)?;
    file.flush().map_err(|_| WorkspaceError::Io)?;
    set_private_file(path)?;
    if read_only {
        set_read_only(path)?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_directory(path: &Path) -> Result<(), WorkspaceError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| WorkspaceError::Io)
}

#[cfg(not(unix))]
fn set_private_directory(_path: &Path) -> Result<(), WorkspaceError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file(path: &Path) -> Result<(), WorkspaceError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| WorkspaceError::Io)
}

#[cfg(not(unix))]
fn set_private_file(_path: &Path) -> Result<(), WorkspaceError> {
    Ok(())
}

#[cfg(unix)]
fn set_read_only(path: &Path) -> Result<(), WorkspaceError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o400)).map_err(|_| WorkspaceError::Io)
}

#[cfg(not(unix))]
fn set_read_only(path: &Path) -> Result<(), WorkspaceError> {
    let mut permissions = fs::metadata(path)
        .map_err(|_| WorkspaceError::Io)?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).map_err(|_| WorkspaceError::Io)
}

fn remove_owned_workspace(path: &Path) -> Result<(), WorkspaceError> {
    #[cfg(windows)]
    clear_readonly_tree(path)?;
    fs::remove_dir_all(path).map_err(|_| WorkspaceError::Io)
}

#[cfg(windows)]
fn clear_readonly_tree(path: &Path) -> Result<(), WorkspaceError> {
    for entry in fs::read_dir(path).map_err(|_| WorkspaceError::Io)? {
        let entry = entry.map_err(|_| WorkspaceError::Io)?;
        let child = entry.path();
        let metadata = fs::symlink_metadata(&child).map_err(|_| WorkspaceError::Io)?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            clear_readonly_tree(&child)?;
        }
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            fs::set_permissions(&child, permissions).map_err(|_| WorkspaceError::Io)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("edit-content-{label}-{unique}"))
    }

    #[test]
    fn source_copies_are_hash_preserved_and_paths_are_contained() {
        let test_root = temp_path("workspace-test");
        let source = temp_path("source.pdf");
        fs::write(&source, b"%PDF-1.4\nfixture\n%%EOF").unwrap();
        let source_before = fs::read(&source).unwrap();
        let workspace = SessionWorkspace::create(
            &test_root,
            &source,
            "session-a",
            &CancellationToken::default(),
        )
        .unwrap();

        assert_eq!(fs::read(workspace.source_path()).unwrap(), source_before);
        assert_eq!(fs::read(workspace.working_path()).unwrap(), source_before);
        workspace.verify_source_hash().unwrap();
        assert!(workspace
            .contained_path(WorkspaceArea::Staging, Path::new("candidate.pdf"))
            .unwrap()
            .starts_with(&workspace.directory));
        assert_eq!(
            workspace.contained_path(WorkspaceArea::Staging, Path::new("../outside.pdf")),
            Err(WorkspaceError::PathEscapesWorkspace)
        );
        workspace.cleanup().unwrap();
        assert_eq!(fs::read(&source).unwrap(), source_before);
        fs::remove_file(source).unwrap();
        fs::remove_dir(test_root).unwrap();
    }

    #[test]
    fn cancellation_removes_only_the_partial_owned_workspace() {
        let test_root = temp_path("cancel-test");
        let source = temp_path("cancel-source.pdf");
        fs::write(&source, b"%PDF-1.4\nfixture\n%%EOF").unwrap();
        fs::create_dir(&test_root).unwrap();
        let unrelated = test_root.join("keep-me");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("data"), b"keep").unwrap();
        let cancellation = CancellationToken::default();
        cancellation.cancel();

        assert_eq!(
            SessionWorkspace::create(&test_root, &source, "session-a", &cancellation)
                .err()
                .unwrap(),
            WorkspaceError::Cancelled
        );
        assert_eq!(fs::read(unrelated.join("data")).unwrap(), b"keep");
        fs::remove_dir_all(test_root).unwrap();
        fs::remove_file(source).unwrap();
    }

    #[test]
    fn cancellation_is_observed_between_copy_chunks() {
        struct CancellingReader {
            token: CancellationToken,
            emitted: bool,
        }

        impl Read for CancellingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.emitted {
                    return Ok(0);
                }
                self.emitted = true;
                buffer[..4].copy_from_slice(b"data");
                self.token.cancel();
                Ok(4)
            }
        }

        let token = CancellationToken::default();
        let mut reader = CancellingReader {
            token: token.clone(),
            emitted: false,
        };
        let mut output = Vec::new();
        assert_eq!(
            copy_stream_with_hash(&mut reader, &mut output, &token),
            Err(WorkspaceError::Cancelled)
        );
        assert_eq!(output, b"data");
    }

    #[test]
    fn orphan_cleanup_requires_an_exact_marker_and_session() {
        let root = temp_path("orphan-test");
        fs::create_dir(&root).unwrap();
        let removable = root.join("edit-content-removable");
        let wrong_session = root.join("edit-content-other-session");
        let unmarked = root.join("edit-content-unmarked");
        let unrelated = root.join("unrelated");
        for path in [&removable, &wrong_session, &unmarked, &unrelated] {
            fs::create_dir(path).unwrap();
            fs::write(path.join("data"), b"keep unless owned").unwrap();
        }
        let marker = |session_id: &str| OwnershipMarker {
            schema: WORKSPACE_SCHEMA.into(),
            owner: WORKSPACE_OWNER.into(),
            session_id: session_id.into(),
            process_id: 1,
        };
        fs::write(
            removable.join(MARKER_NAME),
            serde_json::to_vec(&marker("session-a")).unwrap(),
        )
        .unwrap();
        fs::write(
            wrong_session.join(MARKER_NAME),
            serde_json::to_vec(&marker("session-b")).unwrap(),
        )
        .unwrap();

        assert_eq!(cleanup_owned_orphans(&root, "session-a").unwrap(), 1);
        assert!(!removable.exists());
        assert!(wrong_session.exists());
        assert!(unmarked.exists());
        assert!(unrelated.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
