//! Read-only same-artifact native ownership, using MCIDs and font handle identity.
//! No font name/program/hash or resource/paint ordering selects a dictionary.
use crate::resource_inspector::{InspectionOutcome, ResourceInspector};
use crate::sha256_reader;
use pdfium_render::prelude::PdfiumLibraryBindings;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Group {
    mcid: i32,
    kind: i32,
    count: usize,
    fonts: BTreeSet<String>,
    state: Option<Value>,
}

#[derive(Clone, Debug)]
struct NativeObject {
    kind: i32,
    mcid: i32,
    // Ephemeral equality label, never serialized or stored in history.
    font: Option<usize>,
}

fn solve(page: &Value, native: &[NativeObject]) -> Option<Value> {
    let proof = &page["markedContentProof"];
    if proof["schema"] != "marked-content-constraints/v1" {
        return None;
    }
    let groups: Vec<Group> = serde_json::from_value(proof["groups"].clone()).ok()?;
    if groups.len() > 100_000 || !groups.iter().any(|g| g.mcid >= 0) {
        return None;
    }
    let mut by_key = BTreeMap::new();
    let mut used_fonts = BTreeSet::new();
    for g in groups {
        if g.mcid < -1
            || !(1..=3).contains(&g.kind)
            || g.count == 0
            || g.count > 100_000
            || (g.kind == 1) == g.fonts.is_empty()
        {
            return None;
        }
        let state = g.state.as_ref()?.as_array()?;
        if state.len() != 3
            || state[2] != "/Normal"
            || state[..2].iter().any(|v| {
                v.as_f64()
                    .is_none_or(|n| !n.is_finite() || !(0.0..=1.0).contains(&n))
            })
        {
            return None;
        }
        used_fonts.extend(g.fonts.iter().cloned());
        if by_key.insert((g.mcid, g.kind), g).is_some() {
            return None;
        }
    }
    if used_fonts.len() > 64 {
        return None;
    }
    let fonts = page["fonts"].as_array()?;
    for id in &used_fonts {
        let exact = crate::resource_inspector::unique_font(
            fonts
                .iter()
                .filter(|f| f["scope"] == "page" && f["fontObject"].as_str() == Some(id)),
        )?;
        if id.starts_with("direct:") || exact["semanticSha256"].as_str()?.len() != 64 {
            return None;
        }
    }
    let mut counts = BTreeMap::<(i32, i32), usize>::new();
    let mut edges = BTreeMap::<usize, BTreeSet<String>>::new();
    for obj in native {
        let group = by_key.get(&(obj.mcid, obj.kind))?;
        *counts.entry((obj.mcid, obj.kind)).or_default() += 1;
        if obj.kind == 1 {
            let candidates = edges.entry(obj.font?).or_insert_with(|| used_fonts.clone());
            *candidates = candidates.intersection(&group.fonts).cloned().collect();
            if candidates.is_empty() {
                return None;
            }
        } else if obj.font.is_some() {
            return None;
        }
    }
    if counts.len() != by_key.len()
        || by_key
            .iter()
            .any(|(key, g)| counts.get(key) != Some(&g.count))
        || edges.len() != used_fonts.len()
    {
        return None;
    }
    // The pinned parser caches one CPDF_Font per dictionary. With complete used
    // resource/native censuses, singleton elimination proves a unique bijection.
    // No arbitrary matching is returned when the constraints stop resolving.
    let mut assignments = BTreeMap::<usize, String>::new();
    let mut taken = BTreeSet::<String>::new();
    while assignments.len() < edges.len() {
        let mut singles = Vec::new();
        for (handle, candidates) in &edges {
            if assignments.contains_key(handle) {
                continue;
            }
            let remaining = candidates.difference(&taken).collect::<Vec<_>>();
            if remaining.is_empty() {
                return None;
            }
            if remaining.len() == 1 {
                singles.push((*handle, remaining[0].clone()));
            }
        }
        if singles.is_empty() {
            return None;
        }
        for (handle, id) in singles {
            if !taken.insert(id.clone()) {
                return None;
            }
            assignments.insert(handle, id);
        }
    }
    Some(json!(native
        .iter()
        .map(|obj| json!({"kind": obj.kind,
            "markedContentId": obj.mcid,
            "fontObject": obj.font.and_then(|f| assignments.get(&f)),
            "graphicsState": by_key[&(obj.mcid, obj.kind)].state,
        }))
        .collect::<Vec<_>>()))
}

