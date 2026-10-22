//! Listing a folder's PDFs for the Merge workspace, and the rules for turning
//! names from that list back into files.
//!
//! The whole subtree is read in one pass and only names are read: browsing
//! never opens a document, so a damaged or encrypted PDF cannot break the tree.
//! Symbolic links, Windows junctions and other reparse points are not followed,
//! and a depth cap plus a visited-entry cap bound the walk so a pathological
//! tree cannot hang it. Anything that cannot be read is skipped and counted
//! instead of silently dropped.
//!
//! The workspace refers to files by their path relative to the chosen folder.
//! [`resolve_within_root`] is the trust boundary for that: it refuses anything
//! that is not a PDF inside the folder, before and after resolving links.

use std::fs::{self, Metadata};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;
use crate::ops::natural_sort::compare_names;

/// Generous backstops, not functional limits: deep enough for any real document
/// tree, shallow enough that a loop cannot run away if one is ever reached.
pub const MAX_DEPTH: usize = 32;
pub const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub name: String,
    /// Path from the chosen folder, with `/` between names; empty for the root.
    pub relative_path: String,
    /// PDFs in this folder and below.
    pub pdf_count: u32,
    pub folders: Vec<FolderNode>,
    /// File names, in natural order.
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: FolderNode,
    pub pdf_count: u32,
    /// Entries that could not be read.
    pub skipped: u32,
    pub depth_capped: bool,
    pub entry_capped: bool,
}

#[derive(Default)]
struct Walk {
    visited: usize,
    skipped: u32,
    depth_capped: bool,
    entry_capped: bool,
    max_depth: usize,
    max_entries: usize,
}

pub fn scan_folder(root: &Path, ctx: &JobContext) -> CoreResult<ScanResult> {
    scan_with_limits(root, ctx, MAX_DEPTH, MAX_ENTRIES)
}

pub(crate) fn scan_with_limits(root: &Path, ctx: &JobContext, max_depth: usize, max_entries: usize) -> CoreResult<ScanResult> {
    if !root.is_dir() {
        return Err(CoreError::InvalidInput("That folder does not exist or is not a folder.".into()));
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string());
    let mut walk = Walk { max_depth, max_entries, ..Walk::default() };
    let node = scan_directory(root, &name, "", 0, &mut walk, ctx)?;
    // The root is always shown, even when it holds no PDF, so the interface can
    // say so instead of appearing to have failed.
    let root_node = node.unwrap_or_else(|| FolderNode {
        name,
        relative_path: String::new(),
        pdf_count: 0,
        folders: Vec::new(),
        files: Vec::new(),
    });
    Ok(ScanResult {
        pdf_count: root_node.pdf_count,
        root: root_node,
        skipped: walk.skipped,
        depth_capped: walk.depth_capped,
        entry_capped: walk.entry_capped,
    })
}

/// The node for `path`, or `None` when it holds no PDF at all.
fn scan_directory(
    path: &Path,
    name: &str,
    relative: &str,
    depth: usize,
    walk: &mut Walk,
    ctx: &JobContext,
) -> CoreResult<Option<FolderNode>> {
    if depth > walk.max_depth {
        walk.depth_capped = true;
        return Ok(None);
    }
    ctx.check_cancelled()?;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => {
            walk.skipped += 1;
            return Ok(None);
        }
    };
    let mut folders = Vec::new();
    let mut files = Vec::new();
    for entry in entries {
        if walk.visited >= walk.max_entries {
            walk.entry_capped = true;
            break;
        }
        walk.visited += 1;
        let Ok(entry) = entry else {
            walk.skipped += 1;
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            walk.skipped += 1;
            continue;
        };
        // Never descend through a link, junction or other reparse point.
        if is_link(&meta) {
            continue;
        }
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        if meta.is_dir() {
            let child_relative = if relative.is_empty() { entry_name.clone() } else { format!("{relative}/{entry_name}") };
            if let Some(child) = scan_directory(&entry.path(), &entry_name, &child_relative, depth + 1, walk, ctx)? {
                folders.push(child);
            }
        } else if meta.is_file() && has_pdf_suffix(&entry_name) {
            files.push(entry_name);
        }
    }
    folders.sort_by(|a, b| compare_names(&a.name, &b.name));
    files.sort_by(|a, b| compare_names(a, b));
    // A folder with no PDF anywhere below it is not worth showing.
    if folders.is_empty() && files.is_empty() {
        return Ok(None);
    }
    let pdf_count = files.len() as u32 + folders.iter().map(|f| f.pdf_count).sum::<u32>();
    Ok(Some(FolderNode { name: name.to_string(), relative_path: relative.to_string(), pdf_count, folders, files }))
}

