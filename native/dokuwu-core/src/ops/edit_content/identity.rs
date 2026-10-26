//! The PDFium build Edit Content is pinned to.
//!
//! The expected pin is compiled into the app from the engine's own
//! `pdfium-artifacts.json`; the copy shipped next to the worker must say the
//! same, and the worker checks the library's hash again when it starts.

use std::path::Path;
use std::sync::OnceLock;

use serde_json::Value;

use super::EditError;

const PINNED_MANIFEST: &str = include_str!("../../../../edit-content-engine/pdfium-artifacts.json");
const MANIFEST_SCHEMA: &str = "edit-content-pdfium-artifacts/v1";
const EXPECTED_BUILD: &str = "154.0.8035.0";
const EXPECTED_WRAPPER: &str = "0.9.4";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineIdentity {
    pub build: String,
    pub wrapper: String,
    pub target: String,
    pub library_file: String,
    pub library_sha256: String,
}

impl EngineIdentity {
    /// The identity a worker states in its preparation replies.
    pub fn verification_identity(&self) -> (String, String, String) {
        (
            self.library_sha256.clone(),
            self.build.strip_suffix(".0").unwrap_or(&self.build).to_owned(),
            self.wrapper.clone(),
        )
    }
}

fn target_name() -> Result<&'static str, EditError> {
    if cfg!(not(target_arch = "x86_64")) {
        return Err(EditError::unavailable("Edit Content has no pinned PDFium artifact for this architecture"));
    }
    if cfg!(windows) {
        Ok("windows-x86_64")
    } else if cfg!(target_os = "linux") {
        Ok("linux-x86_64")
    } else {
        Err(EditError::unavailable("Edit Content has no pinned PDFium artifact for this operating system"))
    }
}

/// The identity this build of the app expects.
pub fn current() -> Result<&'static EngineIdentity, EditError> {
    static IDENTITY: OnceLock<Result<EngineIdentity, String>> = OnceLock::new();
    IDENTITY
        .get_or_init(|| parse(PINNED_MANIFEST).map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|message| EditError::unavailable(message))
}

/// Fails unless the manifest shipped at `resource_root` pins the same library.
pub fn validate_runtime(resource_root: &Path) -> Result<(), EditError> {
    let text = std::fs::read_to_string(resource_root.join("pdfium-artifacts.json"))
        .map_err(|_| EditError::unavailable("Packaged Edit Content identity is unavailable"))?;
    if &parse(&text)? != current()? {
        return Err(EditError::unavailable("Packaged Edit Content identity does not match this build"));
    }
    Ok(())
}

pub(crate) fn parse(text: &str) -> Result<EngineIdentity, EditError> {
    let invalid = || EditError::unavailable("Pinned Edit Content PDFium identity is unavailable or invalid");
    let manifest: Value = serde_json::from_str(text).map_err(|_| invalid())?;
    if manifest.get("schema").and_then(Value::as_str) != Some(MANIFEST_SCHEMA) {
        return Err(invalid());
    }
    let target = target_name()?;
    let text_of = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let pin = manifest.get("targets").and_then(|targets| targets.get(target)).ok_or_else(invalid)?;
    let build = text_of(manifest.get("buildIdentity")).ok_or_else(invalid)?;
    let wrapper = text_of(manifest.get("wrapperVersion")).ok_or_else(invalid)?;
    let library_file = text_of(pin.get("libraryFile")).ok_or_else(invalid)?;
    let library_sha256 = text_of(pin.get("librarySha256")).ok_or_else(invalid)?;
    let expected_file = if target.starts_with("windows-") { "pdfium.dll" } else { "libpdfium.so" };
    if build != EXPECTED_BUILD
        || wrapper != EXPECTED_WRAPPER
        || library_file != expected_file
        || library_sha256.len() != 64
        || !library_sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    Ok(EngineIdentity { build, wrapper, target: target.to_owned(), library_file, library_sha256 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_compiled_pin_is_valid_and_verification_identity_drops_the_patch_suffix() {
        let identity = current().expect("pin");
        assert_eq!(identity.library_sha256.len(), 64);
        let (sha, build, wrapper) = identity.verification_identity();
        assert_eq!((sha.as_str(), build.as_str(), wrapper.as_str()), (identity.library_sha256.as_str(), "154.0.8035", "0.9.4"));
    }

    #[test]
    fn a_wrong_build_or_digest_is_refused() {
        let target = target_name().unwrap();
        let manifest = |build: &str, digest: &str, file: &str| {
            format!(
                r#"{{"schema":"{MANIFEST_SCHEMA}","buildIdentity":"{build}","wrapperVersion":"0.9.4",
                "targets":{{"{target}":{{"libraryFile":"{file}","librarySha256":"{digest}"}}}}}}"#
            )
        };
        let good = "a".repeat(64);
        let file = if cfg!(windows) { "pdfium.dll" } else { "libpdfium.so" };
        assert!(parse(&manifest("154.0.8035.0", &good, file)).is_ok());
        assert!(parse(&manifest("155.0.1.0", &good, file)).is_err());
        assert!(parse(&manifest("154.0.8035.0", &"A".repeat(64), file)).is_err());
        assert!(parse(&manifest("154.0.8035.0", "abc", file)).is_err());
        assert!(parse(&manifest("154.0.8035.0", &good, "other.so")).is_err());
        assert!(parse("{}").is_err());
    }

    #[test]
    fn a_shipped_manifest_must_match_the_compiled_pin() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_runtime(dir.path()).is_err());
        std::fs::write(dir.path().join("pdfium-artifacts.json"), PINNED_MANIFEST).unwrap();
        validate_runtime(dir.path()).unwrap();
        std::fs::write(dir.path().join("pdfium-artifacts.json"), PINNED_MANIFEST.replace("154.0.8035.0", "154.0.8036.0")).unwrap();
        assert!(validate_runtime(dir.path()).is_err());
    }
}
