//! Housekeeping: clearing what Dokuwu leaves in temporary folders.
//!
//! Core jobs scratch in the OS temp folder under folders named `dokuwu-*`; the
//! old sidecar used `~/PDFManager/{temp,output}`. [`AppDirs`] names all of them
//! in one place so the cleanup and the code that creates folders cannot drift
//! apart. Nothing outside those places is ever touched, and the font library
//! (`~/PDFManager/data`) is not a cleanup target.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

use serde::Serialize;

/// Every scratch folder the core creates in the OS temp folder starts with this.
pub const SCRATCH_PREFIX: &str = "dokuwu-";

/// Where Dokuwu keeps temporary files.
#[derive(Debug, Clone)]
pub struct AppDirs {
    /// `~/PDFManager/temp` of the old sidecar.
    pub legacy_temp: PathBuf,
    /// `~/PDFManager/output` of the old sidecar.
    pub legacy_output: PathBuf,
    /// The OS temp folder, where `dokuwu-*` scratch folders live.
    pub os_temp: PathBuf,
}

impl AppDirs {
    pub fn detect() -> Self {
        let legacy = home_dir().map(|h| h.join("PDFManager"));
        Self {
            legacy_temp: legacy.as_ref().map(|d| d.join("temp")).unwrap_or_default(),
            legacy_output: legacy.as_ref().map(|d| d.join("output")).unwrap_or_default(),
            os_temp: std::env::temp_dir(),
        }
    }
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// How much to remove.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// The user asked: all legacy files and every `dokuwu-*` scratch folder.
    All,
    /// App exit: the legacy folders, and scratch folders made by this process
    /// (their names carry the process id), so another running copy is left alone.
    Exit { pid: u32 },
    /// App start: scratch folders last changed more than `min_age` ago, which
    /// a crashed earlier run left behind.
    Stale { min_age: Duration },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearReport {
    pub files_deleted: u64,
    pub bytes_freed: u64,
    /// Entries that could not be removed (locked on Windows, or no permission).
    pub skipped: u64,
}

/// Removes temporary files according to `scope`. Never fails: an entry that
/// cannot be removed is counted in `skipped`.
pub fn clear_temp(dirs: &AppDirs, scope: Scope) -> ClearReport {
    let mut report = ClearReport::default();
    if !matches!(scope, Scope::Stale { .. }) {
        for legacy in [&dirs.legacy_temp, &dirs.legacy_output] {
            if legacy.as_os_str().is_empty() {
                continue;
            }
            clear_contents(legacy, &mut report);
        }
    }
    if let Ok(entries) = fs::read_dir(&dirs.os_temp) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with(SCRATCH_PREFIX) || !is_selected(&entry, &name, scope) {
                continue;
            }
            remove_entry(&entry.path(), &mut report);
        }
    }
    report
}

fn is_selected(entry: &fs::DirEntry, name: &str, scope: Scope) -> bool {
    match scope {
        Scope::All => true,
        Scope::Exit { pid } => name_has_pid(name, pid),
        Scope::Stale { min_age } => entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age >= min_age),
    }
}

/// `dokuwu-<kind>-<pid>-<n>`: true when the third dash-separated part is `pid`.
fn name_has_pid(name: &str, pid: u32) -> bool {
    name.split('-').nth(2).is_some_and(|part| part == pid.to_string())
}

fn clear_contents(dir: &Path, report: &mut ClearReport) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            remove_entry(&entry.path(), report);
        }
    }
}

/// Removes a file or a folder tree. A virus scanner or indexer can hold a fresh
/// file for a moment on Windows, so one entry is retried once after 200 ms.
fn remove_entry(path: &Path, report: &mut ClearReport) {
    for attempt in 0..2 {
        let mut part = ClearReport::default();
        match remove_tree(path, &mut part) {
            Ok(()) => {
                report.files_deleted += part.files_deleted;
                report.bytes_freed += part.bytes_freed;
                return;
            }
            Err(_) if attempt == 0 => thread::sleep(Duration::from_millis(200)),
            Err(_) => {
                report.files_deleted += part.files_deleted;
                report.bytes_freed += part.bytes_freed;
                report.skipped += 1;
            }
        }
    }
}

