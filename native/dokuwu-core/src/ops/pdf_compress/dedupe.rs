//! Merges identical streams (pictures, fonts, colour profiles, drawings).
//!
//! Producers such as Canva write the same picture or font once per page. MuPDF
//! can merge such objects while saving (garbage level 3 and 4), but it compares
//! them pairwise, which took 44 s for a 62 MB, 158-page report and grows much
//! faster than the file. Here every large stream gets a fingerprint (its own
//! dictionary, its data, and what the dictionary points at) and every reference
//! to a duplicate is pointed at the first copy; the duplicates are then
//! unreferenced and the ordinary save drops them.

use std::collections::{HashMap, HashSet};

use mupdf::pdf::{PdfDocument, PdfObject};
use sha2::{Digest, Sha256};

use crate::error::CoreResult;
use crate::job::JobContext;

/// Streams smaller than this are not worth hashing.
const MIN_STREAM_BYTES: usize = 1024;
/// How far a fingerprint follows references (image, then its mask or profile).
const MAX_DEPTH: u8 = 3;

/// Xrefs that were merged into another copy, so they no longer need handling.
pub struct Merged {
    pub removed: HashSet<i32>,
}

pub fn merge_duplicate_streams(doc: &PdfDocument, ctx: &JobContext) -> CoreResult<Merged> {
    let total = doc.count_objects().map(u64::from).unwrap_or(0);
    let mut first_of: HashMap<[u8; 32], i32> = HashMap::new();
    let mut duplicate_of: HashMap<i32, i32> = HashMap::new();

    for xref in 1..total as i32 {
        if xref % 128 == 0 {
            ctx.check_cancelled()?;
            ctx.report("deduplicating", xref as u64, Some(total * 2));
        }
        let Ok(obj) = doc.new_indirect(xref, 0) else { continue };
        if !obj.is_stream().unwrap_or(false) {
            continue;
        }
        let Some(print) = fingerprint(doc, &obj) else { continue };
        match first_of.get(&print) {
            Some(&first) => {
                duplicate_of.insert(xref, first);
            }
            None => {
                first_of.insert(print, xref);
            }
        }
    }
    if duplicate_of.is_empty() {
        return Ok(Merged { removed: HashSet::new() });
    }

    for xref in 1..total as i32 {
        if xref % 128 == 0 {
            ctx.check_cancelled()?;
            ctx.report("deduplicating", total + xref as u64, Some(total * 2));
        }
        if duplicate_of.contains_key(&xref) {
            continue;
        }
        let Ok(mut obj) = doc.new_indirect(xref, 0) else { continue };
        if obj.is_dict().unwrap_or(false) || obj.is_stream().unwrap_or(false) {
            // A failure here only leaves one reference on its original copy.
            let _ = redirect(doc, &mut obj, &duplicate_of, 0);
        }
    }
    Ok(Merged { removed: duplicate_of.into_keys().collect() })
}

/// Points every reference below `obj` that names a duplicate at its first copy.
/// Indirect children are visited as objects of their own, so only direct
/// dictionaries and arrays are entered.
fn redirect(
    doc: &PdfDocument,
    obj: &mut PdfObject,
    duplicate_of: &HashMap<i32, i32>,
    depth: u8,
) -> Result<(), mupdf::Error> {
    if depth > 8 {
        return Ok(());
    }
    if obj.is_dict()? {
        let mut changes: Vec<(PdfObject, PdfObject)> = Vec::new();
        for entry in obj.dict_iter()? {
            let (key, mut value) = entry?;
            if value.is_indirect()? {
                if let Some(&first) = duplicate_of.get(&value.as_indirect()?) {
                    changes.push((key, doc.new_indirect(first, 0)?));
                }
            } else if value.is_dict()? || value.is_array()? {
                redirect(doc, &mut value, duplicate_of, depth + 1)?;
            }
        }
        for (key, value) in changes {
            obj.dict_put(key, value)?;
        }
    } else if obj.is_array()? {
        let mut changes: Vec<(i32, PdfObject)> = Vec::new();
        for (index, value) in obj.array_iter()?.enumerate() {
            let mut value = value?;
            if value.is_indirect()? {
                if let Some(&first) = duplicate_of.get(&value.as_indirect()?) {
                    changes.push((index as i32, doc.new_indirect(first, 0)?));
                }
            } else if value.is_dict()? || value.is_array()? {
                redirect(doc, &mut value, duplicate_of, depth + 1)?;
            }
        }
        for (index, value) in changes {
            obj.array_put(index, value)?;
        }
    }
    Ok(())
}

/// SHA-256 over a stream's dictionary text (without `/Length`), the objects its
/// dictionary points at, and its stored bytes. `None`: too small or unreadable.
fn fingerprint(doc: &PdfDocument, stream: &PdfObject) -> Option<[u8; 32]> {
    let raw = stream.read_raw_stream().ok()?;
    if raw.len() < MIN_STREAM_BYTES {
        return None;
    }
    let mut hasher = Sha256::new();
    describe(doc, stream, true, 0, &mut hasher).ok()?;
    hasher.update((raw.len() as u64).to_le_bytes());
    hasher.update(&raw);
    Some(hasher.finalize().into())
}

/// Writes a canonical description of `obj` into `out`: dictionary keys sorted,
/// references replaced by what they point at.
fn describe(
    doc: &PdfDocument,
    obj: &PdfObject,
    top: bool,
    depth: u8,
    out: &mut Sha256,
) -> Result<(), mupdf::Error> {
    if obj.is_indirect()? {
        let number = obj.as_indirect()?;
        if depth >= MAX_DEPTH {
            out.update(b"R");
            return Ok(());
        }
        let target = doc.new_indirect(number, 0)?;
        if target.is_stream()? {
            out.update(b"S");
            out.update(Sha256::digest(target.read_raw_stream()?));
            return describe(doc, &target, true, depth + 1, out);
        }
        return describe(doc, &target, false, depth + 1, out);
    }
    if obj.is_null()? {
        out.update(b"n");
    } else if obj.is_bool()? {
        out.update(if obj.as_bool()? { b"t" } else { b"f" });
    } else if obj.is_int()? {
        out.update(b"i");
        out.update(obj.as_int()?.to_le_bytes());
    } else if obj.is_real()? {
        out.update(b"r");
        out.update(obj.as_float()?.to_bits().to_le_bytes());
    } else if obj.is_name()? {
        out.update(b"/");
        out.update(obj.as_name()?);
        out.update(b";");
    } else if obj.is_string()? {
        out.update(b"(");
        out.update(obj.as_bytes()?);
        out.update(b")");
    } else if obj.is_array()? {
        out.update(b"[");
        for value in obj.array_iter()? {
            describe(doc, &value?, false, depth + 1, out)?;
        }
        out.update(b"]");
    } else if obj.is_dict()? {
        let mut entries: Vec<(Vec<u8>, PdfObject)> = Vec::new();
        for entry in obj.dict_iter()? {
            let (key, value) = entry?;
            let key = key.as_name()?;
            // The stored length is part of the data, which is hashed on its own.
            if top && key == b"Length" {
                continue;
            }
            entries.push((key, value));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        out.update(b"<");
        for (key, value) in entries {
            out.update(&key);
            out.update(b"=");
            describe(doc, &value, false, depth + 1, out)?;
        }
        out.update(b">");
    }
    Ok(())
}
