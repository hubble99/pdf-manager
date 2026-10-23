//! Resource inspection in Rust.
//!
//! This replaces the read-only Python inspector (pypdf + fontTools) that the
//! worker used to ask for a document's page, resource and font evidence. It
//! produces the same `edit-content-resource-inspection/v1` payload, and it is
//! deliberately stricter than the reader it replaces: wherever pypdf would
//! repair, guess or skip, this reader refuses, and a refusal can only turn a
//! supported file into an unsupported one or a proof into "no proof". It never
//! writes anything.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use serde_json::Value;

use crate::resource_inspector::{InspectionOutcome, ResourceInspector};

mod content;
mod data;
mod filters;
mod fonts;
pub(crate) mod pdf;
mod proofs;
mod pyjson;
mod sfnt;
mod values;

use pdf::{reject, Dict, Obj, PResult, Pdf, Reject};
use proofs::Page;
use pyjson::J;
use values::{as_dict, sha256_hex, Ctx};

const SCHEMA_VERSION: &str = "edit-content-resource-inspection/v1";
const MAX_INSPECTED_FILE_BYTES: u64 = 512 * 1024 * 1024;

struct Scope {
    resources: Option<Obj>,
    owner: Option<String>,
    dict: Dict,
    page_ref: Option<(u32, u16)>,
    rotate: Option<Obj>,
}

/// Inspects the PDF at `source`. `None` when the document is unsupported.
pub fn inspect_file(source: &Path) -> Option<Value> {
    inspect_file_with_reason(source).ok()
}

/// Like [`inspect_file`], with a short reason for tests and diagnostics (never
/// sent over the protocol).
pub fn inspect_file_with_reason(source: &Path) -> Result<Value, &'static str> {
    let metadata = std::fs::symlink_metadata(source).map_err(|_| "unreadable")?;
    if !metadata.is_file() || metadata.len() > MAX_INSPECTED_FILE_BYTES {
        return Err("not a regular file or too large");
    }
    let bytes = std::fs::read(source).map_err(|_| "unreadable")?;
    // The inspector must never take the worker down with it.
    match std::panic::catch_unwind(|| inspect_bytes(bytes)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(Reject(why))) => Err(why),
        Err(_) => Err("internal error"),
    }
}

pub fn inspect_bytes(bytes: Vec<u8>) -> PResult<Value> {
    let source_sha = sha256_hex(&bytes);
    let pdf = Pdf::open(bytes)?;
    let ctx = Ctx { pdf: &pdf, fonts: RefCell::new(HashMap::new()) };
    let scopes = ctx.page_scopes()?;

    let mut pages = Vec::new();
    let mut resource_pages: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
    for (index, scope) in scopes.iter().enumerate() {
        let mut fonts = Vec::new();
        ctx.walk_resources(
            scope.resources.as_ref(),
            index,
            scope.owner.as_deref(),
            "page",
            &mut fonts,
            &mut resource_pages,
            &mut BTreeSet::new(),
        )?;
        let page = Page { dict: &scope.dict, rotate: scope.rotate.clone() };
        let resources = scope.resources.as_ref();
        let preserved: Dict = Dict {
            entries: scope
                .dict
                .entries
                .iter()
                .filter(|(key, _)| !matches!(&**key, "/Type" | "/Parent" | "/Contents" | "/Resources" | "/MediaBox" | "/CropBox" | "/Rotate"))
                .cloned()
                .collect(),
        };
        let page_preservation =
            optional(ctx.semantic_hash(&Obj::Dict(std::rc::Rc::new(preserved)), scope.page_ref).map(J::Str))?;
        pages.push(J::obj([
            ("pageIndex", J::Int(index as i64)),
            ("inheritedResourcesFrom", scope.owner.clone().map_or(J::Null, J::Str)),
            ("fonts", J::Arr(fonts)),
            ("sourceSha256", J::Str(source_sha.clone())),
            ("textPaintSlots", optional(ctx.text_paint_slots(&page, resources))?),
            ("backdropContext", optional(ctx.backdrop_context(&page, resources))?),
            ("markedContentProof", optional(ctx.marked_content_proof(&page, resources))?),
            ("preservationResources", optional(ctx.resource_fingerprints(resources))?),
            ("imageResourceBindings", optional(ctx.image_resource_bindings(&page, resources))?),
            ("pagePreservation", page_preservation),
        ]));
    }
    let shared: Vec<J> = resource_pages
        .into_iter()
        .filter(|(_, indexes)| indexes.len() > 1)
        .map(|(object, indexes)| {
            J::obj([
                ("resourceObject", J::Str(object)),
                ("pageIndexes", J::Arr(indexes.into_iter().map(|i| J::Int(i as i64)).collect())),
            ])
        })
        .collect();
    let payload = J::obj([
        ("schemaVersion", J::str(SCHEMA_VERSION)),
        ("supported", J::Bool(true)),
        ("pages", J::Arr(pages)),
        ("sharedResources", J::Arr(shared)),
    ]);
    Ok(payload.to_value())
}

/// `optional_proof`: a missing proof blocks verification, not discovery. A
/// failure the old inspector could not have survived (it would have crashed
/// while writing its reply) still ends the whole inspection.
fn optional(result: PResult<J>) -> PResult<J> {
    match result {
        Ok(value) => Ok(value),
        Err(Reject(why)) if why.starts_with("fatal") => Err(Reject(why)),
        Err(_) => Ok(J::Null),
    }
}

