//! The font half of the resource inspection: what each font dictionary says
//! about itself, and which characters its embedded program can draw.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::OnceLock;

use super::data::encodings::{MAC_ROMAN, WIN_ANSI};
use super::pdf::{reject, Dict, Obj, PResult};
use super::pyjson::J;
use super::sfnt;
use super::values::{as_dict, as_text, sha256_hex, string_text, Ctx};

const BASE14: [&str; 12] = [
    "Courier",
    "Courier-Bold",
    "Courier-Oblique",
    "Courier-BoldOblique",
    "Helvetica",
    "Helvetica-Bold",
    "Helvetica-Oblique",
    "Helvetica-BoldOblique",
    "Times-Roman",
    "Times-Bold",
    "Times-Italic",
    "Times-BoldItalic",
];

fn is_cid_subtype(subtype: &str) -> bool {
    matches!(subtype, "/Type0" | "/CIDFontType0" | "/CIDFontType2")
}

fn json_hash(value: &J) -> String {
    sha256_hex(value.dump().as_bytes())
}

pub fn effective_base_font(value: &str) -> PResult<String> {
    let name = value.strip_prefix('/').unwrap_or(value);
    let chars: Vec<char> = name.chars().collect();
    if chars.len() > 7 && chars[6] == '+' {
        let prefix = &chars[..6];
        if prefix.iter().any(|c| !c.is_ascii()) {
            reject!("non-ASCII subset prefix");
        }
        if prefix.iter().all(|c| c.is_ascii_uppercase()) {
            return Ok(chars[7..].iter().collect());
        }
    }
    Ok(name.to_string())
}

fn collision_effective_base_font(value: &str, subtype: &str) -> PResult<String> {
    if is_cid_subtype(subtype) {
        Ok(value.strip_prefix('/').unwrap_or(value).to_string())
    } else {
        effective_base_font(value)
    }
}

fn agl() -> &'static HashMap<&'static str, Vec<char>> {
    static TABLE: OnceLock<HashMap<&'static str, Vec<char>>> = OnceLock::new();
    TABLE.get_or_init(|| {
        include_str!("data/agl.txt")
            .lines()
            .filter_map(|line| {
                let (name, points) = line.split_once(' ')?;
                let chars = points.split(',').map(|p| u32::from_str_radix(p, 16).ok().and_then(char::from_u32)).collect::<Option<Vec<_>>>()?;
                Some((name, chars))
            })
            .collect()
    })
}

fn upper_hex(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}

/// fontTools' `agl.toUnicode` for a glyph name (no Zapf Dingbats handling, which
/// the inspector never asked for).
pub fn glyph_name_to_unicode(glyph: &str) -> Vec<char> {
    let base = glyph.split('.').next().unwrap_or("");
    let mut out = Vec::new();
    for component in base.split('_') {
        if let Some(chars) = agl().get(component) {
            if !chars.is_empty() {
                out.extend(chars);
                continue;
            }
        }
        if let Some(digits) = component.strip_prefix("uni") {
            if upper_hex(digits) && digits.len() % 4 == 0 {
                let points: Vec<u32> = (0..digits.len()).step_by(4).map(|i| u32::from_str_radix(&digits[i..i + 4], 16).unwrap()).collect();
                if !points.iter().any(|p| (0xD800..=0xDFFF).contains(p)) {
                    out.extend(points.into_iter().map(|p| char::from_u32(p).unwrap()));
                    continue;
                }
            }
        }
        if let Some(digits) = component.strip_prefix('u') {
            if upper_hex(digits) && (4..=6).contains(&digits.len()) {
                let value = u32::from_str_radix(digits, 16).unwrap();
                if let Some(c) = char::from_u32(value) {
                    out.push(c);
                }
            }
        }
    }
    out
}

fn named_encoding(name: &str) -> Option<BTreeSet<u32>> {
    match name.strip_prefix('/').unwrap_or(name) {
        "WinAnsiEncoding" => Some(WIN_ANSI.iter().copied().filter(|cp| *cp != 0).collect()),
        "MacRomanEncoding" => Some(MAC_ROMAN.iter().copied().filter(|cp| *cp != 0).collect()),
        "StandardEncoding" => Some((0x20..0x7F).collect()),
        _ => None,
    }
}

