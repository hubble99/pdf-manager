//! The per-page proofs of the inspection: marked-content constraints, text
//! paint slots, the uniform-backdrop context and the resource fingerprints.
//!
//! Each follows the old Python inspector step by step, including which lookups
//! it made through `dict[key]` (reference followed) and which through
//! `dict.get(key)` (the raw value, a reference staying a reference). Every
//! failed requirement is a `Reject`; the caller turns that into "no proof".

use std::collections::{BTreeMap, BTreeSet};

use super::content::{self, Op};
use super::pdf::{reject, Dict, Obj, PResult, Reject};
use super::pyjson::J;
use super::sfnt;
use super::values::{as_dict, as_text, sha256_hex, string_text, Ctx};

const MAX_OPERATIONS: usize = 100_000;
const MAX_DEPTH: usize = 64;
const MAX_FONTS: usize = 64;

fn require(condition: bool) -> PResult<()> {
    if condition {
        Ok(())
    } else {
        Err(Reject("proof is incomplete"))
    }
}

pub struct Page<'a> {
    pub dict: &'a Dict,
    /// `/Rotate` as pypdf's flattened page has it: the page's own raw value, or
    /// the nearest ancestor's (resolved) one.
    pub rotate: Option<Obj>,
}

fn number(value: &Obj) -> Option<f64> {
    match value {
        Obj::Int(n) => Some(*n as f64),
        Obj::Real(x) if x.is_finite() => Some(*x),
        _ => None,
    }
}

fn numbers(args: &[Obj], count: usize) -> PResult<()> {
    require(args.len() == count && args.iter().all(|a| number(a).is_some()))
}

fn name_is(value: Option<&Obj>, name: &str) -> bool {
    matches!(value, Some(Obj::Name(n)) if &**n == name)
}

fn equals_number(value: Option<&Obj>, expected: f64) -> bool {
    value.and_then(number) == Some(expected)
}

/// Length of a string as Python counts it.
fn string_len(bytes: &[u8]) -> usize {
    match string_text(bytes) {
        Some(text) => text.chars().count(),
        None => bytes.len(),
    }
}

fn is_string(value: &Obj) -> bool {
    matches!(value, Obj::Str(_))
}

impl<'a> Ctx<'a> {
    fn contents_of(&self, page: &Page<'_>) -> PResult<Option<Vec<Op>>> {
        content::page_operations(self.pdf, page.dict)
    }

