//! Reading PDF values the way the inspection reports them: strings as pypdf
//! types them, object identities, the canonical "describe this value" form and
//! the semantic hash used to recognise a resource after an edit.

use std::io::Cursor;

use super::data::encodings::PDF_DOC;
use super::filters;
use super::pdf::{reject, Dict, Obj, PResult, Pdf, Reject};
use super::pyjson::{normalized_number, J};

pub fn sha256_hex(data: &[u8]) -> String {
    crate::sha256_reader(&mut Cursor::new(data)).expect("hashing memory cannot fail")
}

/// `Some(text)` when pypdf would make a `TextStringObject` of these bytes,
/// `None` when it would leave a `ByteStringObject`.
pub fn string_text(bytes: &[u8]) -> Option<String> {
    fn utf16(bytes: &[u8], big_endian: bool) -> Option<String> {
        if bytes.len() % 2 != 0 {
            return None;
        }
        let units = bytes.chunks_exact(2).map(|pair| {
            if big_endian { u16::from_be_bytes([pair[0], pair[1]]) } else { u16::from_le_bytes([pair[0], pair[1]]) }
        });
        char::decode_utf16(units).collect::<Result<String, _>>().ok()
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return utf16(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return utf16(&bytes[2..], false);
    }
    if bytes.first() == Some(&0) {
        return utf16(bytes, true);
    }
    if bytes.get(1) == Some(&0) {
        return utf16(bytes, false);
    }
    let mut text = String::with_capacity(bytes.len());
    for b in bytes {
        match PDF_DOC[*b as usize] {
            0 => return None,
            cp => text.push(char::from_u32(cp)?),
        }
    }
    Some(text)
}

/// `str(value)` for the spots where the old inspector used it on a name or a
/// string. Anything else would have produced text containing a memory address
/// or a Python repr, so those are refused.
pub fn as_text(value: &Obj) -> PResult<String> {
    match value {
        Obj::Name(name) => Ok(name.to_string()),
        Obj::Str(bytes) => string_text(bytes).ok_or(Reject("byte string used as text")),
        _ => reject!("value is not a name or text string"),
    }
}

/// The dictionary behind an object, a stream's dictionary included (pypdf's
/// `StreamObject` is a `DictionaryObject`).
pub fn as_dict(object: &Obj) -> Option<&Dict> {
    match object {
        Obj::Dict(dict) => Some(dict),
        Obj::Stream(stream) => Some(&stream.dict),
        _ => None,
    }
}

pub struct Ctx<'a> {
    pub pdf: &'a Pdf,
    /// Finished font inspections by font identity.
    pub fonts: std::cell::RefCell<std::collections::HashMap<String, J>>,
}

impl<'a> Ctx<'a> {
    pub fn resolve(&self, value: &Obj) -> PResult<Obj> {
        self.pdf.resolve(value)
    }

    /// `dictionary[key]`: resolved, and an error when missing.
    pub fn item(&self, dict: &Dict, key: &str) -> PResult<Obj> {
        match dict.get(key) {
            Some(value) => self.resolve(value),
            None => reject!("missing key"),
        }
    }

    /// `object_id` of the old inspector.
    pub fn object_id(&self, value: &Obj) -> String {
        match value {
            Obj::Ref(num, generation) => format!("{num}:{generation}"),
            other => {
                let mut bytes = Vec::new();
                fingerprint(other, &mut bytes);
                format!("direct:{}", sha256_hex(&bytes))
            }
        }
    }

    /// Decoded bytes of a stream, limited like `get_data()` callers expect.
    pub fn stream_data(&self, object: &Obj) -> PResult<Vec<u8>> {
        match object {
            Obj::Stream(stream) => filters::decode_stream(self.pdf, stream),
            _ => reject!("stream expected"),
        }
    }

    /// `_canonical`: a self-describing, bounded rendering of a value, with every
    /// reference followed and named.
    pub fn canonical(&self, value: &Obj, depth: usize) -> PResult<J> {
        if depth > 16 {
            reject!("value nests too deep");
        }
        if let Obj::Ref(..) = value {
            let target = self.resolve(value)?;
            return Ok(J::obj([
                ("ref", J::Str(self.object_id(value))),
                ("value", self.canonical(&target, depth + 1)?),
            ]));
        }
        match value {
            Obj::Array(items) => Ok(J::Arr(items.iter().map(|item| self.canonical(item, depth + 1)).collect::<PResult<_>>()?)),
            Obj::Dict(_) | Obj::Stream(_) => {
                let dict = as_dict(value).expect("checked");
                let mut map = std::collections::BTreeMap::new();
                for (key, item) in dict.iter() {
                    map.insert(key.to_string(), self.canonical(item, depth + 1)?);
                }
                Ok(J::Obj(map))
            }
            Obj::Str(bytes) => Ok(match string_text(bytes) {
                Some(text) => J::Str(text),
                None => byte_summary(bytes),
            }),
            Obj::Name(name) => Ok(J::Str(name.to_string())),
            Obj::Int(n) => Ok(J::Int(*n)),
            Obj::Real(x) => Ok(J::Float(*x)),
            // A boolean or a null makes the whole inspection unavailable.
            _ => reject!("value cannot be described"),
        }
    }

    /// `semantic_value`: references resolved, streams reduced to their decoded
    /// bytes, strings, numbers and names as plain JSON.
    pub fn semantic(&self, value: &Obj, page_self: Option<(u32, u16)>) -> PResult<J> {
        self.semantic_inner(value, &mut Vec::new(), 0, page_self)
    }