fn code_point_ranges(points: &BTreeSet<u32>) -> J {
    let mut ranges: Vec<[u32; 2]> = Vec::new();
    for &point in points {
        match ranges.last_mut() {
            Some(last) if point <= last[1] + 1 => last[1] = point,
            _ => ranges.push([point, point]),
        }
    }
    J::Arr(ranges.into_iter().map(|[a, b]| J::Arr(vec![J::Int(a.into()), J::Int(b.into())])).collect())
}

impl<'a> Ctx<'a> {
    pub fn inspect_font(&self, font_value: &Obj, active: &[String]) -> PResult<J> {
        let font_id = self.object_id(font_value);
        if active.contains(&font_id) {
            reject!("font refers back to itself");
        }
        let mut active = active.to_vec();
        active.push(font_id.clone());
        let font_object = self.resolve(font_value)?;
        let Some(font) = as_dict(&font_object) else { reject!("font is not a dictionary") };

        let subtype = match font.get("/Subtype") {
            None => String::new(),
            Some(value) => as_text(value)?,
        };
        let base_font = match font.get("/BaseFont") {
            None => String::new(),
            Some(value) => as_text(value)?,
        };
        if subtype.is_empty() {
            reject!("font without a subtype");
        }

        let encoding = self.inspect_encoding(font.get("/Encoding"))?;
        let to_unicode = match font.get("/ToUnicode") {
            None => J::Null,
            Some(value) => self.inspect_stream(value)?,
        };
        let mut descendants: Vec<J> = Vec::new();
        if let Some(value) = font.get("/DescendantFonts") {
            match self.resolve(value)? {
                Obj::Array(items) if !items.is_empty() => {
                    for item in items.iter() {
                        descendants.push(self.inspect_font(item, &active)?);
                    }
                }
                _ => reject!("bad /DescendantFonts"),
            }
        } else if subtype == "/Type0" {
            reject!("Type0 font without descendants");
        }

        let descriptor_value = font.get("/FontDescriptor");
        let descriptor = self.inspect_descriptor(descriptor_value)?;
        let widths = self.inspect_widths(font)?;
        let cid_to_gid = match font.get("/CIDToGIDMap") {
            None => J::Null,
            Some(value) => {
                let resolved = self.resolve(value)?;
                if matches!(resolved, Obj::Name(_)) || is_text(&resolved) {
                    let detail = J::obj([("name", J::Str(as_text(&resolved)?))]);
                    J::obj([("detail", detail.clone()), ("sha256", J::Str(json_hash(&detail)))])
                } else {
                    self.inspect_stream(value)?
                }
            }
        };
        let mut coverage = self.inspect_glyph_coverage(font, descriptor_value, &subtype, &base_font, &encoding)?;
        if subtype == "/Type0" {
            coverage = match descendants.as_slice() {
                [only] => match only {
                    J::Obj(map) => map.get("glyphCoverage").cloned().unwrap_or(J::Null),
                    _ => J::Null,
                },
                _ => J::obj([
                    ("status", J::str("unknown")),
                    ("source", J::str("ambiguous-descendant-fonts")),
                    ("ranges", J::Arr(Vec::new())),
                ]),
            };
        }
        let semantic = match self.semantic_hash(font_value, None) {
            Ok(hash) => J::Str(hash),
            Err(_) => J::Null,
        };
        let cid_system_info = match font.get("/CIDSystemInfo") {
            None => J::Null,
            Some(value) => self.canonical(value, 0)?,
        };
        Ok(J::obj([
            ("fontObject", J::Str(font_id)),
            ("semanticSha256", semantic),
            ("baseFont", J::Str(base_font.clone())),
            ("effectiveBaseFont", J::Str(effective_base_font(&base_font)?)),
            ("collisionEffectiveBaseFont", J::Str(collision_effective_base_font(&base_font, &subtype)?)),
            ("subtype", J::Str(subtype)),
            ("encoding", encoding.json),
            ("toUnicode", to_unicode),
            ("fontPrograms", descriptor),
            ("glyphCoverage", coverage),
            ("widths", widths),
            ("cidToGidMap", cid_to_gid),
            ("cidSystemInfo", cid_system_info),
            ("descendants", J::Arr(descendants)),
        ]))
    }

