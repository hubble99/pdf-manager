//! Add and remove a PDF password (`ops::pdf_protect`).

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use common::{write_pdf, PageSpec};
use dokuwu_core::job::{CancelToken, JobContext};
use dokuwu_core::ops::pdf_protect::{
    permissions, protect, remove_password, ProtectOptions, UnprotectOptions, ALREADY_ENCRYPTED, NOT_ENCRYPTED,
};
use dokuwu_core::CoreError;
use mupdf::pdf::{Encryption, PdfDocument, PdfWriteOptions, Permission};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf-compress").join(name)
}

fn sample(dir: &tempfile::TempDir, name: &str, pages: usize) -> PathBuf {
    let specs: Vec<PageSpec> = (0..pages).map(|_| PageSpec::new(200.0, 100.0, "0 0 0 rg 10 10 50 50 re f")).collect();
    write_pdf(dir, name, &specs, Some("Secret title"))
}

fn options(dir: &Path, user: &str, owner: &str) -> ProtectOptions {
    ProtectOptions {
        user_password: user.into(),
        owner_password: owner.into(),
        allow_print: true,
        allow_copy: true,
        allow_modify: true,
        output_dir: dir.to_path_buf(),
        output_name: None,
    }
}

fn unlock_options(dir: &Path, password: &str) -> UnprotectOptions {
    UnprotectOptions { password: password.into(), output_dir: dir.to_path_buf(), output_name: None }
}

fn ctx() -> JobContext {
    JobContext::detached()
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

/// The /P value of the encryption dictionary, as the unsigned 32 bits PDF defines.
fn p_bits(path: &Path) -> u32 {
    let doc = open(path);
    let encrypt = doc.trailer().unwrap().get_dict("Encrypt").unwrap().expect("an encryption dictionary");
    encrypt.get_dict("P").unwrap().unwrap().as_int().unwrap() as u32
}

fn open(path: &Path) -> PdfDocument {
    PdfDocument::open(path.to_str().unwrap()).unwrap()
}

#[test]
fn a_protected_copy_asks_for_the_password_and_keeps_the_pages() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = sample(&src, "doc.pdf", 3);
    let before = std::fs::read(&pdf).unwrap();

    let report = protect(&pdf, &options(out.path(), "open-me", "owner-pw"), &ctx()).unwrap();
    assert_eq!(report.output_path, out.path().join("doc_protected.pdf"));
    assert_eq!(report.pages, 3);
    assert_eq!(report.output_size_bytes, std::fs::metadata(&report.output_path).unwrap().len());
    assert_eq!(names(out.path()), vec!["doc_protected.pdf"]);
    assert_eq!(std::fs::read(&pdf).unwrap(), before, "the original is unchanged");

    let mut copy = open(&report.output_path);
    assert!(copy.needs_password().unwrap());
    assert!(!copy.authenticate("wrong").unwrap());
    assert!(copy.authenticate("open-me").unwrap());
    assert_eq!(copy.page_count().unwrap(), 3);
    // The text of the file is not readable without the password.
    let raw = std::fs::read(&report.output_path).unwrap();
    assert!(!raw.windows(12).any(|w| w == b"Secret title"));
    // AES-256 (revision 6): the encryption dictionary says V 5.
    let text = String::from_utf8_lossy(&raw);
    assert!(text.contains("/V 5") || text.contains("/V5"), "AES-256 dictionary");
}

#[test]
fn the_owner_password_also_opens_and_defaults_to_the_user_password() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = sample(&src, "doc.pdf", 1);

    let with_owner = protect(&pdf, &options(out.path(), "u", "o"), &ctx()).unwrap();
    let mut copy = open(&with_owner.output_path);
    assert!(copy.authenticate("o").unwrap());

    let mut opts = options(out.path(), "same", "");
    opts.output_name = Some("single".into());
    let defaulted = protect(&pdf, &opts, &ctx()).unwrap();
    let mut copy = open(&defaulted.output_path);
    assert!(copy.authenticate("same").unwrap());
}

