//! Output file names: safe stems, names that never overwrite, and `.part`
//! files that are renamed to their final name only when complete.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

const INVALID: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
    "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];
/// Extensions a user may type at the end of a name; cut off before the real
/// extension is added.
const KNOWN_EXTENSIONS: &[&str] = &["pdf", "zip", "png", "jpg", "jpeg", "webp"];

/// A file name stem that is valid on Windows: no reserved characters, no
/// trailing dots or spaces, not a reserved device name. Falls back to
/// `output` when nothing is left.
pub fn sanitize_stem(name: &str) -> String {
    let mut name = name.trim();
    if let Some((stem, ext)) = name.rsplit_once('.') {
        if KNOWN_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) {
            name = stem;
        }
    }
    let mut cleaned = String::with_capacity(name.len());
    let mut last_space = false;
    let mut last_underscore = false;
    for c in name.chars() {
        let c = if INVALID.contains(&c) || c.is_control() { '_' } else { c };
        if c.is_whitespace() {
            if !last_space {
                cleaned.push(' ');
            }
            last_space = true;
            last_underscore = false;
        } else if c == '_' {
            if !last_underscore {
                cleaned.push('_');
            }
            last_underscore = true;
            last_space = false;
        } else {
            cleaned.push(c);
            last_space = false;
            last_underscore = false;
        }
    }
    let cleaned = cleaned.trim_matches(|c| c == '.' || c == ' ').trim_matches('-').to_string();
    if cleaned.is_empty() {
        return "output".to_string();
    }
    let first = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&first.as_str()) {
        format!("_{cleaned}")
    } else {
        cleaned
    }
}

/// `<stem>.<ext>` in `dir`, or `<stem> (1).<ext>`, `<stem> (2).<ext>`, ... when
/// that name is taken.
pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}).{ext}")))
        .find(|p| !p.exists())
        .expect("an unused name exists")
}

/// A new, empty `.part` file in `dir` for output being written.
pub fn create_part(dir: &Path, stem: &str, ext: &str) -> io::Result<(File, PathBuf)> {
    for n in 0.. {
        let name = if n == 0 { format!(".{stem}.{ext}.part") } else { format!(".{stem}.{ext}.{n}.part") };
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

/// Removes a `.part` file unless it was renamed into place.
pub struct PartGuard {
    path: Option<PathBuf>,
}

impl PartGuard {
    pub fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    /// Moves the part file to `<stem>.<ext>` (or the next free name) in `dir`
    /// and returns the final path.
    pub fn publish(mut self, dir: &Path, stem: &str, ext: &str) -> io::Result<PathBuf> {
        let part = self.path.take().expect("published once");
        // Pick the name now, not when the job started, so a file that appeared
        // meanwhile is not overwritten.
        let mut last_err = None;
        for _ in 0..8 {
            let target = unique_path(dir, stem, ext);
            match rename_no_replace(&part, &target) {
                Ok(()) => return Ok(target),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last_err = Some(e),
                Err(e) => {
                    let _ = fs::remove_file(&part);
                    return Err(e);
                }
            }
        }
        let _ = fs::remove_file(&part);
        Err(last_err.unwrap_or_else(|| io::Error::new(io::ErrorKind::AlreadyExists, "no free name")))
    }
}

impl Drop for PartGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

/// Renames `from` to `to`, failing with `AlreadyExists` instead of replacing.
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    // A hard link fails when the target exists and is atomic; fall back to a
    // plain rename where links are not supported.
    match fs::hard_link(from, to) {
        Ok(()) => fs::remove_file(from),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
        Err(_) => {
            if to.exists() {
                Err(io::Error::from(io::ErrorKind::AlreadyExists))
            } else {
                fs::rename(from, to)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_are_made_safe() {
        assert_eq!(sanitize_stem("report.pdf"), "report");
        assert_eq!(sanitize_stem("  a/b:c  "), "a_b_c");
        assert_eq!(sanitize_stem("x   y"), "x y");
        assert_eq!(sanitize_stem("v1.2"), "v1.2");
        assert_eq!(sanitize_stem("...."), "output");
        assert_eq!(sanitize_stem(""), "output");
        assert_eq!(sanitize_stem("con"), "_con");
        assert_eq!(sanitize_stem("Laporan Keuangan 2025"), "Laporan Keuangan 2025");
    }

    #[test]
    fn unique_path_counts_up() {
        let dir = tempfile::tempdir().unwrap();
        let first = unique_path(dir.path(), "x", "png");
        assert_eq!(first, dir.path().join("x.png"));
        fs::write(&first, b"1").unwrap();
        assert_eq!(unique_path(dir.path(), "x", "png"), dir.path().join("x (1).png"));
    }

    #[test]
    fn publish_never_replaces_and_guard_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("x.zip"), b"old").unwrap();
        let (mut file, part) = create_part(dir.path(), "x", "zip").unwrap();
        io::Write::write_all(&mut file, b"new").unwrap();
        drop(file);
        let out = PartGuard::new(part.clone()).publish(dir.path(), "x", "zip").unwrap();
        assert_eq!(out, dir.path().join("x (1).zip"));
        assert_eq!(fs::read(dir.path().join("x.zip")).unwrap(), b"old");
        assert!(!part.exists());

        let (_f, part) = create_part(dir.path(), "y", "zip").unwrap();
        drop(PartGuard::new(part.clone()));
        assert!(!part.exists());
    }
}