    fn inspect_encoding(&self, value: Option<&Obj>) -> PResult<EncodingInfo> {
        let Some(value) = value else { return Ok(EncodingInfo { json: J::Null, sha256: None }) };
        let resolved = self.resolve(value)?;
        let detail = match &resolved {
            Obj::Name(_) | Obj::Str(_) => J::obj([("name", J::Str(as_text(&resolved)?))]),
            Obj::Dict(_) | Obj::Stream(_) => {
                let dict = as_dict(&resolved).expect("checked");
                let base = match dict.get("/BaseEncoding") {
                    None => String::new(),
                    Some(value) => as_text(value)?,
                };
                let differences = match dict.get("/Differences") {
                    None => J::Null,
                    Some(value) => self.canonical(value, 0)?,
                };
                J::obj([
                    ("baseEncoding", if base.is_empty() { J::Null } else { J::Str(base) }),
                    ("differences", differences),
                ])
            }
            _ => reject!("unsupported /Encoding"),
        };
        let sha = json_hash(&detail);
        Ok(EncodingInfo { json: J::obj([("detail", detail), ("sha256", J::Str(sha.clone()))]), sha256: Some(sha) })
    }

    /// `{"object", "bytes", "sha256"}` of a stream that is referenced by `value`.
    pub fn inspect_stream(&self, value: &Obj) -> PResult<J> {
        let stream = self.resolve(value)?;
        let data = self.stream_data(&stream)?;
        Ok(J::obj([
            ("object", J::Str(self.object_id(value))),
            ("bytes", J::Int(data.len() as i64)),
            ("sha256", J::Str(sha256_hex(&data))),
        ]))
    }

    fn inspect_descriptor(&self, value: Option<&Obj>) -> PResult<J> {
        let Some(value) = value else { return Ok(J::Arr(Vec::new())) };
        let resolved = self.resolve(value)?;
        let Some(descriptor) = as_dict(&resolved) else { reject!("font descriptor is not a dictionary") };
        let mut programs = Vec::new();
        for key in ["/FontFile", "/FontFile2", "/FontFile3"] {
            if let Some(program) = descriptor.get(key) {
                let J::Obj(mut detail) = self.inspect_stream(program)? else { unreachable!() };
                detail.insert("kind".into(), J::str(key));
                programs.push(J::Obj(detail));
            }
        }
        Ok(J::Arr(programs))
    }

    fn inspect_widths(&self, font: &Dict) -> PResult<J> {
        let mut fields = BTreeMap::new();
        for key in ["/FirstChar", "/LastChar", "/Widths", "/DW", "/W", "/DW2", "/W2"] {
            if let Some(value) = font.get(key) {
                fields.insert(key[1..].to_string(), self.canonical(value, 0)?);
            }
        }
        if fields.is_empty() {
            return Ok(J::Null);
        }
        let detail = J::Obj(fields);
        let sha = json_hash(&detail);
        Ok(J::obj([("detail", detail), ("sha256", J::Str(sha))]))
    }

    fn inspect_glyph_coverage(
        &self,
        font: &Dict,
        descriptor_value: Option<&Obj>,
        subtype: &str,
        base_font: &str,
        encoding: &EncodingInfo,
    ) -> PResult<J> {
        if subtype == "/Type3" {
            return Ok(J::obj([("status", J::str("type3")), ("source", J::str("type3")), ("ranges", J::Arr(Vec::new()))]));
        }
        let encoding_sha = encoding.sha256.clone().map_or(J::Null, J::Str);
        let mut program: Option<(Vec<u8>, String)> = None;
        if let Some(value) = descriptor_value {
            let resolved = self.resolve(value)?;
            let Some(descriptor) = as_dict(&resolved) else { reject!("font descriptor is not a dictionary") };
            for key in ["/FontFile2", "/FontFile3", "/FontFile"] {
                let Some(file) = descriptor.get(key) else { continue };
                let stream = self.resolve(file)?;
                let data = self.stream_data(&stream)?;
                let hash = sha256_hex(&data);
                program = Some((data, hash));
                break;
            }
        }

        let encoding_points = self.encoding_codepoints(font)?;
        if let Some((data, hash)) = &program {
            let Some(mut coverage) = sfnt::cmap_codepoints(data) else {
                return Ok(J::obj([
                    ("status", J::str("unknown")),
                    ("source", J::str("embedded-program-unparseable")),
                    ("ranges", J::Arr(Vec::new())),
                    ("fontProgramSha256", J::Str(hash.clone())),
                    ("encodingSha256", encoding_sha),
                ]));
            };
            if let Some(points) = &encoding_points {
                if !is_cid_subtype(subtype) {
                    coverage = coverage.intersection(points).copied().collect();
                }
            }
            return Ok(J::obj([
                ("status", J::str("proven")),
                ("source", J::str("embedded-cmap-and-encoding")),
                ("ranges", code_point_ranges(&coverage)),
                ("fontProgramSha256", J::Str(hash.clone())),
                ("encodingSha256", encoding_sha),
            ]));
        }

        let standard = effective_base_font(base_font)?;
        if let (true, Some(points)) = (BASE14.contains(&standard.as_str()), &encoding_points) {
            return Ok(J::obj([
                ("status", J::str("proven")),
                ("source", J::str("standard-font-encoding")),
                ("ranges", code_point_ranges(points)),
                ("fontProgramSha256", J::Null),
                ("encodingSha256", encoding_sha),
            ]));
        }
        Ok(J::obj([
            ("status", J::str("unknown")),
            ("source", J::str("font-program-or-encoding-unavailable")),
            ("ranges", J::Arr(Vec::new())),
            ("fontProgramSha256", J::Null),
            ("encodingSha256", encoding_sha),
        ]))
    }