    /// `x in mapping` followed by `mapping.raw_get(x)` for a resource category
    /// that may itself sit behind a reference.
    fn category<'o>(&self, resources: &'o Dict, key: &str) -> PResult<Option<Obj>> {
        match resources.get(key) {
            None => Ok(None),
            Some(value) => Ok(Some(self.resolve(value)?)),
        }
    }

    // ------------------------------------------------------------ fingerprints

    /// `resource_fingerprints`.
    pub fn resource_fingerprints(&self, resources: Option<&Obj>) -> PResult<J> {
        let Some(resources) = resources else { return Ok(J::Obj(BTreeMap::new())) };
        let resolved = self.resolve(resources)?;
        let Some(dict) = as_dict(&resolved) else { reject!("invalid resource dictionary") };
        self.fingerprints_of(dict)
    }

    fn fingerprints_of(&self, dict: &Dict) -> PResult<J> {
        let mut result = BTreeMap::new();
        for (kind, items) in dict.iter() {
            if matches!(kind, "/Font" | "/ProcSet") {
                continue;
            }
            let mapping = self.resolve(items)?;
            let Some(mapping) = as_dict(&mapping) else { reject!("unknown resource category") };
            if kind == "/ExtGState" {
                for (_, state) in mapping.iter() {
                    let state = self.semantic(state, None)?;
                    let J::Obj(entries) = state else { reject!("unproven nondefault graphics state") };
                    for (key, value) in entries.iter() {
                        let default = match key.as_str() {
                            "/Type" => J::str("/ExtGState"),
                            "/BM" => J::str("/Normal"),
                            "/CA" | "/ca" => J::Int(1),
                            _ => reject!("unproven nondefault graphics state"),
                        };
                        if *value != default {
                            reject!("unproven nondefault graphics state");
                        }
                    }
                }
                continue;
            }
            let mut hashes = Vec::new();
            for (_, item) in mapping.iter() {
                hashes.push(self.semantic_hash(item, None)?);
            }
            hashes.sort();
            result.insert(kind.to_string(), J::Arr(hashes.into_iter().map(J::Str).collect()));
        }
        Ok(J::Obj(result))
    }

    // ------------------------------------------------------------ images

    /// `image_resource_bindings`.
    pub fn image_resource_bindings(&self, page: &Page<'_>, resources: Option<&Obj>) -> PResult<J> {
        let resolved = match resources {
            Some(value) => self.resolve(value)?,
            None => Obj::Dict(Default::default()),
        };
        let Some(dict) = as_dict(&resolved) else { reject!("invalid image resource scope") };
        // pypdf's content stream is parsed (and may fail) before anything else.
        self.contents_of(page)?;
        let mapping = match dict.get("/XObject") {
            Some(value) => self.resolve(value)?,
            None => Obj::Dict(Default::default()),
        };
        let Some(mapping) = as_dict(&mapping) else { reject!("invalid image resource dictionary") };
        let mut result: Vec<(String, String)> = Vec::new();
        for (_, value) in mapping.iter() {
            let image = self.resolve(value)?;
            let Obj::Stream(stream) = &image else { reject!("opaque or nested image resource") };
            if !name_is(stream.dict.get("/Subtype"), "/Image") {
                reject!("opaque or nested image resource");
            }
            let raw = self.pdf.stream_bytes(stream);
            if raw.is_empty() || raw.len() > 64 * 1024 * 1024 {
                reject!("unbounded or empty image stream");
            }
            result.push((sha256_hex(raw), self.semantic_hash(value, None)?));
        }
        result.sort();
        Ok(J::Arr(
            result
                .into_iter()
                .map(|(raw, semantic)| J::obj([("rawSha256", J::Str(raw)), ("semanticSha256", J::Str(semantic))]))
                .collect(),
        ))
    }

    // ------------------------------------------------------------ marked content

    /// `marked_content_proof`.
    pub fn marked_content_proof(&self, page: &Page<'_>, resources: Option<&Obj>) -> PResult<J> {
        let Some(resources) = resources else { reject!("no resources") };
        let resolved = self.resolve(resources)?;
        let Some(resources) = as_dict(&resolved) else { reject!("resources are not a dictionary") };

        if let Some(xobjects) = resources.get("/XObject") {
            let mapping = self.resolve(xobjects)?;
            let Some(mapping) = as_dict(&mapping) else { reject!("bad /XObject") };
            for (_, image) in mapping.iter() {
                let image = self.resolve(image)?;
                let Some(image) = as_dict(&image) else { reject!("bad XObject") };
                require(name_is(image.get("/Subtype"), "/Image"))?;
            }
        }

        let mut states: BTreeMap<String, BTreeMap<&'static str, f64>> = BTreeMap::new();
        if let Some(extgstate) = resources.get("/ExtGState") {
            let mapping = self.resolve(extgstate)?;
            let Some(mapping) = as_dict(&mapping) else { reject!("bad /ExtGState") };
            for (name, value) in mapping.iter() {
                let value = self.resolve(value)?;
                let Some(value) = as_dict(&value) else { reject!("bad graphics state") };
                require(value.keys().all(|k| matches!(k, "/Type" | "/ca" | "/CA" | "/BM")))?;
                require(match value.get("/Type") {
                    None => true,
                    Some(v) => name_is(Some(v), "/ExtGState"),
                })?;
                require(match value.get("/BM") {
                    None => true,
                    Some(v) => name_is(Some(v), "/Normal"),
                })?;
                let mut state = BTreeMap::new();
                for key in ["/ca", "/CA"] {
                    if value.contains(key) {
                        let resolved = self.item(value, key)?;
                        let Some(x) = number(&resolved) else { reject!("bad alpha") };
                        require((0.0..=1.0).contains(&x))?;
                        state.insert(if key == "/ca" { "/ca" } else { "/CA" }, x);
                    }
                }
                states.insert(name.to_string(), state);
            }
        }

        let operations = self.contents_of(page)?;
        let Some(operations) = operations else { reject!("no contents") };
        require(operations.len() <= MAX_OPERATIONS)?;

        let mut font: Option<String> = None;
        let (mut alpha, mut stroke) = (1.0f64, 1.0f64);
        let mut graphics: Vec<(Option<String>, f64, f64)> = Vec::new();
        let mut marks: Vec<Option<i64>> = Vec::new();
        let mut groups: Vec<(i64, i64, GroupData)> = Vec::new();
        let (mut in_text, mut path_pending, mut seen_mark) = (false, false, false);
        let mut used_fonts: BTreeSet<String> = BTreeSet::new();
        let mut selected_fonts: BTreeSet<String> = BTreeSet::new();

        for Op { args, op } in operations.iter() {
            let op = op.as_slice();
            let numeric = match op {
                b"cm" | b"Tm" => Some(6),
                b"Td" | b"TD" => Some(2),
                b"Tc" | b"Tw" | b"Tz" | b"TL" | b"Tr" | b"Ts" | b"w" | b"J" | b"j" | b"M" | b"i" | b"g" | b"G" => Some(1),
                b"rg" | b"RG" => Some(3),
                b"k" | b"K" => Some(4),
                _ => None,
            };
            let path = match op {
                b"m" | b"l" => Some(2),
                b"c" => Some(6),
                b"v" | b"y" | b"re" => Some(4),
                _ => None,
            };
            let is_paint = matches!(op, b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*");

            if let Some(count) = numeric {
                numbers(args, count)?;
            } else if let Some(count) = path {
                numbers(args, count)?;
                require(!in_text && (path_pending || matches!(op, b"m" | b"re")))?;
                path_pending = true;
            } else if op == b"h" {
                require(args.is_empty() && path_pending)?;
            } else if is_paint || op == b"n" {
                require(args.is_empty() && !in_text)?;
                if is_paint {
                    require(path_pending)?;
                    record_paint(&mut groups, &marks, 2, &font, alpha, stroke, &mut used_fonts)?;
                }
                path_pending = false;
            } else if matches!(op, b"W" | b"W*") {
                require(args.is_empty() && path_pending)?;
            } else if matches!(op, b"q" | b"Q") {
                require(args.is_empty() && !path_pending)?;
                if op == b"q" {
                    require(graphics.len() < MAX_DEPTH)?;
                    graphics.push((font.clone(), alpha, stroke));
                } else {
                    let Some(top) = graphics.pop() else { reject!("unbalanced Q") };
                    (font, alpha, stroke) = top;
                }
            } else if op == b"gs" {
                require(args.len() == 1)?;
                let Obj::Name(name) = &args[0] else { reject!("bad gs") };
                let Some(state) = states.get(&**name) else { reject!("unknown graphics state") };
                alpha = state.get("/ca").copied().unwrap_or(alpha);
                stroke = state.get("/CA").copied().unwrap_or(stroke);
            } else if op == b"Tf" {
                require(args.len() == 2)?;
                let Obj::Name(name) = &args[0] else { reject!("bad Tf") };
                numbers(&args[1..], 1)?;
                let Some(Obj::Dict(_) | Obj::Stream(_)) = self.category(resources, "/Font")? else {
                    reject!("font not in resources")
                };
                let mapping = self.category(resources, "/Font")?.unwrap();
                let mapping = as_dict(&mapping).expect("checked");
                let Some(raw) = mapping.get(name) else { reject!("font not in resources") };
                let Obj::Ref(num, generation) = raw else { reject!("font is not an indirect object") };
                let dictionary = self.resolve(raw)?;
                let Some(dictionary) = as_dict(&dictionary) else { reject!("font is not a dictionary") };
                require(matches!(dictionary.get("/Subtype"), Some(Obj::Name(n)) if matches!(&**n, "/Type1" | "/TrueType" | "/Type0")))?;
                let id = format!("{num}:{generation}");
                selected_fonts.insert(id.clone());
                font = Some(id);
                require(selected_fonts.len() <= MAX_FONTS)?;
            } else if matches!(op, b"BT" | b"ET") {
                require(args.is_empty() && !path_pending && in_text == (op == b"ET"))?;
                in_text = op == b"BT";
            } else if op == b"T*" {
                require(args.is_empty() && in_text)?;
            } else if matches!(op, b"Tj" | b"TJ" | b"'" | b"\"") {
                require(in_text)?;
                let values: Vec<Obj> = if op == b"\"" {
                    require(args.len() == 3)?;
                    numbers(&args[..2], 2)?;
                    args[2..].to_vec()
                } else if op == b"TJ" {
                    require(args.len() == 1)?;
                    let Obj::Array(items) = &args[0] else { reject!("bad TJ") };
                    items.to_vec()
                } else {
                    require(args.len() == 1)?;
                    args.clone()
                };
                require(values.iter().all(|v| is_string(v) || (op == b"TJ" && number(v).is_some())))?;
                // An empty string draws nothing and creates no native object.
                if values.iter().any(|v| matches!(v, Obj::Str(bytes) if string_len(bytes) > 0)) {
                    record_paint(&mut groups, &marks, 1, &font, alpha, stroke, &mut used_fonts)?;
                }
            } else if op == b"Do" {
                require(!in_text && !path_pending && args.len() == 1)?;
                let Obj::Name(name) = &args[0] else { reject!("bad Do") };
                let Some(mapping) = self.category(resources, "/XObject")? else { reject!("XObject not in resources") };
                let Some(mapping) = as_dict(&mapping) else { reject!("XObject not in resources") };
                require(mapping.contains(name))?;
                record_paint(&mut groups, &marks, 3, &font, alpha, stroke, &mut used_fonts)?;
            } else if matches!(op, b"BDC" | b"BMC") {
                require(!path_pending && marks.len() < MAX_DEPTH)?;
                require(args.len() == if op == b"BDC" { 2 } else { 1 })?;
                let Obj::Name(tag) = &args[0] else { reject!("bad marked content tag") };
                require(&**tag != "/OC")?;
                let mut mcid = None;
                if op == b"BDC" {
                    let mut value = args[1].clone();
                    if let Obj::Name(property) = &value {
                        let properties = self.item(resources, "/Properties")?;
                        let Some(properties) = as_dict(&properties) else { reject!("bad /Properties") };
                        value = self.item(properties, property)?;
                    }
                    let Some(value) = as_dict(&value) else { reject!("marked content properties") };
                    require(value.keys().all(|k| matches!(k, "/MCID" | "/Lang" | "/Type" | "/Subtype" | "/Attached")))?;
                    if value.contains("/Lang") {
                        let lang = self.item(value, "/Lang")?;
                        require(matches!(&lang, Obj::Str(bytes) if string_text(bytes).is_some_and(|t| t.chars().count() <= 128)))?;
                    }
                    if value.keys().any(|k| matches!(k, "/Type" | "/Subtype" | "/Attached")) {
                        require(&**tag == "/Artifact" && name_is(value.get("/Type"), "/Pagination"))?;
                        require(matches!(value.get("/Subtype"), Some(Obj::Name(n)) if matches!(&**n, "/Header" | "/Footer")))?;
                        if let Some(attached) = value.get("/Attached") {
                            let Obj::Array(items) = attached else { reject!("bad /Attached") };
                            require(items.len() <= 4)?;
                            require(items.iter().all(|v| matches!(v, Obj::Name(n) if matches!(&**n, "/Top" | "/Bottom" | "/Left" | "/Right"))))?;
                        }
                    }
                    if value.contains("/MCID") {
                        let Obj::Int(id) = self.item(value, "/MCID")? else { reject!("bad MCID") };
                        require((0..=i64::from(i32::MAX)).contains(&id))?;
                        require(marks.iter().all(Option::is_none))?;
                        seen_mark = true;
                        mcid = Some(id);
                    }
                }
                marks.push(mcid);
            } else if op == b"EMC" {
                require(args.is_empty() && !marks.is_empty() && !path_pending)?;
                marks.pop();
            } else if op == b"d" {
                require(args.len() == 2)?;
                let Obj::Array(dashes) = &args[0] else { reject!("bad dash") };
                let mut all: Vec<Obj> = dashes.to_vec();
                all.push(args[1].clone());
                numbers(&all, dashes.len() + 1)?;
            } else if op == b"ri" {
                require(args.len() == 1 && matches!(args[0], Obj::Name(_)))?;
            } else {
                reject!("operator outside marked-content proof grammar");
            }
        }
        require(graphics.is_empty() && marks.is_empty() && !in_text && !path_pending && seen_mark)?;
        require(selected_fonts == used_fonts)?;

        let mut result = Vec::new();
        for (mcid, kind, data) in groups {
            let state = if data.states.len() == 1 {
                J::Arr(vec![J::Float(data.states[0].0), J::Float(data.states[0].1), J::str("/Normal")])
            } else {
                J::Null
            };
            result.push(J::obj([
                ("mcid", J::Int(mcid)),
                ("kind", J::Int(kind)),
                ("count", J::Int(data.count)),
                ("fonts", J::Arr(data.fonts.into_iter().map(J::Str).collect())),
                ("state", state),
            ]));
        }
        let mut rest = Dict::default();
        for (key, value) in resources.iter() {
            if key != "/ExtGState" {
                rest.entries.push((key.into(), value.clone()));
            }
        }
        Ok(J::obj([
            ("schema", J::str("marked-content-constraints/v1")),
            ("groups", J::Arr(result)),
            ("resources", self.fingerprints_of(&rest)?),
        ]))
    }

    // ------------------------------------------------------------ text slots

    /// `text_paint_slots`.
    pub fn text_paint_slots(&self, page: &Page<'_>, resources: Option<&Obj>) -> PResult<J> {
        let Some(operations) = self.contents_of(page)? else { reject!("no contents") };
        require(operations.len() <= MAX_OPERATIONS)?;
        #[derive(Clone)]
        struct State {
            font: Option<String>,
            size: Option<f32>,
            ctm_identity: bool,
            mode: f64,
            rise: f64,
            scale: f64,
        }
        let mut state = State { font: None, size: None, ctm_identity: true, mode: 0.0, rise: 0.0, scale: 100.0 };
        let mut stack: Vec<State> = Vec::new();
        let mut marks: Vec<Option<Obj>> = Vec::new();
        let mut slots: Vec<J> = Vec::new();
        let mut empty_fonts: BTreeMap<String, bool> = BTreeMap::new();
        let mut standard_fonts: BTreeMap<String, bool> = BTreeMap::new();
        let mut matrix: Option<Vec<f32>> = None;
        let (mut painted, mut in_text) = (false, false);

        let to_f32 = |value: &Obj| -> PResult<f32> {
            let x = number(value).ok_or(Reject("not a number"))?;
            let narrowed = x as f32;
            if narrowed.is_infinite() {
                reject!("number does not fit a float");
            }
            Ok(narrowed)
        };
        let bits = |x: f32| J::Int(i64::from(x.to_bits()));

        for Op { args, op } in operations.iter() {
            match op.as_slice() {
                b"q" => stack.push(state.clone()),
                b"Q" => state = stack.pop().ok_or(Reject("unbalanced Q"))?,
                b"cm" => {
                    let identity = args.len() == 6
                        && args.iter().zip([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]).all(|(a, e)| number(a) == Some(e));
                    state.ctm_identity &= identity;
                }
                b"Tf" => {
                    let Some(Obj::Name(name)) = args.first() else { reject!("bad Tf") };
                    let font_resources = self.item(as_dict(&self.resolve(resources.ok_or(Reject("no resources"))?)?).ok_or(Reject("bad resources"))?, "/Font")?;
                    let Some(font_map) = as_dict(&font_resources) else { reject!("bad /Font") };
                    let Some(raw @ Obj::Ref(num, generation)) = font_map.get(name) else { reject!("font is not an indirect object") };
                    let id = format!("{num}:{generation}");
                    let size = to_f32(args.get(1).ok_or(Reject("bad Tf"))?)?;
                    state.font = Some(id.clone());
                    state.size = Some(size);
                    if !empty_fonts.contains_key(&id) {
                        let embedded = self.empty_winansi_space(raw).unwrap_or(false);
                        let standard = !embedded && self.standard_nonembedded_space(raw).unwrap_or(false);
                        empty_fonts.insert(id.clone(), embedded || standard);
                        standard_fonts.insert(id, standard);
                    }
                }
                b"Tr" | b"Ts" | b"Tz" => {
                    let value = number(args.first().ok_or(Reject("missing operand"))?).ok_or(Reject("not a number"))?;
                    match op.as_slice() {
                        b"Tr" => state.mode = value,
                        b"Ts" => state.rise = value,
                        _ => state.scale = value,
                    }
                }
                b"BT" => {
                    matrix = None;
                    painted = false;
                    in_text = true;
                }
                b"ET" => in_text = false,
                b"Tm" => {
                    require(in_text && !painted)?;
                    matrix = Some(args.iter().map(&to_f32).collect::<PResult<_>>()?);
                }
                b"Td" => {
                    require(in_text && matrix.is_none() && !painted && args.len() == 2)?;
                    matrix = Some(vec![1.0, 0.0, 0.0, 1.0, to_f32(&args[0])?, to_f32(&args[1])?]);
                }
                b"TD" | b"T*" | b"'" | b"\"" => require(false)?,
                b"BDC" | b"BMC" => {
                    let mut mcid = None;
                    if op.as_slice() == b"BDC" {
                        let value = args.get(1).ok_or(Reject("bad BDC"))?;
                        let resolved_value;
                        let dict = match value {
                            Obj::Name(property) => {
                                let properties = self.item(as_dict(&self.resolve(resources.ok_or(Reject("no resources"))?)?).ok_or(Reject("bad resources"))?, "/Properties")?;
                                let properties = as_dict(&properties).ok_or(Reject("bad /Properties"))?;
                                resolved_value = self.item(properties, property)?;
                                as_dict(&resolved_value).ok_or(Reject("bad property list"))?
                            }
                            Obj::Dict(dict) => dict,
                            _ => reject!("bad BDC"),
                        };
                        mcid = dict.get("/MCID").cloned();
                    } else {
                        require(!args.is_empty() || true)?;
                    }
                    marks.push(mcid);
                }
                b"EMC" => {
                    marks.pop().ok_or(Reject("unbalanced EMC"))?;
                }
                b"Tj" | b"TJ" => {
                    require(in_text && matrix.is_some() && !painted && state.ctm_identity)?;
                    require(state.scale == 100.0 && state.rise == 0.0)?;
                    let values: Vec<Obj> = if op.as_slice() == b"TJ" {
                        match args.first() {
                            Some(Obj::Array(items)) => items.to_vec(),
                            _ => reject!("bad TJ"),
                        }
                    } else {
                        args.clone()
                    };
                    // A leading displacement moves the native object's start.
                    require(matches!(values.first(), Some(Obj::Str(bytes)) if string_len(bytes) > 0))?;
                    let mut code_bytes: Vec<u8> = Vec::new();
                    for value in &values {
                        if let Obj::Str(bytes) = value {
                            code_bytes.extend_from_slice(bytes);
                        }
                    }
                    require(!code_bytes.is_empty() && code_bytes.len() <= 65536)?;
                    let font = state.font.clone().ok_or(Reject("no font"))?;
                    let empty = *empty_fonts.get(&font).ok_or(Reject("no font"))?;
                    let standard = *standard_fonts.get(&font).ok_or(Reject("no font"))?;
                    let mcid = match marks.iter().flatten().next() {
                        None => J::Int(-1),
                        Some(Obj::Int(n)) => J::Int(*n),
                        Some(Obj::Real(x)) => J::Float(*x),
                        Some(_) => return Err(Reject("fatal: marked-content id is not a number")),
                    };
                    let ascii = empty && code_bytes.len() <= 1024 && code_bytes.iter().all(|b| (32..=126).contains(b));
                    slots.push(J::obj([
                        ("mcid", mcid),
                        ("fontObject", J::Str(font)),
                        ("matrixBits", J::Arr(matrix.as_ref().unwrap().iter().map(|v| bits(*v)).collect())),
                        ("fontSizeBits", bits(state.size.ok_or(Reject("no font size"))?)),
                        (
                            "asciiCodes",
                            if ascii { J::Arr(code_bytes.iter().map(|b| J::Int(i64::from(*b))).collect()) } else { J::Null },
                        ),
                        ("emptyPaint", J::Bool(state.mode == 0.0 && code_bytes == b" " && empty)),
                        ("emptyProof", J::str(if standard { "standard-space/v1" } else { "winansi-loca/v1" })),
                    ]));
                    painted = true;
                }
                _ => {}
            }
        }
        Ok(J::Arr(slots))
    }

    /// `empty_winansi_space` for the font behind `font` (a reference).
    fn empty_winansi_space(&self, font: &Obj) -> PResult<bool> {
        let font = self.resolve(font)?;
        let Some(font) = as_dict(&font) else { return Ok(false) };
        if !name_is(font.get("/Subtype"), "/TrueType") || !name_is(font.get("/Encoding"), "/WinAnsiEncoding") || font.contains("/ToUnicode") {
            return Ok(false);
        }
        let descriptor = match font.get("/FontDescriptor") {
            Some(value) => self.resolve(value)?,
            None => return Ok(false),
        };
        let Some(descriptor) = as_dict(&descriptor) else { reject!("bad descriptor") };
        if !equals_number(descriptor.get("/Flags"), 32.0) || !descriptor.contains("/FontFile2") {
            return Ok(false);
        }
        let program = self.item(descriptor, "/FontFile2")?;
        let data = self.stream_data(&program)?;
        if data.is_empty() || data.len() > 16 * 1024 * 1024 {
            return Ok(false);
        }
        Ok(sfnt::winansi_space_is_empty(&data))
    }

    /// `standard_nonembedded_space`.
    fn standard_nonembedded_space(&self, font: &Obj) -> PResult<bool> {
        const FAMILIES: [&str; 13] = [
            "Arial", "TimesNewRoman", "CourierNew", "Calibri", "Cambria", "Verdana", "Tahoma", "Georgia", "TrebuchetMS",
            "Helvetica", "Times-", "Times", "Courier",
        ];
        let font = self.resolve(font)?;
        let Some(font) = as_dict(&font) else { return Ok(false) };
        if !matches!(font.get("/Subtype"), Some(Obj::Name(n)) if matches!(&**n, "/TrueType" | "/Type1"))
            || !name_is(font.get("/Encoding"), "/WinAnsiEncoding")
        {
            return Ok(false);
        }
        if font.contains("/ToUnicode") {
            return Ok(false);
        }
        let mut descriptor_dict: Option<Dict> = None;
        if let Some(value) = font.get("/FontDescriptor") {
            let resolved = self.resolve(value)?;
            let Some(dict) = as_dict(&resolved) else { reject!("bad descriptor") };
            descriptor_dict = Some(dict.clone());
        }
        if let Some(descriptor) = &descriptor_dict {
            if ["/FontFile", "/FontFile2", "/FontFile3"].iter().any(|k| descriptor.contains(k)) {
                return Ok(false);
            }
            if descriptor.len() > 0 && !equals_number(descriptor.get("/Flags"), 32.0) {
                return Ok(false);
            }
        }
        let base = match font.get("/BaseFont") {
            None => String::new(),
            Some(value) => match as_text(value) {
                Ok(text) => text,
                Err(_) => return Ok(false),
            },
        };
        let base = base.strip_prefix('/').unwrap_or(&base);
        let chars: Vec<char> = base.chars().collect();
        if chars.len() > 7 && chars[6] == '+' {
            return Ok(false);
        }
        let base = base.replace(' ', "");
        Ok(FAMILIES.iter().any(|family| base.starts_with(family)))
    }

    // ------------------------------------------------------------ backdrop

    /// `backdrop_context`.
    pub fn backdrop_context(&self, page: &Page<'_>, resources: Option<&Obj>) -> PResult<J> {
        let dict = page.dict;
        require(dict.keys().all(|k| {
            matches!(
                k,
                "/Type" | "/Parent" | "/Resources" | "/Contents" | "/MediaBox" | "/CropBox" | "/Rotate" | "/Group" | "/Annots" | "/Tabs" | "/StructParents"
            )
        }))?;
        require(match &page.rotate {
            None => true,
            Some(value) => number(value) == Some(0.0),
        })?;
        if dict.contains("/Group") {
            let group = self.item(dict, "/Group")?;
            let Some(group) = as_dict(&group) else { reject!("bad /Group") };
            require(group.keys().all(|k| matches!(k, "/Type" | "/S" | "/CS" | "/I" | "/K")))?;
            require(match group.get("/Type") {
                None => true,
                Some(v) => name_is(Some(v), "/Group"),
            })?;
            require(name_is(group.get("/S"), "/Transparency"))?;
            require(name_is(group.get("/CS"), "/DeviceRGB"))?;
            require(self.false_or_absent(group, "/I")? && self.false_or_absent(group, "/K")?)?;
        }
        let annotations = match dict.get("/Annots") {
            Some(value) => self.resolve(value)?,
            None => Obj::Array(Default::default()),
        };
        let Obj::Array(annotations) = annotations else { reject!("bad /Annots") };
        require(annotations.len() <= 256)?;
        let mut rectangles = Vec::new();
        for raw in annotations.iter() {
            let annot = self.resolve(raw)?;
            let Some(annot) = as_dict(&annot) else { reject!("bad annotation") };
            require(annot.keys().all(|k| matches!(k, "/Type" | "/Subtype" | "/Rect" | "/BS" | "/F" | "/A")))?;
            require(match annot.get("/Type") {
                None => true,
                Some(v) => name_is(Some(v), "/Annot"),
            })?;
            require(name_is(annot.get("/Subtype"), "/Link"))?;
            require(match annot.get("/F") {
                None => true,
                Some(v) => equals_number(Some(v), 0.0) || equals_number(Some(v), 4.0),
            })?;
            let border = match annot.get("/BS") {
                Some(value) => self.resolve(value)?,
                None => Obj::Dict(Default::default()),
            };
            let Some(border) = as_dict(&border) else { reject!("bad /BS") };
            require(border.len() == 1 && border.contains("/W"))?;
            require(number(&self.item(border, "/W")?) == Some(0.0))?;
            if annot.contains("/A") {
                let action = self.item(annot, "/A")?;
                let Some(action) = as_dict(&action) else { reject!("bad /A") };
                require(action.keys().all(|k| matches!(k, "/Type" | "/S" | "/URI")))?;
                require(name_is(action.get("/S"), "/URI"))?;
                require(match action.get("/Type") {
                    None => true,
                    Some(v) => name_is(Some(v), "/Action"),
                })?;
                require(matches!(action.get("/URI"), Some(Obj::Name(_)) | Some(Obj::Str(_))) && match action.get("/URI") {
                    Some(Obj::Str(bytes)) => string_text(bytes).is_some(),
                    _ => true,
                })?;
            }
            let Obj::Array(rect) = self.item(annot, "/Rect")? else { reject!("bad /Rect") };
            numbers(&rect, 4)?;
            let v: Vec<f64> = rect.iter().filter_map(number).collect();
            require(v[0] < v[2] && v[1] < v[3])?;
            rectangles.push(J::Arr(v.into_iter().map(J::Float).collect()));
        }
        let images = match resources {
            None => reject!("no resources"),
            Some(value) => {
                let resolved = self.resolve(value)?;
                let Some(scope) = as_dict(&resolved) else { reject!("resources are not a dictionary") };
                match scope.get("/XObject") {
                    Some(images) => self.resolve(images)?,
                    None => Obj::Dict(Default::default()),
                }
            }
        };
        let Some(images) = as_dict(&images) else { reject!("bad /XObject") };
        require(images.len() <= 256)?;
        let mut empty: Vec<String> = Vec::new();
        for (_, raw) in images.iter() {
            if let Ok(hash) = self.zero_soft_mask(raw) {
                empty.push(hash);
            }
        }
        require(empty.len() == empty.iter().collect::<BTreeSet<_>>().len())?;
        empty.sort();
        Ok(J::obj([
            ("schema", J::str("uniform-backdrop-context/v1")),
            ("annotationRects", J::Arr(rectangles)),
            ("zeroMaskImages", J::Arr(empty.into_iter().map(J::Str).collect())),
        ]))
    }

    fn false_or_absent(&self, dict: &Dict, key: &str) -> PResult<bool> {
        if !dict.contains(key) {
            return Ok(true);
        }
        Ok(matches!(self.item(dict, key)?, Obj::Bool(false)))
    }

    fn zero_soft_mask(&self, raw: &Obj) -> PResult<String> {
        const ALLOWED: [&str; 11] = [
            "/Type", "/Subtype", "/Width", "/Height", "/BitsPerComponent", "/ColorSpace", "/Interpolate", "/SMask", "/Length",
            "/Filter", "/DecodeParms",
        ];
        let image = self.resolve(raw)?;
        let Obj::Stream(stream) = &image else { reject!("not a stream") };
        let image_dict = &stream.dict;
        require(image_dict.keys().all(|k| ALLOWED.contains(&k)))?;
        require(match image_dict.get("/Type") {
            None => true,
            Some(v) => name_is(Some(v), "/XObject"),
        } && name_is(image_dict.get("/Subtype"), "/Image"))?;
        require(name_is(image_dict.get("/ColorSpace"), "/DeviceRGB") && equals_number(image_dict.get("/BitsPerComponent"), 8.0))?;
        require(self.false_or_absent(image_dict, "/Interpolate")?)?;
        let (Obj::Int(width), Obj::Int(height)) = (self.item(image_dict, "/Width")?, self.item(image_dict, "/Height")?) else {
            reject!("bad size")
        };
        require(width > 0 && height > 0 && width.checked_mul(height).and_then(|n| n.checked_mul(3)).is_some_and(|n| n <= 64 * 1024 * 1024))?;
        let mask = self.item(image_dict, "/SMask")?;
        let Obj::Stream(mask_stream) = &mask else { reject!("mask is not a stream") };
        let mask_dict = &mask_stream.dict;
        require(mask_dict.keys().all(|k| (ALLOWED.contains(&k) && k != "/SMask") || matches!(k, "/Matte" | "/Decode")))?;
        require(match mask_dict.get("/Type") {
            None => true,
            Some(v) => name_is(Some(v), "/XObject"),
        } && name_is(mask_dict.get("/Subtype"), "/Image"))?;
        require(name_is(mask_dict.get("/ColorSpace"), "/DeviceGray") && equals_number(mask_dict.get("/BitsPerComponent"), 8.0))?;
        require(equals_number(mask_dict.get("/Width"), width as f64) && equals_number(mask_dict.get("/Height"), height as f64))?;
        require(self.false_or_absent(mask_dict, "/Interpolate")?)?;
        let decode_ok = match mask_dict.get("/Decode") {
            None => true,
            Some(value) => match self.resolve(value)? {
                Obj::Array(items) => items.len() == 2 && number(&items[0]) == Some(0.0) && number(&items[1]) == Some(1.0),
                _ => false,
            },
        };
        require(decode_ok)?;
        require(match image_dict.get("/Filter") {
            None => true,
            Some(v) => name_is(Some(v), "/FlateDecode"),
        } && match mask_dict.get("/Filter") {
            None => true,
            Some(v) => name_is(Some(v), "/FlateDecode"),
        })?;
        if mask_dict.contains("/Matte") {
            let Obj::Array(matte) = self.item(mask_dict, "/Matte")? else { reject!("bad /Matte") };
            numbers(&matte, 3)?;
            require(matte.iter().all(|v| number(v).is_some_and(|x| (0.0..=1.0).contains(&x))))?;
        }
        let data = self.stream_data(&mask)?;
        require(data.len() as i64 == width * height && data.iter().all(|b| *b == 0))?;
        self.semantic_hash(&image, None)
    }
}