    fn semantic_inner(&self, value: &Obj, active: &mut Vec<(u32, u16)>, depth: usize, page_self: Option<(u32, u16)>) -> PResult<J> {
        if depth > 32 {
            reject!("resource nesting exceeds the proof boundary");
        }
        match value {
            Obj::Ref(num, generation) => {
                let key = (*num, *generation);
                if page_self == Some(key) {
                    return Ok(J::obj([("samePage", J::Bool(true))]));
                }
                if active.contains(&key) {
                    reject!("cyclic resource dependency");
                }
                let target = self.pdf.load(*num, *generation)?;
                active.push(key);
                let result = self.semantic_inner(&target, active, depth + 1, page_self);
                active.pop();
                result
            }
            Obj::Null => Ok(J::Null),
            Obj::Bool(b) => Ok(J::Bool(*b)),
            Obj::Stream(stream) => {
                let data = filters::decode_stream(self.pdf, stream)?;
                if data.len() > 64 * 1024 * 1024 {
                    reject!("unbounded decoded stream");
                }
                let mut map = std::collections::BTreeMap::new();
                for (key, item) in stream.dict.iter() {
                    if matches!(key, "/Length" | "/Filter" | "/DecodeParms") {
                        continue;
                    }
                    map.insert(key.to_string(), self.semantic_inner(item, active, depth + 1, page_self)?);
                }
                Ok(J::obj([
                    ("dictionary", J::Obj(map)),
                    ("decodedBytes", J::Int(data.len() as i64)),
                    ("decodedSha256", J::Str(sha256_hex(&data))),
                ]))
            }
            Obj::Dict(dict) => {
                let mut map = std::collections::BTreeMap::new();
                for (key, item) in dict.iter() {
                    map.insert(key.to_string(), self.semantic_inner(item, active, depth + 1, page_self)?);
                }
                Ok(J::Obj(map))
            }
            Obj::Array(items) => {
                Ok(J::Arr(items.iter().map(|item| self.semantic_inner(item, active, depth + 1, page_self)).collect::<PResult<_>>()?))
            }
            Obj::Str(bytes) => Ok(match string_text(bytes) {
                Some(text) => J::Str(text),
                None => byte_summary(bytes),
            }),
            Obj::Name(name) => Ok(J::Str(name.to_string())),
            Obj::Int(n) => Ok(J::Int(*n)),
            // PDF integer/real spelling is not a semantic difference.
            Obj::Real(x) if x.is_finite() => Ok(normalized_number(*x)),
            Obj::Real(_) => reject!("unsupported resource value"),
        }
    }

    pub fn semantic_hash(&self, value: &Obj, page_self: Option<(u32, u16)>) -> PResult<String> {
        Ok(sha256_hex(self.semantic(value, page_self)?.dump().as_bytes()))
    }
}

pub fn byte_summary(bytes: &[u8]) -> J {
    J::obj([("bytes", J::Int(bytes.len() as i64)), ("sha256", J::Str(sha256_hex(bytes)))])
}

/// A canonical byte rendering of a direct object, for identities only.
fn fingerprint(value: &Obj, out: &mut Vec<u8>) {
    match value {
        Obj::Null => out.push(b'n'),
        Obj::Bool(b) => out.extend_from_slice(if *b { b"T" } else { b"F" }),
        Obj::Int(n) => out.extend_from_slice(format!("i{n};").as_bytes()),
        Obj::Real(x) => out.extend_from_slice(format!("r{:016x};", x.to_bits()).as_bytes()),
        Obj::Str(bytes) => {
            out.extend_from_slice(format!("s{}:", bytes.len()).as_bytes());
            out.extend_from_slice(bytes);
        }
        Obj::Name(name) => out.extend_from_slice(format!("N{}:{name}", name.len()).as_bytes()),
        Obj::Ref(num, generation) => out.extend_from_slice(format!("R{num} {generation};").as_bytes()),
        Obj::Array(items) => {
            out.push(b'[');
            for item in items.iter() {
                fingerprint(item, out);
            }
            out.push(b']');
        }
        Obj::Dict(dict) => fingerprint_dict(dict, out),
        Obj::Stream(stream) => {
            out.push(b'S');
            fingerprint_dict(&stream.dict, out);
        }
    }
}

fn fingerprint_dict(dict: &Dict, out: &mut Vec<u8>) {
    let mut entries: Vec<_> = dict.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    out.push(b'<');
    for (key, value) in entries {
        out.extend_from_slice(format!("{}:{key}", key.len()).as_bytes());
        fingerprint(value, out);
    }
    out.push(b'>');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_are_typed_like_pypdf() {
        assert_eq!(string_text(b"Hello"), Some("Hello".into()));
        assert_eq!(string_text(b""), Some(String::new()));
        assert_eq!(string_text(&[0xFE, 0xFF, 0, 65]), Some("A".into()));
        assert_eq!(string_text(&[0xFE, 0xFF]), Some(String::new()));
        assert_eq!(string_text(&[0xFF, 0xFE, 65, 0]), Some("A".into()));
        assert_eq!(string_text(&[0, 65]), Some("A".into()));
        assert_eq!(string_text(&[65, 0]), Some("A".into()));
        assert_eq!(string_text(&[0xFE, 0xFF, 0]), None);
        assert_eq!(string_text(&[0xFE, 0xFF, 0xD8, 0]), None);
        assert_eq!(string_text(&[0x7F]), None);
        assert_eq!(string_text(&[0x80]), Some("\u{2022}".into()));
    }
}