fn has_pdf_suffix(name: &str) -> bool {
    name.to_lowercase().ends_with(".pdf")
}

/// True for a symbolic link, a Windows junction, or another reparse point.
fn is_link(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// Turns names from the list back into files inside `root`.
pub fn resolve_all(root: &Path, relatives: &[String]) -> CoreResult<Vec<PathBuf>> {
    let root = fs::canonicalize(root).map_err(|e| CoreError::io(root, e)).map(simplify)?;
    relatives.iter().map(|relative| resolve_resolved(&root, relative)).collect()
}

/// One name from the list: `relative` must be a PDF inside `root`.
pub fn resolve_within_root(root: &Path, relative: &str) -> CoreResult<PathBuf> {
    let root = fs::canonicalize(root).map_err(|e| CoreError::io(root, e)).map(simplify)?;
    resolve_resolved(&root, relative)
}

fn resolve_resolved(root: &Path, relative: &str) -> CoreResult<PathBuf> {
    let outside = || CoreError::InvalidInput("Use a file inside the chosen folder.".into());
    if looks_foreign(relative) {
        return Err(outside());
    }
    if !has_pdf_suffix(relative) {
        return Err(CoreError::InvalidInput("Only PDF files can be merged.".into()));
    }
    let joined = root.join(relative);
    // Resolve links, so one that leaves the folder is refused, not followed. A
    // file that does not exist yet is resolved through its folder, and reported
    // as missing later.
    let resolved = match fs::canonicalize(&joined) {
        Ok(path) => simplify(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = joined.parent().ok_or_else(outside)?;
            let name = joined.file_name().ok_or_else(outside)?;
            match fs::canonicalize(parent) {
                Ok(parent) => simplify(parent).join(name),
                Err(_) => return Err(CoreError::NotFound { path: joined }),
            }
        }
        Err(e) => return Err(CoreError::io(&joined, e)),
    };
    if !resolved.starts_with(root) {
        return Err(CoreError::InvalidInput("That file is outside the chosen folder.".into()));
    }
    Ok(resolved)
}

/// True when `value` is anything but a path inside the folder: empty, absolute,
/// UNC or device forms, a drive (`C:notes.pdf`), or a way up (`..`).
fn looks_foreign(value: &str) -> bool {
    if value.trim().is_empty() || value.contains('\0') || value.contains(':') {
        return true;
    }
    if value.starts_with('/') || value.starts_with('\\') {
        return true;
    }
    if Path::new(value).is_absolute() {
        return true;
    }
    value.split(['/', '\\']).any(|segment| segment == "..")
        || Path::new(value).components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
}

/// Windows resolves to `\\?\C:\...`; drop the prefix where a plain path exists.
fn simplify(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            let bytes = rest.as_bytes();
            if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
                return PathBuf::from(rest);
            }
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"%PDF-1.4").unwrap();
    }

    fn scan(root: &Path) -> ScanResult {
        scan_folder(root, &JobContext::detached()).unwrap()
    }

    #[test]
    fn lists_pdfs_in_natural_order_and_prunes_empty_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for name in ["b10.pdf", "b2.PDF", "a.pdf", "note.txt"] {
            touch(&root.join(name));
        }
        touch(&root.join("Sub").join("x.pdf"));
        touch(&root.join("Sub").join("deeper").join("y.pdf"));
        fs::create_dir_all(root.join("empty")).unwrap();
        touch(&root.join("docs-only").join("a.txt"));

        let result = scan(root);
        assert_eq!(result.pdf_count, 5);
        assert_eq!(result.root.files, ["a.pdf", "b2.PDF", "b10.pdf"]);
        assert_eq!(result.root.folders.len(), 1);
        let sub = &result.root.folders[0];
        assert_eq!((sub.name.as_str(), sub.relative_path.as_str(), sub.pdf_count), ("Sub", "Sub", 2));
        assert_eq!(sub.folders[0].relative_path, "Sub/deeper");
        assert!(!result.depth_capped && !result.entry_capped);
    }

    #[test]
    fn root_is_shown_even_without_pdfs() {
        let dir = tempfile::tempdir().unwrap();
        let result = scan(dir.path());
        assert_eq!(result.pdf_count, 0);
        assert!(result.root.files.is_empty() && result.root.folders.is_empty());
    }

    #[test]
    fn missing_root_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = scan_folder(&dir.path().join("nope"), &JobContext::detached()).unwrap_err();
        assert_eq!(err.code(), "invalid_input");
    }

    #[test]
    fn depth_cap_stops_the_walk_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let mut deep = dir.path().to_path_buf();
        for i in 0..6 {
            deep = deep.join(format!("d{i}"));
        }
        touch(&deep.join("deep.pdf"));
        touch(&dir.path().join("top.pdf"));
        let result = scan_with_limits(dir.path(), &JobContext::detached(), 3, MAX_ENTRIES).unwrap();
        assert!(result.depth_capped);
        assert_eq!(result.pdf_count, 1);
    }

    #[test]
    fn entry_cap_stops_the_walk_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..20 {
            touch(&dir.path().join(format!("f{i}.pdf")));
        }
        let result = scan_with_limits(dir.path(), &JobContext::detached(), MAX_DEPTH, 8).unwrap();
        assert!(result.entry_capped);
        assert_eq!(result.pdf_count, 8);
    }

    #[test]
    fn cancelling_stops_the_walk() {
        let dir = tempfile::tempdir().unwrap();
        touch(&dir.path().join("a.pdf"));
        let token = crate::job::CancelToken::new();
        token.cancel();
        let ctx = JobContext::new(1, token, None);
        assert!(scan_folder(dir.path(), &ctx).unwrap_err().is_cancelled());
    }

    #[cfg(unix)]
    #[test]
    fn links_are_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        touch(&outside.path().join("secret.pdf"));
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.pdf"), dir.path().join("alias.pdf")).unwrap();
        touch(&dir.path().join("real.pdf"));
        let result = scan(dir.path());
        assert_eq!(result.root.files, ["real.pdf"]);
        assert!(result.root.folders.is_empty());
    }

    #[test]
    fn resolves_names_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        touch(&dir.path().join("Sub").join("x.pdf"));
        let paths = resolve_all(dir.path(), &["Sub/x.pdf".to_string()]).unwrap();
        assert!(paths[0].ends_with("Sub/x.pdf") || paths[0].ends_with(r"Sub\x.pdf"));
        assert!(paths[0].is_file());
    }

    #[test]
    fn a_missing_file_resolves_so_it_can_be_reported_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = resolve_within_root(dir.path(), "gone.pdf").unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn foreign_shapes_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        touch(&dir.path().join("a.pdf"));
        for bad in [
            "",
            "  ",
            "../a.pdf",
            "Sub/../../a.pdf",
            "..\\a.pdf",
            "/etc/a.pdf",
            "\\\\server\\share\\a.pdf",
            "C:\\a.pdf",
            "C:a.pdf",
            "a.pdf:stream.pdf",
            "a.txt",
            "a.pdf\0.pdf",
        ] {
            assert!(resolve_within_root(dir.path(), bad).is_err(), "{bad:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_leaving_the_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        touch(&outside.path().join("secret.pdf"));
        std::os::unix::fs::symlink(outside.path().join("secret.pdf"), dir.path().join("alias.pdf")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        assert!(resolve_within_root(dir.path(), "alias.pdf").is_err());
        assert!(resolve_within_root(dir.path(), "link/secret.pdf").is_err());
        assert!(resolve_within_root(dir.path(), "link/missing.pdf").is_err());
    }
}