type GroupData = GroupStats;

pub struct GroupStats {
    count: i64,
    fonts: BTreeSet<String>,
    states: Vec<(f64, f64)>,
}

fn record_paint(
    groups: &mut Vec<(i64, i64, GroupData)>,
    marks: &[Option<i64>],
    kind: i64,
    font: &Option<String>,
    alpha: f64,
    stroke: f64,
    used_fonts: &mut BTreeSet<String>,
) -> PResult<()> {
    let mcid = marks.iter().flatten().next().copied().unwrap_or(-1);
    let index = match groups.iter().position(|(m, k, _)| *m == mcid && *k == kind) {
        Some(index) => index,
        None => {
            groups.push((mcid, kind, GroupStats { count: 0, fonts: BTreeSet::new(), states: Vec::new() }));
            groups.len() - 1
        }
    };
    let group = &mut groups[index].2;
    group.count += 1;
    if kind == 1 {
        let Some(font) = font else { reject!("text without a font") };
        group.fonts.insert(font.clone());
        used_fonts.insert(font.clone());
        require(used_fonts.len() <= MAX_FONTS)?;
    }
    // Two distinct values are enough to make the group unprovable.
    if group.states.len() < 2 && !group.states.contains(&(alpha, stroke)) {
        group.states.push((alpha, stroke));
    }
    Ok(())
}