impl<'a> Ctx<'a> {
    fn page_scopes(&self) -> PResult<Vec<Scope>> {
        let root = self.resolve(self.pdf.trailer.get("/Root").ok_or(Reject("no /Root"))?)?;
        let Some(root) = as_dict(&root) else { reject!("/Root is not a dictionary") };
        let pages_root = root.get("/Pages").ok_or(Reject("no /Pages"))?.clone();
        let mut scopes = Vec::new();
        let mut active: Vec<String> = Vec::new();
        self.walk_page_tree(&pages_root, None, None, None, &mut active, &mut scopes)?;
        Ok(scopes)
    }

    fn walk_page_tree(
        &self,
        node_value: &Obj,
        inherited: Option<Obj>,
        owner: Option<String>,
        inherited_rotate: Option<Obj>,
        active: &mut Vec<String>,
        scopes: &mut Vec<Scope>,
    ) -> PResult<()> {
        let node_id = self.object_id(node_value);
        if active.contains(&node_id) {
            reject!("page tree loops");
        }
        if active.len() > 64 {
            reject!("page tree too deep");
        }
        active.push(node_id.clone());
        let node_object = self.resolve(node_value)?;
        let Some(node) = as_dict(&node_object) else { reject!("page tree node is not a dictionary") };
        let local = node.get("/Resources");
        let current = match local {
            None => inherited,
            Some(value) => Some(value.clone()),
        };
        let current_owner = if local.is_none() { owner } else { Some(node_id.clone()) };
        match node.get("/Type") {
            Some(Obj::Name(kind)) if &**kind == "/Pages" => {
                let kids = self.item(node, "/Kids")?;
                let Obj::Array(kids) = kids else { reject!("/Kids is not an array") };
                let rotate = match node.get("/Rotate") {
                    Some(value) => Some(self.resolve(value)?),
                    None => inherited_rotate,
                };
                for kid in kids.iter() {
                    self.walk_page_tree(kid, current.clone(), current_owner.clone(), rotate.clone(), active, scopes)?;
                }
            }
            Some(Obj::Name(kind)) if &**kind == "/Page" => {
                let page_ref = match node_value {
                    Obj::Ref(num, generation) => Some((*num, *generation)),
                    _ => None,
                };
                let rotate = match node.get("/Rotate") {
                    Some(value) => Some(value.clone()),
                    None => inherited_rotate,
                };
                scopes.push(Scope { resources: current, owner: current_owner, dict: node.clone(), page_ref, rotate });
            }
            _ => reject!("unknown page tree node type"),
        }
        active.pop();
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn walk_resources(
        &self,
        resources_value: Option<&Obj>,
        page_index: usize,
        inherited_from: Option<&str>,
        scope: &str,
        fonts: &mut Vec<J>,
        resource_pages: &mut BTreeMap<String, BTreeSet<usize>>,
        seen: &mut BTreeSet<String>,
    ) -> PResult<()> {
        let Some(resources_value) = resources_value else { return Ok(()) };
        let resource_id = self.object_id(resources_value);
        resource_pages.entry(resource_id.clone()).or_default().insert(page_index);
        if !seen.insert(resource_id.clone()) {
            return Ok(());
        }
        let resolved = self.resolve(resources_value)?;
        let Some(resources) = as_dict(&resolved) else { reject!("resources are not a dictionary") };

        if let Some(font_map_value) = resources.get("/Font") {
            let font_map = self.resolve(font_map_value)?;
            let Some(font_map) = as_dict(&font_map) else { reject!("/Font is not a dictionary") };
            let mut entries: Vec<(&str, &Obj)> = font_map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            for (name, font_value) in entries {
                let J::Obj(mut entry) = self.inspect_font_cached(font_value)? else { unreachable!() };
                entry.insert("resourceName".into(), J::str(name));
                entry.insert("resourceObject".into(), J::Str(resource_id.clone()));
                entry.insert("resourceInheritedFrom".into(), inherited_from.map_or(J::Null, J::str));
                entry.insert("scope".into(), J::str(scope));
                fonts.push(J::Obj(entry));
            }
        }

        let Some(xobjects_value) = resources.get("/XObject") else { return Ok(()) };
        let xobjects = self.resolve(xobjects_value)?;
        let Some(xobjects) = as_dict(&xobjects) else { reject!("/XObject is not a dictionary") };
        let mut entries: Vec<(&str, &Obj)> = xobjects.iter().collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));
        for (name, xobject_value) in entries {
            let xobject = self.resolve(xobject_value)?;
            let Some(xobject_dict) = as_dict(&xobject) else { reject!("XObject is not a dictionary") };
            if !matches!(xobject_dict.get("/Subtype"), Some(Obj::Name(n)) if &**n == "/Form") {
                continue;
            }
            if let Some(nested) = xobject_dict.get("/Resources") {
                let from = self.object_id(xobject_value);
                self.walk_resources(
                    Some(nested),
                    page_index,
                    Some(&from),
                    &format!("{scope}/XObject:{name}"),
                    fonts,
                    resource_pages,
                    seen,
                )?;
            }
        }
        Ok(())
    }

    /// A font's inspection only depends on the font itself, so pages that share
    /// one share the work.
    fn inspect_font_cached(&self, font_value: &Obj) -> PResult<J> {
        let key = self.object_id(font_value);
        if let Some(found) = self.fonts.borrow().get(&key) {
            return Ok(found.clone());
        }
        let inspected = self.inspect_font(font_value, &[])?;
        self.fonts.borrow_mut().insert(key, inspected.clone());
        Ok(inspected)
    }
}

/// The inspector the worker uses when no external one is configured.
pub struct NativeResourceInspector;

impl ResourceInspector for NativeResourceInspector {
    fn inspect(&self, source: &Path) -> InspectionOutcome {
        match inspect_file(source) {
            Some(value) => InspectionOutcome::Supported(value),
            None => InspectionOutcome::Unsupported,
        }
    }
}