    fn encoding_codepoints(&self, font: &Dict) -> PResult<Option<BTreeSet<u32>>> {
        let Some(value) = font.get("/Encoding") else { return Ok(Some((0x20..0x7F).collect())) };
        let resolved = self.resolve(value)?;
        match &resolved {
            Obj::Name(_) | Obj::Str(_) => return Ok(named_encoding(&as_text(&resolved)?)),
            Obj::Dict(_) | Obj::Stream(_) => {}
            _ => return Ok(None),
        }
        let dict = as_dict(&resolved).expect("checked");
        let base_name = match dict.get("/BaseEncoding") {
            None => "/StandardEncoding".to_string(),
            Some(value) => as_text(value)?,
        };
        let mut base = named_encoding(&base_name).unwrap_or_default();
        if let Some(differences) = dict.get("/Differences") {
            let Obj::Array(items) = self.resolve(differences)? else { return Ok(None) };
            for item in items.iter() {
                let name = match item {
                    Obj::Name(name) => Some(name.to_string()),
                    Obj::Str(bytes) => string_text(bytes),
                    _ => None,
                };
                if let Some(name) = name.filter(|n| n.starts_with('/')) {
                    base.extend(glyph_name_to_unicode(&name[1..]).into_iter().map(u32::from));
                }
            }
        }
        Ok(Some(base))
    }
}

fn is_text(value: &Obj) -> bool {
    matches!(value, Obj::Str(bytes) if string_text(bytes).is_some())
}

struct EncodingInfo {
    json: J,
    sha256: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(text: &str) -> Vec<u32> {
        glyph_name_to_unicode(text).into_iter().map(u32::from).collect()
    }

    #[test]
    fn glyph_names_map_like_the_adobe_glyph_list() {
        assert_eq!(chars("A"), vec![0x41]);
        assert_eq!(chars("space"), vec![0x20]);
        assert_eq!(chars("A.swash"), vec![0x41]);
        assert_eq!(chars("f_i"), vec![0x66, 0x69]);
        assert_eq!(chars("uni00410042"), vec![0x41, 0x42]);
        assert_eq!(chars("uni0041004"), Vec::<u32>::new());
        assert_eq!(chars("uniD800"), Vec::<u32>::new());
        assert_eq!(chars("u1F600"), vec![0x1F600]);
        assert_eq!(chars("u0041"), vec![0x41]);
        assert_eq!(chars("u00411"), vec![0x411]);
        assert_eq!(chars("nosuchglyph"), Vec::<u32>::new());
        assert_eq!(chars("uni00e9"), Vec::<u32>::new());
    }

    #[test]
    fn subset_prefixes_come_off_only_when_they_are_six_capitals() {
        assert_eq!(effective_base_font("/ABCDEF+Arial").unwrap(), "Arial");
        assert_eq!(effective_base_font("/ABCDEf+Arial").unwrap(), "ABCDEf+Arial");
        assert_eq!(effective_base_font("/ABCDE+Arial").unwrap(), "ABCDE+Arial");
        assert_eq!(effective_base_font("/ABCDEF+").unwrap(), "ABCDEF+");
        assert!(effective_base_font("/ÀBCDEF+Arial").is_err());
    }

    #[test]
    fn the_standard_encodings_have_the_expected_extent() {
        assert_eq!(named_encoding("/WinAnsiEncoding").unwrap().len(), 0x100 - 0x20 - 5);
        assert_eq!(named_encoding("/MacRomanEncoding").unwrap().len(), 0x100 - 0x20);
        assert_eq!(named_encoding("/StandardEncoding").unwrap().len(), 0x5F);
        assert!(named_encoding("/Identity-H").is_none());
    }
}
