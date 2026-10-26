//! Opens PDFs that only carry owner-password permissions.
//!
//! A PDF with an empty open password opens in any viewer without asking, but
//! its owner password still restricts editing. Edit Content writes a new PDF,
//! so the edit session works on an unprotected private copy of the chosen
//! file and the result has no permission restrictions. A PDF that needs a real
//! password is left alone and is still rejected.

use std::fs;
use std::path::Path;

use mupdf::pdf::{Encryption, PdfDocument, PdfWriteOptions};

use crate::ops::pdf_protect::is_encrypted;

/// Replaces `path` by an unprotected copy when no password is needed to open
/// it. Returns true when the file was rewritten, and false, leaving the file
/// untouched, for an unprotected PDF, a PDF that needs a password, or a file
/// that cannot be read (the normal rejection path reports those).
pub fn unlock_permission_only(path: &Path) -> bool {
    let Some(name) = path.file_name() else { return false };
    let unlocked = path.with_file_name(format!("{}.unlocked", name.to_string_lossy()));
    let rewritten = (|| -> Option<()> {
        let doc = PdfDocument::open(path.to_str()?).ok()?;
        // An owner-only file opens by itself and does not ask for a password;
        // the encryption dictionary in the trailer still names it.
        if doc.needs_password().ok()? || !is_encrypted(&doc).ok()? {
            return None;
        }
        let mut write = PdfWriteOptions::default();
        write.set_garbage_level(0).set_compress(false);
        write.set_encryption(Encryption::None);
        doc.save_with_options(unlocked.to_str()?, write).ok()?;
        drop(doc);
        fs::rename(&unlocked, path).ok()
    })();
    let _ = fs::remove_file(&unlocked);
    rewritten.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mupdf::pdf::PdfDocument;

    fn pdf(path: &Path, protection: Option<(&str, &str)>) {
        let mut doc = PdfDocument::new();
        doc.new_page(mupdf::Size::new(100.0, 100.0)).unwrap();
        let mut write = PdfWriteOptions::default();
        if let Some((user, owner)) = protection {
            write.set_encryption(Encryption::Aes256);
            write.set_user_password(user);
            write.set_owner_password(owner);
        }
        doc.save_with_options(path.to_str().unwrap(), write).unwrap();
    }

    fn encrypted(path: &Path) -> bool {
        let doc = PdfDocument::open(path.to_str().unwrap()).unwrap();
        is_encrypted(&doc).unwrap()
    }

    #[test]
    fn an_owner_only_pdf_becomes_an_unprotected_copy() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("restricted.pdf");
        pdf(&source, Some(("", "owner")));
        assert!(encrypted(&source));
        assert!(unlock_permission_only(&source));
        assert!(!encrypted(&source));
        assert_eq!(PdfDocument::open(source.to_str().unwrap()).unwrap().page_count().unwrap(), 1);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn an_unprotected_pdf_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("plain.pdf");
        pdf(&source, None);
        let before = fs::read(&source).unwrap();
        assert!(!unlock_permission_only(&source));
        assert_eq!(fs::read(&source).unwrap(), before);
    }

    #[test]
    fn a_pdf_that_needs_a_password_stays_protected() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("secret.pdf");
        pdf(&source, Some(("secret", "owner")));
        let before = fs::read(&source).unwrap();
        assert!(!unlock_permission_only(&source));
        assert_eq!(fs::read(&source).unwrap(), before);
    }

    #[test]
    fn an_unreadable_file_is_left_for_the_normal_rejection() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("broken.pdf");
        fs::write(&source, b"%PDF-1.7\nnot really a pdf").unwrap();
        assert!(!unlock_permission_only(&source));
        assert!(!unlock_permission_only(&dir.path().join("missing.pdf")));
    }
}
