//! Add or remove the password of a PDF.
//!
//! `protect` writes a copy encrypted with AES-256, a user (open) password, an
//! owner password and permissions for printing, copying and modifying.
//! `remove_password` opens a protected PDF with its password and writes a copy
//! without encryption. The original is never changed.
//!
//! Each copy is written as a `.part` file next to its final place, reopened to
//! check that it is what was asked for (still protected and opening with the
//! password, or open without one, with the same number of pages), and only then
//! renamed to a free name. A failed check, a cancel or an error removes it.
//!
//! The passwords exist only as arguments here: they are not part of any report,
//! progress event or error text, and the option types do not print them.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Instant;

use mupdf::pdf::{Encryption, PdfDocument, PdfWriteOptions, Permission};
use serde::Serialize;

use crate::error::{CoreError, CoreResult};
use crate::job::JobContext;
use crate::ops::naming::{create_part, sanitize_stem, PartGuard};
use crate::ops::pdf_graft::{internal, open, path_str, save_error};

pub const STAGE_SAVING: &str = "saving";
pub const STAGE_CHECKING: &str = "checking";

/// The longest password PDF AES-256 can use, in bytes.
pub const MAX_PASSWORD_BYTES: usize = 127;

pub const ALREADY_ENCRYPTED: &str = "This PDF is already encrypted. Remove the existing password first.";
pub const NOT_ENCRYPTED: &str = "This PDF is not encrypted - no password to remove.";

#[derive(Clone)]
pub struct ProtectOptions {
    /// Needed to open the copy. Must not be empty.
    pub user_password: String,
    /// Needed to change the permissions; the user password when empty.
    pub owner_password: String,
    pub allow_print: bool,
    pub allow_copy: bool,
    pub allow_modify: bool,
    pub output_dir: PathBuf,
    /// Name without extension; `<input name>_protected` when empty.
    pub output_name: Option<String>,
}

impl fmt::Debug for ProtectOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProtectOptions")
            .field("user_password", &"<hidden>")
            .field("owner_password", &"<hidden>")
            .field("allow_print", &self.allow_print)
            .field("allow_copy", &self.allow_copy)
            .field("allow_modify", &self.allow_modify)
            .field("output_dir", &self.output_dir)
            .field("output_name", &self.output_name)
            .finish()
    }
}

#[derive(Clone)]
pub struct UnprotectOptions {
    /// The user password, or the owner password.
    pub password: String,
    pub output_dir: PathBuf,
    /// Name without extension; `<input name>_unlocked` when empty.
    pub output_name: Option<String>,
}

impl fmt::Debug for UnprotectOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UnprotectOptions")
            .field("password", &"<hidden>")
            .field("output_dir", &self.output_dir)
            .field("output_name", &self.output_name)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectReport {
    pub output_path: PathBuf,
    pub output_size_bytes: u64,
    pub pages: u32,
    pub duration_ms: u64,
}

/// Writes an AES-256 protected copy of `input` into `options.output_dir`.
pub fn protect(input: &Path, options: &ProtectOptions, ctx: &JobContext) -> CoreResult<ProtectReport> {
    let started = Instant::now();
    check_password(&options.user_password, "The user password")?;
    if options.user_password.is_empty() {
        return Err(CoreError::InvalidInput("User password is required to encrypt the document.".into()));
    }
    check_password(&options.owner_password, "The owner password")?;
    let owner = if options.owner_password.is_empty() { &options.user_password } else { &options.owner_password };
    check_output_dir(&options.output_dir)?;
    ctx.check_cancelled()?;

    let doc = open_input(input)?;
    if is_encrypted(&doc)? {
        return Err(CoreError::InvalidInput(ALREADY_ENCRYPTED.into()));
    }
    let pages = page_count(&doc)?;

    let mut write = PdfWriteOptions::default();
    write.set_garbage_level(4).set_compress(true);
    write.set_encryption(Encryption::Aes256);
    write.set_user_password(&options.user_password);
    write.set_owner_password(owner);
    write.set_permissions(permissions(options.allow_print, options.allow_copy, options.allow_modify));

    let stem = output_stem(input, options.output_name.as_deref(), "protected");
    let published = write_checked(&doc, write, &options.output_dir, &stem, ctx, |copy| {
        // The copy must ask for the password and open with it.
        if !copy.needs_password().map_err(|e| internal("check", e))? {
            return Err(CoreError::Internal("the protected copy does not ask for a password".into()));
        }
        let mut copy = copy;
        if !copy.authenticate(&options.user_password).map_err(|e| internal("check", e))? {
            return Err(CoreError::Internal("the protected copy does not open with its password".into()));
        }
        same_pages(&copy, pages)
    })?;
    drop(doc);
    Ok(report(published, pages, started))
}