/// Runs on the worker's serial native thread, with the already verified DLL.
/// Its additional binding loads symbols only; it never initializes/destroys the
/// shared library, mutates a page, or exposes raw handles outside this module.
pub struct NativeBoundInspector {
    inner: Box<dyn ResourceInspector>,
    bindings: Box<dyn PdfiumLibraryBindings>,
}

impl NativeBoundInspector {
    pub fn new(
        inner: Box<dyn ResourceInspector>,
        bindings: Box<dyn PdfiumLibraryBindings>,
    ) -> Self {
        Self { inner, bindings }
    }

    fn attach(&self, path: &Path, inspection: &mut Value) -> Option<()> {
        let bytes = std::fs::read(path).ok()?;
        if bytes.len() > 16 * 1024 * 1024 {
            return None;
        }
        let digest = sha256_reader(&mut std::io::Cursor::new(&bytes)).ok()?;
        let pages = inspection["pages"].as_array_mut()?;
        if pages.len() > 256 || pages.iter().any(|p| p["sourceSha256"] != digest) {
            return None;
        }
        // The pinned loader parses the exact same immutable bytes as the wrapper.
        // Fresh per-file enumeration is not old-index correspondence across saves.
        let b = self.bindings.as_ref();
        let doc = unsafe { b.FPDF_LoadMemDocument64(&bytes, None) };
        if doc.is_null() {
            return None;
        }
        let result = (|| {
            if unsafe { b.FPDF_GetPageCount(doc) } as usize != pages.len() {
                return None;
            }
            for (pi, proof) in pages.iter_mut().enumerate() {
                if proof["pageIndex"].as_u64() != Some(pi as u64) {
                    return None;
                }
                if proof["markedContentProof"].is_null() {
                    continue;
                }
                let page = unsafe { b.FPDF_LoadPage(doc, pi as i32) };
                if page.is_null() {
                    return None;
                }
                let objects = (|| {
                    let count = unsafe { b.FPDFPage_CountObjects(page) };
                    if !(0..=100_000).contains(&count) {
                        return None;
                    }
                    let mut objects = Vec::new();
                    let mut owners = BTreeMap::new();
                    for i in 0..count {
                        let obj = unsafe { b.FPDFPage_GetObject(page, i) };
                        if obj.is_null() {
                            return None;
                        }
                        if owners.insert(obj as usize, i as usize).is_some() { return None; }
                        let kind = unsafe { b.FPDFPageObj_GetType(obj) };
                        let font = if kind == 1 {
                            let value = unsafe { b.FPDFTextObj_GetFont(obj) };
                            if value.is_null() {
                                return None;
                            }
                            Some(value as usize)
                        } else {
                            None
                        };
                        objects.push(NativeObject {
                            kind,
                            font,
                            mcid: unsafe { b.FPDFPageObj_GetMarkedContentID(obj) },
                        });
                    }
                    // Read-only per-character native ownership. A complete
                    // serialized ASCII slot census must bind it before use.
                    let tp = unsafe { b.FPDFText_LoadPage(page) };
                    if !tp.is_null() {
                        let chars = (|| {
                            let n = unsafe { b.FPDFText_CountChars(tp) };
                            if !(0..=100_000).contains(&n) { return None; }
                            let mut result = vec![Vec::new(); count as usize];
                            for i in 0..n {
                                let owner = unsafe { b.FPDFText_GetTextObject(tp, i) };
                                let Some(index) = owners.get(&(owner as usize)) else { continue; };
                                let (mut left,mut right,mut bottom,mut top) = (0.0,0.0,0.0,0.0);
                                let ok = unsafe { b.FPDFText_GetCharBox(tp,i,&mut left,&mut right,&mut bottom,&mut top) };
                                if ok == 0 || [left,right,bottom,top].iter().any(|v| !v.is_finite()) { return None; }
                                result[*index].push(json!({"code":unsafe {b.FPDFText_GetUnicode(tp,i)},
                                    "generated":unsafe {b.FPDFText_IsGenerated(tp,i)},
                                    "bounds":[left,bottom,right,top]}));
                            }
                            Some(json!(result))
                        })();
                        unsafe { b.FPDFText_ClosePage(tp) };
                        if let Some(chars) = chars { proof["nativeTextCharacters"] = chars; }
                    }
                    Some(objects)
                })();
                // No native pointer survives this page lifetime.
                let solved = objects.as_deref().and_then(|objects| solve(proof, objects));
                unsafe { b.FPDF_ClosePage(page) };
                if let Some(solved) = solved {
                    proof["nativeMarkedOwnership"] = solved;
                }
            }
            Some(())
        })();
        unsafe { b.FPDF_CloseDocument(doc) };
        result
    }
}

