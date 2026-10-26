//! Classifies why a PDF could not be opened by Edit Content.
//!
//! Runs only on the failure path, reads the file with MuPDF and never writes.

use std::path::Path;

use mupdf::Document;

pub const ENCRYPTED: &str = "PDF_ENCRYPTED";
pub const UNREADABLE: &str = "PDF_UNREADABLE";
pub const UNSUPPORTED: &str = "REJECTED_UNSUPPORTED_STRUCTURE";

/// The most specific reason code for a PDF the engine rejected.
pub fn diagnose_rejected_source(source: &Path) -> &'static str {
    let Some(path) = source.to_str() else { return UNREADABLE };
    match Document::open(path) {
        Err(_) => UNREADABLE,
        Ok(document) => match document.needs_password() {
            Ok(true) => ENCRYPTED,
            Ok(false) => UNSUPPORTED,
            Err(_) => UNREADABLE,
        },
    }
}

/// The message shown for each stable failure code.
pub fn failure_message(code: &str) -> Option<&'static str> {
    Some(match code {
        ENCRYPTED => "This PDF is encrypted or permission-protected, so Edit Content cannot inspect its fonts safely. Remove the protection first (Protect PDF > Remove Password), then open it again.",
        UNREADABLE => "Edit Content could not read the structure of this PDF. The file may be damaged or malformed.",
        UNSUPPORTED => "Edit Content V1 cannot safely edit this PDF because its font or page resources are outside the supported structure.",
        "ENGINE_START_FAILED" => "The editing engine could not be started. Please try again; if it keeps failing, restart the app.",
        "OPEN_TIMEOUT" => "The editing engine took too long to open this PDF. Please try again.",
        "INSPECT_TIMEOUT" => "The editing engine took too long to analyse this PDF. Please try again.",
        "ENGINE_UNAVAILABLE" => "Edit Content engine is unavailable.",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_damaged_file_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(diagnose_rejected_source(&dir.path().join("missing.pdf")), UNREADABLE);
        let damaged = dir.path().join("damaged.pdf");
        std::fs::write(&damaged, b"%PDF-1.4\nnot really a pdf").unwrap();
        assert_eq!(diagnose_rejected_source(&damaged), UNREADABLE);
    }

    #[test]
    fn every_open_failure_code_has_a_message() {
        for code in [ENCRYPTED, UNREADABLE, UNSUPPORTED, "ENGINE_START_FAILED", "OPEN_TIMEOUT", "INSPECT_TIMEOUT", "ENGINE_UNAVAILABLE"] {
            assert!(failure_message(code).is_some(), "{code}");
        }
        assert!(failure_message("SOMETHING_ELSE").is_none());
    }
}