#[test]
fn permissions_are_written_as_chosen() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = sample(&src, "doc.pdf", 1);

    let mut opts = options(out.path(), "pw", "owner");
    opts.allow_copy = false;
    opts.allow_modify = false;
    opts.output_name = Some("restricted".into());
    let restricted = protect(&pdf, &opts, &ctx()).unwrap();
    let p = p_bits(&restricted.output_path);
    let has = |perm: Permission| p & perm.bits() == perm.bits();
    assert!(has(Permission::PRINT) && has(Permission::PRINT_HQ) && has(Permission::ACCESSIBILITY), "{p:#x}");
    for denied in [Permission::COPY, Permission::MODIFY, Permission::ANNOTATE, Permission::ASSEMBLE, Permission::FORM] {
        let bits = denied.bits();
        assert_eq!(p & bits, 0, "permission bit {bits:#x} should be forbidden in {p:#x}");
    }

    let mut opts = options(out.path(), "pw", "owner");
    opts.allow_print = false;
    opts.output_name = Some("noprint".into());
    let no_print = protect(&pdf, &opts, &ctx()).unwrap();
    let p = p_bits(&no_print.output_path);
    assert_eq!(p & (Permission::PRINT.bits() | Permission::PRINT_HQ.bits()), 0, "{p:#x}");
    assert_eq!(p & (Permission::COPY.bits() | Permission::MODIFY.bits()), Permission::COPY.bits() | Permission::MODIFY.bits());

    assert_eq!(permissions(false, false, false).bits(), Permission::ACCESSIBILITY.bits());
}

#[test]
fn removing_the_password_gives_an_open_copy_with_the_same_pages() {
    let src = tempfile::tempdir().unwrap();
    let mid = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = sample(&src, "doc.pdf", 4);
    let protected = protect(&pdf, &options(mid.path(), "pw", "owner"), &ctx()).unwrap();

    // The user password and the owner password both unlock.
    let report = remove_password(&protected.output_path, &unlock_options(out.path(), "pw"), &ctx()).unwrap();
    assert_eq!(report.output_path, out.path().join("doc_protected_unlocked.pdf"));
    assert_eq!(report.pages, 4);
    let copy = open(&report.output_path);
    assert!(!copy.needs_password().unwrap());
    assert_eq!(copy.page_count().unwrap(), 4);
    let again = remove_password(&protected.output_path, &unlock_options(out.path(), "owner"), &ctx()).unwrap();
    assert_eq!(again.output_path, out.path().join("doc_protected_unlocked (1).pdf"));
}

#[test]
fn a_wrong_password_writes_nothing() {
    let src = tempfile::tempdir().unwrap();
    let mid = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let protected = protect(&sample(&src, "doc.pdf", 1), &options(mid.path(), "pw", ""), &ctx()).unwrap();

    let err = remove_password(&protected.output_path, &unlock_options(out.path(), "nope"), &ctx()).unwrap_err();
    assert_eq!(err.code(), "password_required");
    assert!(names(out.path()).is_empty());
    // The empty password does not unlock either.
    assert_eq!(remove_password(&protected.output_path, &unlock_options(out.path(), ""), &ctx()).unwrap_err().code(), "password_required");
}

#[test]
fn an_owner_password_only_file_needs_that_password_to_be_unlocked() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = sample(&src, "doc.pdf", 2);
    let restricted = src.path().join("restricted.pdf");
    let doc = open(&pdf);
    let mut write = PdfWriteOptions::default();
    write.set_encryption(Encryption::Aes256);
    write.set_user_password("");
    write.set_owner_password("boss");
    write.set_permissions(Permission::ACCESSIBILITY);
    doc.save_with_options(restricted.to_str().unwrap(), write).unwrap();
    assert!(!open(&restricted).needs_password().unwrap(), "opens without a password");

    // Counts as encrypted for both operations.
    let err = protect(&restricted, &options(out.path(), "pw", ""), &ctx()).unwrap_err();
    assert!(matches!(&err, CoreError::InvalidInput(m) if m == ALREADY_ENCRYPTED), "{err}");
    assert_eq!(remove_password(&restricted, &unlock_options(out.path(), "guess"), &ctx()).unwrap_err().code(), "password_required");
    let report = remove_password(&restricted, &unlock_options(out.path(), "boss"), &ctx()).unwrap();
    let copy = open(&report.output_path);
    assert!(copy.permissions().contains(Permission::COPY), "the restrictions are gone");
}

#[test]
fn the_old_messages_are_kept_for_encrypted_and_plain_inputs() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let plain = sample(&src, "doc.pdf", 1);
    let err = remove_password(&plain, &unlock_options(out.path(), "x"), &ctx()).unwrap_err();
    assert!(matches!(&err, CoreError::InvalidInput(m) if m == NOT_ENCRYPTED), "{err}");

    let locked = fixture("encrypted.pdf");
    let err = protect(&locked, &options(out.path(), "pw", ""), &ctx()).unwrap_err();
    assert!(matches!(&err, CoreError::InvalidInput(m) if m == ALREADY_ENCRYPTED), "{err}");
    assert!(names(out.path()).is_empty());
}