/// Writes a copy of `input` without its password into `options.output_dir`.
pub fn remove_password(input: &Path, options: &UnprotectOptions, ctx: &JobContext) -> CoreResult<ProtectReport> {
    let started = Instant::now();
    check_password(&options.password, "The password")?;
    check_output_dir(&options.output_dir)?;
    ctx.check_cancelled()?;

    let mut doc = open_input(input)?;
    if !is_encrypted(&doc)? {
        return Err(CoreError::InvalidInput(NOT_ENCRYPTED.into()));
    }
    // Always asked for, also when the file opens without a password (only an
    // owner password set): the restrictions are not lifted without it.
    if !doc.authenticate(&options.password).map_err(|e| internal("password check", e))? {
        return Err(CoreError::PasswordRequired);
    }
    let pages = page_count(&doc)?;

    let mut write = PdfWriteOptions::default();
    write.set_garbage_level(4).set_compress(true);
    write.set_encryption(Encryption::None);

    let stem = output_stem(input, options.output_name.as_deref(), "unlocked");
    let published = write_checked(&doc, write, &options.output_dir, &stem, ctx, |copy| {
        if is_encrypted(&copy)? {
            return Err(CoreError::Internal("the unlocked copy is still encrypted".into()));
        }
        same_pages(&copy, pages)
    })?;
    drop(doc);
    Ok(report(published, pages, started))
}

/// Saves `doc` with `write` to a `.part`, runs `verify` on the reopened copy and
/// renames it to a free name.
fn write_checked(
    doc: &PdfDocument,
    write: PdfWriteOptions,
    dir: &Path,
    stem: &str,
    ctx: &JobContext,
    verify: impl FnOnce(PdfDocument) -> CoreResult<()>,
) -> CoreResult<PathBuf> {
    let (file, part) = create_part(dir, stem, "pdf").map_err(|e| CoreError::io(dir, e))?;
    drop(file);
    let guard = PartGuard::new(part.clone());
    ctx.check_cancelled()?;
    ctx.report(STAGE_SAVING, 0, None);
    doc.save_with_options(path_str(&part)?, write).map_err(|e| save_error(&part, e))?;
    ctx.check_cancelled()?;
    ctx.report(STAGE_CHECKING, 0, None);
    let copy = open(&part).map_err(|e| CoreError::Internal(format!("the new copy cannot be read back: {e}")))?;
    verify(copy)?;
    ctx.check_cancelled()?;
    guard.publish(dir, stem, "pdf").map_err(|e| CoreError::io(dir, e))
}

fn report(output_path: PathBuf, pages: u32, started: Instant) -> ProtectReport {
    ProtectReport {
        output_size_bytes: std::fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0),
        output_path,
        pages,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}

/// Permission bits: accessibility is always allowed; "modify" also covers
/// annotating, assembling and filling forms.
pub fn permissions(print: bool, copy: bool, modify: bool) -> Permission {
    let mut perms = Permission::ACCESSIBILITY;
    if print {
        perms |= Permission::PRINT | Permission::PRINT_HQ;
    }
    if copy {
        perms |= Permission::COPY;
    }
    if modify {
        perms |= Permission::MODIFY | Permission::ANNOTATE | Permission::ASSEMBLE | Permission::FORM;
    }
    perms
}

fn check_password(password: &str, what: &str) -> CoreResult<()> {
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(CoreError::InvalidInput(format!("{what} is too long (at most {MAX_PASSWORD_BYTES} bytes).")));
    }
    if password.contains('\0') {
        return Err(CoreError::InvalidInput(format!("{what} cannot contain a null character.")));
    }
    Ok(())
}

fn check_output_dir(dir: &Path) -> CoreResult<()> {
    if dir.is_dir() {
        Ok(())
    } else {
        Err(CoreError::NotFound { path: dir.to_path_buf() })
    }
}

fn open_input(input: &Path) -> CoreResult<PdfDocument> {
    if !input.exists() {
        return Err(CoreError::NotFound { path: input.to_path_buf() });
    }
    open(input).map_err(|e| CoreError::InvalidInput(format!("Cannot open PDF: {e}")))
}

/// True for any PDF with an encryption dictionary, also one that opens without
/// a password because only an owner password is set.
pub(crate) fn is_encrypted(doc: &PdfDocument) -> CoreResult<bool> {
    if doc.needs_password().map_err(|e| internal("password check", e))? {
        return Ok(true);
    }
    let trailer = doc.trailer().map_err(|e| internal("trailer", e))?;
    let encrypt = trailer.get_dict("Encrypt").map_err(|e| internal("trailer", e))?;
    match encrypt {
        Some(obj) => Ok(!obj.is_null().map_err(|e| internal("trailer", e))?),
        None => Ok(false),
    }
}

fn page_count(doc: &PdfDocument) -> CoreResult<u32> {
    let pages = doc.page_count().map_err(|e| internal("page count", e))?.max(0) as u32;
    if pages == 0 {
        return Err(CoreError::InvalidInput("the document has no pages".into()));
    }
    Ok(pages)
}

fn same_pages(copy: &PdfDocument, pages: u32) -> CoreResult<()> {
    let found = copy.page_count().map_err(|e| internal("check", e))?.max(0) as u32;
    if found == pages {
        Ok(())
    } else {
        Err(CoreError::Internal(format!("the new copy has {found} pages instead of {pages}")))
    }
}

fn output_stem(input: &Path, name: Option<&str>, suffix: &str) -> String {
    match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => sanitize_stem(name),
        None => {
            let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            format!("{}_{suffix}", sanitize_stem(&stem))
        }
    }
}