impl ResourceInspector for NativeBoundInspector {
    fn inspect(&self, path: &Path) -> InspectionOutcome {
        let InspectionOutcome::Supported(mut value) = self.inner.inspect(path) else {
            return InspectionOutcome::Unsupported;
        };
        // An untrusted companion payload must not provide its own native verdict.
        if let Some(pages) = value["pages"].as_array_mut() {
            for page in pages {
                page.as_object_mut()
                    .map(|p| p.remove("nativeMarkedOwnership"));
                page.as_object_mut().map(|p| p.remove("nativeTextCharacters"));
            }
        }
        let mut candidate = value.clone();
        if self.attach(path, &mut candidate).is_some() {
            value = candidate;
        }
        InspectionOutcome::Supported(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Value, Vec<NativeObject>) {
        let page = json!({"fonts": [
            {"scope":"page", "fontObject":"1:0", "semanticSha256":"a".repeat(64)},
            {"scope":"page", "fontObject":"2:0", "semanticSha256":"a".repeat(64)}],
            "markedContentProof": {"schema":"marked-content-constraints/v1", "groups":[
                {"mcid":10,"kind":1,"count":1,"fonts":["1:0"],"state":[1.0,1.0,"/Normal"]},
                {"mcid":11,"kind":1,"count":2,"fonts":["1:0","2:0"],"state":[0.78431,1.0,"/Normal"]}]}});
        let native = vec![
            NativeObject {
                kind: 1,
                mcid: 10,
                font: Some(99),
            },
            NativeObject {
                kind: 1,
                mcid: 11,
                font: Some(99),
            },
            NativeObject {
                kind: 1,
                mcid: 11,
                font: Some(42),
            },
        ];
        (page, native)
    }

    #[test]
    fn marked_constraints_prove_unique_font_dictionary_not_equal_hash_or_order() {
        let (mut page, native) = fixture();
        let result = solve(&page, &native).unwrap();
        for (object, binding) in native.iter().zip(result.as_array().unwrap()) {
            assert_eq!(binding["markedContentId"], object.mcid);
        }
        assert_eq!(result[0]["fontObject"], "1:0");
        assert_eq!(result[2]["fontObject"], "2:0");
        page["fonts"].as_array_mut().unwrap().reverse();
        page["markedContentProof"]["groups"]
            .as_array_mut()
            .unwrap()
            .reverse();
        assert_eq!(solve(&page, &native).unwrap(), result);
        let mut reordered = native.clone();
        reordered.reverse();
        assert_eq!(solve(&page, &reordered).unwrap()[0], result[2]);
    }

    #[test]
    fn ambiguous_fonts_mixed_states_and_incomplete_censuses_reject() {
        let (page, native) = fixture();
        for (field, bad) in [
            ("fonts", json!(["1:0", "2:0"])),
            ("state", Value::Null),
            ("state", json!([0.7, 1.0, "/Multiply"])),
            ("count", json!(2)),
        ] {
            let mut changed = page.clone();
            changed["markedContentProof"]["groups"][0][field] = bad;
            assert!(solve(&changed, &native).is_none());
        }
        let mut missing = native.clone();
        missing.pop();
        assert!(solve(&page, &missing).is_none());
        let mut merged = native;
        merged[2].font = Some(99);
        assert!(solve(&page, &merged).is_none());
    }
}