#[test]
fn bad_input_fails_with_a_clear_code_and_leaves_no_files() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = sample(&src, "doc.pdf", 1);
    let code = |r: Result<_, CoreError>| match r {
        Ok(_) => "ok",
        Err(e) => e.code(),
    };
    assert_eq!(code(protect(&pdf, &options(out.path(), "", ""), &ctx())), "invalid_input");
    assert_eq!(code(protect(&pdf, &options(out.path(), &"x".repeat(128), ""), &ctx())), "invalid_input");
    assert_eq!(code(protect(&pdf, &options(out.path(), "ok", &"é".repeat(70)), &ctx())), "invalid_input");
    assert_eq!(code(protect(&pdf, &options(out.path(), "a\0b", ""), &ctx())), "invalid_input");
    assert_eq!(code(protect(&fixture("not-a-pdf.pdf"), &options(out.path(), "pw", ""), &ctx())), "invalid_input");
    assert_eq!(code(protect(&src.path().join("nope.pdf"), &options(out.path(), "pw", ""), &ctx())), "not_found");
    assert_eq!(code(protect(&pdf, &options(&out.path().join("missing"), "pw", ""), &ctx())), "not_found");
    assert_eq!(code(remove_password(&fixture("not-a-pdf.pdf"), &unlock_options(out.path(), "pw"), &ctx())), "invalid_input");
    assert!(names(out.path()).is_empty());
    // The longest allowed password works.
    assert_eq!(code(protect(&pdf, &options(out.path(), &"x".repeat(127), ""), &ctx())), "ok");
}

#[test]
fn unicode_passwords_and_names_work() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = sample(&src, "laporan akhir.pdf", 1);
    let report = protect(&pdf, &options(out.path(), "sandi-ñ-日本", ""), &ctx()).unwrap();
    assert_eq!(report.output_path, out.path().join("laporan akhir_protected.pdf"));
    let mut copy = open(&report.output_path);
    assert!(copy.authenticate("sandi-ñ-日本").unwrap());
}

#[test]
fn a_taken_name_gets_a_number_and_a_custom_name_is_made_safe() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = sample(&src, "doc.pdf", 1);
    let first = protect(&pdf, &options(out.path(), "pw", ""), &ctx()).unwrap();
    let second = protect(&pdf, &options(out.path(), "pw", ""), &ctx()).unwrap();
    assert_eq!(first.output_path, out.path().join("doc_protected.pdf"));
    assert_eq!(second.output_path, out.path().join("doc_protected (1).pdf"));
    let mut opts = options(out.path(), "pw", "");
    opts.output_name = Some("A: b/c.pdf".into());
    assert_eq!(protect(&pdf, &opts, &ctx()).unwrap().output_path, out.path().join("A_ b_c.pdf"));
}

#[test]
fn cancelling_removes_the_partial_file() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = sample(&src, "doc.pdf", 2);
    let token = CancelToken::new();
    let cancel = token.clone();
    // Cancel as soon as saving is reported.
    let sink: dokuwu_core::ProgressSink = Arc::new(move |_, p| {
        if p.stage == "saving" {
            cancel.cancel();
        }
    });
    let ctx = JobContext::new(1, token, Some(sink)).with_min_interval(std::time::Duration::ZERO);
    let err = protect(&pdf, &options(out.path(), "pw", ""), &ctx).unwrap_err();
    assert!(err.is_cancelled());
    assert!(names(out.path()).is_empty(), "{:?}", names(out.path()));
}

#[test]
fn progress_names_the_stages_and_never_contains_the_password() {
    let src = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let pdf = sample(&src, "doc.pdf", 1);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let store = Arc::clone(&seen);
    let sink: dokuwu_core::ProgressSink = Arc::new(move |_, p| store.lock().unwrap().push(format!("{p:?}")));
    let job = JobContext::new(1, CancelToken::new(), Some(sink)).with_min_interval(std::time::Duration::ZERO);
    let secret = "very-secret-pw";
    let opts = options(out.path(), secret, "");
    let report = protect(&pdf, &opts, &job).unwrap();
    let seen = seen.lock().unwrap();
    assert!(seen.iter().any(|s| s.contains("saving")) && seen.iter().any(|s| s.contains("checking")), "{seen:?}");
    assert!(seen.iter().all(|s| !s.contains(secret)));
    assert!(!format!("{report:?}").contains(secret));
    assert!(!format!("{opts:?}").contains(secret));
    assert!(!format!("{:?}", unlock_options(out.path(), secret)).contains(secret));
    let err = protect(&fixture("encrypted.pdf"), &opts, &ctx()).unwrap_err();
    assert!(!err.to_string().contains(secret));
}