fn remove_tree(path: &Path, part: &mut ClearReport) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        let mut failed = None;
        for entry in fs::read_dir(path)? {
            if let Err(e) = remove_tree(&entry?.path(), part) {
                failed = Some(e);
            }
        }
        if let Some(e) = failed {
            return Err(e);
        }
        fs::remove_dir(path)
    } else {
        let size = meta.len();
        fs::remove_file(path)?;
        part.files_deleted += 1;
        part.bytes_freed += size;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(root: &Path) -> AppDirs {
        let d = AppDirs {
            legacy_temp: root.join("PDFManager/temp"),
            legacy_output: root.join("PDFManager/output"),
            os_temp: root.join("ostemp"),
        };
        for p in [&d.legacy_temp, &d.legacy_output, &d.os_temp, &root.join("PDFManager/data")] {
            fs::create_dir_all(p).unwrap();
        }
        d
    }

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![7u8; bytes]).unwrap();
    }

    #[test]
    fn all_removes_legacy_files_and_scratch_folders_and_counts_them() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        write(&d.legacy_temp.join("a.pdf"), 10);
        write(&d.legacy_output.join("sub/b.pdf"), 20);
        write(&d.os_temp.join("dokuwu-compress-1-0/work.pdf"), 30);

        let report = clear_temp(&d, Scope::All);

        assert_eq!(report, ClearReport { files_deleted: 3, bytes_freed: 60, skipped: 0 });
        assert_eq!(fs::read_dir(&d.legacy_temp).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&d.legacy_output).unwrap().count(), 0);
        assert!(!d.os_temp.join("dokuwu-compress-1-0").exists());
        assert!(d.legacy_temp.exists(), "the folders themselves stay");
    }

    #[test]
    fn foreign_folders_and_the_font_library_survive() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        write(&d.os_temp.join("other-app/keep.bin"), 5);
        write(&d.os_temp.join("dokuwu"), 5); // no dash after the prefix word: not ours either
        write(&root.path().join("PDFManager/data/fonts/f.ttf"), 5);

        let report = clear_temp(&d, Scope::All);

        assert_eq!(report.files_deleted, 0);
        assert!(d.os_temp.join("other-app/keep.bin").exists());
        assert!(d.os_temp.join("dokuwu").exists());
        assert!(root.path().join("PDFManager/data/fonts/f.ttf").exists());
    }

    #[test]
    fn exit_removes_only_this_process_scratch_folders() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        write(&d.os_temp.join("dokuwu-compress-4242-0/a"), 1);
        write(&d.os_temp.join("dokuwu-compress-9999-0/b"), 1);
        write(&d.legacy_output.join("c.pdf"), 1);

        let report = clear_temp(&d, Scope::Exit { pid: 4242 });

        assert_eq!(report.files_deleted, 2);
        assert!(!d.os_temp.join("dokuwu-compress-4242-0").exists());
        assert!(d.os_temp.join("dokuwu-compress-9999-0/b").exists());
    }

    #[test]
    fn stale_removes_only_old_scratch_folders_and_leaves_legacy_alone() {
        let root = tempfile::tempdir().unwrap();
        let d = dirs(root.path());
        write(&d.os_temp.join("dokuwu-compress-1-0/a"), 1);
        write(&d.legacy_temp.join("x.pdf"), 1);

        let young = clear_temp(&d, Scope::Stale { min_age: Duration::from_secs(3600) });
        assert_eq!(young.files_deleted, 0);
        assert!(d.os_temp.join("dokuwu-compress-1-0").exists());

        let old = clear_temp(&d, Scope::Stale { min_age: Duration::ZERO });
        assert_eq!(old.files_deleted, 1);
        assert!(d.legacy_temp.join("x.pdf").exists());
    }

    #[test]
    fn missing_folders_are_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        let d = AppDirs {
            legacy_temp: root.path().join("none/temp"),
            legacy_output: PathBuf::new(),
            os_temp: root.path().join("none/ostemp"),
        };
        assert_eq!(clear_temp(&d, Scope::All), ClearReport::default());
    }

    #[test]
    fn pid_is_read_from_the_third_part() {
        assert!(name_has_pid("dokuwu-compress-77-3", 77));
        assert!(!name_has_pid("dokuwu-compress-777-3", 77));
        assert!(!name_has_pid("dokuwu-sizes", 77));
    }
}
