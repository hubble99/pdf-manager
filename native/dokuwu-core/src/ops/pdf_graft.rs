//! Copying pages between PDF documents, shared by Merge and Extract.
//!
//! MuPDF's own `insert_pdf` builds a fresh object map for every page, so a font
//! used on all 200 pages of a source is copied 200 times: merging held about
//! 3.4 times the size of the inputs in memory. Here one [`PdfGraftMap`] serves
//! all pages taken from one source document, so every shared object (fonts,
//! images, colour spaces) is copied once.
//!
//! A page is rebuilt the way MuPDF does it (a new page dictionary carrying
//! `Contents`, `Resources`, the page boxes, `Rotate` and `UserUnit`, each read
//! with inheritance from the page tree), plus its annotations, which MuPDF's
//! page copy leaves out. Everything that would point back into the source's
//! page tree is removed first, because following such a reference would copy
//! the source's whole page tree into the target.

use std::fs;
use std::path::{Path, PathBuf};

use mupdf::pdf::{PdfDocument, PdfGraftMap, PdfObject, PdfWriteOptions};
use mupdf::Error;

use crate::error::{CoreError, CoreResult};
use crate::ops::naming::create_part;

/// Page keys that are copied, read with inheritance from the page tree.
const COPY_KEYS: &[&str] = &[
    "Contents", "Resources", "MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox", "Rotate", "UserUnit",
];

/// Annotation keys that lead back to pages, other annotations or form fields of
/// the source.
const ANNOT_DROP_KEYS: &[&str] = &["P", "Parent", "Popup", "IRT", "Dest", "Kids", "Next", "Prev", "StructParent"];

/// Copies page `index` (0-based) of `source` to the end of `target`.
pub(crate) fn graft_page(
    target: &mut PdfDocument,
    map: &mut PdfGraftMap,
    source: &PdfDocument,
    index: i32,
) -> Result<(), Error> {
    let page_ref = source.find_page(index)?;
    let mut page = target.new_dict_with_capacity(8)?;
    page.dict_put("Type", PdfObject::new_name("Page")?)?;
    for key in COPY_KEYS {
        if let Some(value) = page_ref.get_dict_inheritable(*key)? {
            let grafted = map.graft_object(&value)?;
            page.dict_put(*key, grafted)?;
        }
    }
    if let Some(annots) = page_ref.get_dict("Annots")?.and_then(|a| a.resolve().ok().flatten()) {
        if annots.is_array()? {
            let mut kept = target.new_array()?;
            for i in 0..annots.len()? as i32 {
                let Some(annot) = annots.get_array(i)? else { continue };
                if let Some(copy) = portable_annotation(&annot)? {
                    kept.array_push(map.graft_object(&copy)?)?;
                }
            }
            if kept.len()? > 0 {
                page.dict_put("Annots", kept)?;
            }
        }
    }
    let added = target.add_object(&page)?;
    let at = target.page_count()?;
    target.insert_page(at, &added)
}

/// A copy of `annot` that is safe to graft, or `None` for annotations that only
/// make sense inside the source (pop-ups, links to other pages).
fn portable_annotation(annot: &PdfObject) -> Result<Option<PdfObject>, Error> {
    let Some(annot) = annot.resolve()? else { return Ok(None) };
    if !annot.is_dict()? {
        return Ok(None);
    }
    let subtype = name_of(annot.get_dict("Subtype")?)?;
    if subtype.as_deref() == Some("Popup") {
        return Ok(None);
    }
    let action_is_uri = match annot.get_dict("A")? {
        Some(action) => name_of(action.get_dict("S")?)?.as_deref() == Some("URI"),
        None => false,
    };
    if subtype.as_deref() == Some("Link") && !action_is_uri {
        // A link to a page, named destination or file position of the source.
        return Ok(None);
    }
    let mut copy = annot.copy_dict()?;
    for key in ANNOT_DROP_KEYS {
        copy.dict_delete(*key)?;
    }
    if !action_is_uri {
        // Actions other than a web address can name pages of the source.
        copy.dict_delete("A")?;
    }
    copy.dict_delete("AA")?;
    Ok(Some(copy))
}

fn name_of(value: Option<PdfObject>) -> Result<Option<String>, Error> {
    let Some(value) = value else { return Ok(None) };
    let Some(value) = value.resolve()? else { return Ok(None) };
    if !value.is_name()? {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&value.as_name()?).into_owned()))
}

/// Temporary files that hold the merge so far, so memory can be released.
pub(crate) struct Spill {
    dir: PathBuf,
    stem: String,
    current: Option<PathBuf>,
    serial: u32,
}

impl Spill {
    pub(crate) fn new(dir: &Path, stem: &str) -> Self {
        Self { dir: dir.to_path_buf(), stem: stem.to_string(), current: None, serial: 0 }
    }

    /// Saves `doc`, drops it and returns the saved file reopened.
    pub(crate) fn flush(&mut self, doc: PdfDocument) -> CoreResult<PdfDocument> {
        let (file, path) = create_part(&self.dir, &format!("{}.spill{}", self.stem, self.serial), "pdf")
            .map_err(|e| CoreError::io(&self.dir, e))?;
        drop(file);
        self.serial += 1;
        let previous = self.current.replace(path.clone());
        // Remembered before saving, so a failure still cleans it up.
        doc.save_with_options(path_str(&path)?, PdfWriteOptions::default()).map_err(|e| save_error(&path, e))?;
        drop(doc);
        let reopened = open(&path).map_err(|e| internal("reopen merge so far", e))?;
        if let Some(previous) = previous {
            let _ = fs::remove_file(previous);
        }
        Ok(reopened)
    }

    pub(crate) fn clean(&mut self) {
        if let Some(path) = self.current.take() {
            let _ = fs::remove_file(path);
        }
    }
}

impl Drop for Spill {
    fn drop(&mut self) {
        self.clean();
    }
}


pub(crate) fn open(path: &Path) -> Result<PdfDocument, Error> {
    PdfDocument::open(path.to_string_lossy().as_ref())
}

pub(crate) fn path_str(path: &Path) -> CoreResult<&str> {
    path.to_str().ok_or_else(|| CoreError::InvalidInput(format!("path is not valid text: {}", path.display())))
}

pub(crate) fn internal(context: &str, err: Error) -> CoreError {
    CoreError::Internal(format!("{context}: {err}"))
}

pub(crate) fn save_error(path: &Path, err: Error) -> CoreError {
    let text = err.to_string();
    if text.contains("No space left") {
        CoreError::io(path, std::io::Error::new(std::io::ErrorKind::StorageFull, text))
    } else {
        CoreError::Internal(format!("cannot save PDF: {text}"))
    }
}
