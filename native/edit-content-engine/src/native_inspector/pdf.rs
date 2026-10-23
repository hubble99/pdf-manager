//! A small, strict PDF reader for the resource inspector.
//!
//! It reads only what the inspector needs (objects, streams, the page tree) and
//! it is deliberately stricter than the reader it replaces (pypdf with
//! `strict=True`): it never repairs a damaged file. Anything unusual (a cross
//! reference entry that does not point at its object, a duplicate dictionary key,
//! a stream whose `/Length` is wrong, a reference to a missing object, trailing
//! junk, an unknown cross-reference entry type) is a `Reject`, and a rejected
//! file is "unsupported". Being stricter than the old reader is always safe: it
//! can only turn "supported" into "unsupported", never the other way round.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use super::filters;

pub const MAX_FILE_BYTES: usize = 1 << 30;
const MAX_DEPTH: usize = 64;
const MAX_REF_CHAIN: usize = 16;
const MAX_XREF_SECTIONS: usize = 256;
const MAX_OBJECT_NUMBER: u64 = 8_000_000;

/// Why a file is refused. Only for tests and logs; never shown to a user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reject(pub &'static str);

pub type PResult<T> = Result<T, Reject>;

macro_rules! reject {
    ($why:expr) => {
        return Err($crate::native_inspector::pdf::Reject($why))
    };
}
pub(crate) use reject;

#[derive(Debug, Clone, PartialEq)]
pub enum Obj {
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    /// The raw bytes of a PDF string.
    Str(Rc<Vec<u8>>),
    /// A name with its leading slash, `#xx` escapes resolved (like pypdf).
    Name(Rc<str>),
    Array(Rc<Vec<Obj>>),
    Dict(Rc<Dict>),
    Stream(Rc<Stream>),
    Ref(u32, u16),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Dict {
    pub entries: Vec<(Rc<str>, Obj)>,
}

impl Dict {
    pub fn get(&self, key: &str) -> Option<&Obj> {
        self.entries.iter().find(|(k, _)| &**k == key).map(|(_, v)| v)
    }

    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| &**k)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &Obj)> {
        self.entries.iter().map(|(k, v)| (&**k, v))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stream {
    pub dict: Dict,
    /// The stored (still encoded) bytes: `data[start..start + len]` of the file,
    /// or of the object stream the stream came from (never: streams are not
    /// allowed inside object streams).
    pub start: usize,
    pub len: usize,
}

#[derive(Debug, Clone, Copy)]
enum Entry {
    Free,
    InUse { offset: usize, generation: u16 },
    Compressed { stream: u32, index: u32 },
}

struct ObjStm {
    /// (object number, offset relative to /First), in header order.
    index: Vec<(u32, usize)>,
    first: usize,
    data: Vec<u8>,
}

pub struct Pdf {
    pub data: Vec<u8>,
    entries: HashMap<u32, Entry>,
    pub trailer: Dict,
    cache: RefCell<HashMap<u32, Obj>>,
    objstms: RefCell<HashMap<u32, Rc<ObjStm>>>,
    loading: RefCell<HashSet<u32>>,
}

// ------------------------------------------------------------------ lexing

/// White space as pypdf skips it between tokens. NUL, VT and FF are left out on
/// purpose: pypdf treats them differently in different places, so a file that
/// uses them is not trusted.
pub fn is_ws(b: u8) -> bool {
    matches!(b, 9 | 10 | 13 | 32)
}

pub fn is_delim(b: u8) -> bool {
    matches!(b, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

pub fn is_regular(b: u8) -> bool {
    !is_ws(b) && !is_delim(b)
}

pub struct Lexer<'a> {
    pub data: &'a [u8],
    pub pos: usize,
}

impl<'a> Lexer<'a> {
    pub fn new(data: &'a [u8], pos: usize) -> Self {
        Self { data, pos }
    }

    pub fn peek(&self) -> Option<u8> {
        self.data.get(self.pos).copied()
    }

    pub fn at_end(&self) -> bool {
        self.pos >= self.data.len()
    }

    /// Skips white space and comments.
    pub fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if is_ws(b) {
                self.pos += 1;
            } else if b == b'%' {
                while let Some(c) = self.peek() {
                    if c == b'\n' || c == b'\r' {
                        break;
                    }
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    pub fn skip_plain_ws(&mut self) {
        while self.peek().is_some_and(is_ws) {
            self.pos += 1;
        }
    }

    pub fn starts_with(&self, word: &[u8]) -> bool {
        self.data[self.pos.min(self.data.len())..].starts_with(word)
    }

    /// True when `word` is next and ends at a delimiter, white space or the end.
    pub fn keyword(&self, word: &[u8]) -> bool {
        self.starts_with(word) && self.data.get(self.pos + word.len()).is_none_or(|b| !is_regular(*b))
    }

    pub fn eat_keyword(&mut self, word: &[u8]) -> bool {
        if self.keyword(word) {
            self.pos += word.len();
            true
        } else {
            false
        }
    }

    fn token(&mut self) -> &'a [u8] {
        let start = self.pos;
        while self.peek().is_some_and(is_regular) {
            self.pos += 1;
        }
        &self.data[start..self.pos]
    }

    fn unsigned_int(&mut self) -> Option<u64> {
        let start = self.pos;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.pos += 1;
        }
        if self.pos == start || self.pos - start > 18 {
            return None;
        }
        std::str::from_utf8(&self.data[start..self.pos]).ok()?.parse().ok()
    }

    pub fn parse_name(&mut self) -> PResult<Rc<str>> {
        if self.peek() != Some(b'/') {
            reject!("name expected");
        }
        self.pos += 1;
        let start = self.pos;
        while self.peek().is_some_and(is_regular) {
            self.pos += 1;
        }
        let raw = &self.data[start..self.pos];
        if raw.len() > 4096 || raw.iter().any(|b| matches!(b, 0 | 11 | 12)) {
            reject!("name too long or with a control character");
        }
        let mut bytes = Vec::with_capacity(raw.len() + 1);
        bytes.push(b'/');
        let mut i = 0;
        while i < raw.len() {
            if raw[i] == b'#' {
                if let Some(value) = raw.get(i + 1..i + 3).and_then(hex_pair) {
                    bytes.push(value);
                    i += 3;
                    continue;
                }
            }
            bytes.push(raw[i]);
            i += 1;
        }
        match String::from_utf8(bytes) {
            Ok(text) => Ok(Rc::from(text)),
            Err(_) => reject!("name is not UTF-8"),
        }
    }

    fn parse_literal_string(&mut self) -> PResult<Vec<u8>> {
        // Mirrors pypdf's reader, including how it keeps an unknown escape.
        self.pos += 1;
        let mut depth = 1usize;
        let mut out = Vec::new();
        loop {
            let Some(b) = self.peek() else { reject!("string not closed") };
            self.pos += 1;
            match b {
                b'(' => {
                    depth += 1;
                    out.push(b);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(out);
                    }
                    out.push(b);
                }
                b'\\' => {
                    let Some(e) = self.peek() else { reject!("string not closed") };
                    self.pos += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'(' | b')' | b'/' | b'\\' | b' ' | b'%' | b'<' | b'>' | b'[' | b']' | b'#' | b'_' | b'&'
                        | b'$' => out.push(e),
                        b'0'..=b'7' => {
                            let first = self.pos - 1;
                            let mut value = u32::from(e - b'0');
                            let mut digits = 1;
                            while digits < 3 && self.peek().is_some_and(|c| (b'0'..=b'7').contains(&c)) {
                                value = value * 8 + u32::from(self.peek().unwrap() - b'0');
                                self.pos += 1;
                                digits += 1;
                            }
                            if value > 255 {
                                out.push(b'\\');
                                self.pos = first;
                            } else {
                                out.push(value as u8);
                            }
                        }
                        b'\n' | b'\r' => {
                            // pypdf swallows one more CR or LF, whichever it is.
                            if matches!(self.peek(), Some(b'\n' | b'\r')) {
                                self.pos += 1;
                            }
                        }
                        other => {
                            out.push(b'\\');
                            out.push(other);
                        }
                    }
                }
                other => out.push(other),
            }
        }
    }

    fn parse_hex_string(&mut self) -> PResult<Vec<u8>> {
        self.pos += 1;
        let mut digits = Vec::new();
        loop {
            let Some(b) = self.peek() else { reject!("hex string not closed") };
            self.pos += 1;
            if b == b'>' {
                break;
            }
            if is_ws(b) {
                continue;
            }
            if !b.is_ascii_hexdigit() {
                reject!("bad hex string");
            }
            digits.push(b);
        }
        if digits.len() % 2 == 1 {
            digits.push(b'0');
        }
        Ok(digits.chunks(2).map(|pair| hex_pair(pair).unwrap()).collect())
    }

    fn parse_number(&mut self) -> PResult<Obj> {
        let token = self.token();
        let text = std::str::from_utf8(token).map_err(|_| Reject("bad number"))?;
        if !token.iter().all(|b| matches!(b, b'+' | b'-' | b'.' | b'0'..=b'9')) {
            reject!("bad number");
        }
        if token.contains(&b'.') {
            match text.parse::<f64>() {
                Ok(value) if value.is_finite() => Ok(Obj::Real(value)),
                _ => reject!("bad real"),
            }
        } else {
            match text.parse::<i64>() {
                Ok(value) => Ok(Obj::Int(value)),
                Err(_) => reject!("bad integer"),
            }
        }
    }

    pub fn parse_object(&mut self, depth: usize) -> PResult<Obj> {
        if depth > MAX_DEPTH {
            reject!("nesting too deep");
        }
        self.skip_ws();
        let Some(b) = self.peek() else { reject!("unexpected end") };
        match b {
            b'/' => Ok(Obj::Name(self.parse_name()?)),
            b'(' => Ok(Obj::Str(Rc::new(self.parse_literal_string()?))),
            b'<' => {
                if self.data.get(self.pos + 1) == Some(&b'<') {
                    self.parse_dict(depth)
                } else {
                    Ok(Obj::Str(Rc::new(self.parse_hex_string()?)))
                }
            }
            b'[' => {
                self.pos += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_ws();
                    match self.peek() {
                        None => reject!("array not closed"),
                        Some(b']') => {
                            self.pos += 1;
                            return Ok(Obj::Array(Rc::new(items)));
                        }
                        _ => items.push(self.parse_object(depth + 1)?),
                    }
                    if items.len() > 4_000_000 {
                        reject!("array too long");
                    }
                }
            }
            b't' if self.eat_keyword(b"true") => Ok(Obj::Bool(true)),
            b'f' if self.eat_keyword(b"false") => Ok(Obj::Bool(false)),
            b'n' if self.eat_keyword(b"null") => Ok(Obj::Null),
            b'0'..=b'9' | b'+' | b'-' | b'.' => {
                // `12 0 R`?
                if b.is_ascii_digit() {
                    let save = self.pos;
                    if let Some(num) = self.unsigned_int() {
                        if self.peek().is_some_and(is_ws) {
                            self.skip_plain_ws();
                            if let Some(gen) = self.unsigned_int() {
                                if self.peek().is_some_and(is_ws) {
                                    self.skip_plain_ws();
                                    if self.peek() == Some(b'R') && self.data.get(self.pos + 1).is_none_or(|c| !is_regular(*c)) {
                                        self.pos += 1;
                                        if num > MAX_OBJECT_NUMBER || gen > 65535 {
                                            reject!("reference out of range");
                                        }
                                        return Ok(Obj::Ref(num as u32, gen as u16));
                                    }
                                }
                            }
                        }
                    }
                    self.pos = save;
                }
                self.parse_number()
            }
            _ => reject!("unexpected token"),
        }
    }

    fn parse_dict(&mut self, depth: usize) -> PResult<Obj> {
        self.pos += 2;
        let mut dict = Dict::default();
        loop {
            self.skip_ws();
            if self.starts_with(b">>") {
                self.pos += 2;
                return Ok(Obj::Dict(Rc::new(dict)));
            }
            let key = self.parse_name()?;
            if dict.contains(&key) {
                reject!("duplicate dictionary key");
            }
            let value = self.parse_object(depth + 1)?;
            dict.entries.push((key, value));
            if dict.entries.len() > 1_000_000 {
                reject!("dictionary too large");
            }
        }
    }
}

fn hex_pair(pair: &[u8]) -> Option<u8> {
    let digit = |b: u8| (b as char).to_digit(16);
    Some((digit(*pair.first()?)? * 16 + digit(*pair.get(1)?)?) as u8)
}

// ------------------------------------------------------------------ the file

impl Pdf {
    pub fn open(data: Vec<u8>) -> PResult<Pdf> {
        if data.len() > MAX_FILE_BYTES {
            reject!("file too large");
        }
        if !data.starts_with(b"%PDF-") {
            reject!("no header");
        }
        let startxref = find_startxref(&data)?;
        let mut pdf = Pdf {
            data,
            entries: HashMap::new(),
            trailer: Dict::default(),
            cache: RefCell::new(HashMap::new()),
            objstms: RefCell::new(HashMap::new()),
            loading: RefCell::new(HashSet::new()),
        };
        pdf.read_xref_chain(startxref)?;
        if pdf.trailer.contains("/Encrypt") {
            reject!("encrypted");
        }
        if !pdf.trailer.contains("/Root") {
            reject!("no /Root");
        }
        Ok(pdf)
    }

    fn read_xref_chain(&mut self, first: usize) -> PResult<()> {
        let mut visited = HashSet::new();
        let mut next = Some(first);
        let mut trailer = Dict::default();
        let mut sections = 0;
        while let Some(offset) = next {
            if !visited.insert(offset) {
                reject!("xref chain loops");
            }
            sections += 1;
            if sections > MAX_XREF_SECTIONS {
                reject!("too many xref sections");
            }
            if offset >= self.data.len() {
                reject!("xref offset outside the file");
            }
            let section = if self.data[offset..].starts_with(b"xref") {
                self.read_xref_table(offset)?
            } else {
                self.read_xref_stream(offset)?
            };
            for (key, value) in section.entries.iter() {
                if !trailer.contains(key) {
                    trailer.entries.push((key.clone(), value.clone()));
                }
            }
            next = match section.get("/Prev") {
                None => None,
                Some(Obj::Int(value)) if *value > 0 => Some(*value as usize),
                _ => reject!("bad /Prev"),
            };
        }
        self.trailer = trailer;
        Ok(())
    }

    fn put(&mut self, num: u64, entry: Entry) -> PResult<()> {
        if num > MAX_OBJECT_NUMBER {
            reject!("object number out of range");
        }
        self.entries.entry(num as u32).or_insert(entry);
        Ok(())
    }

    /// A classic table; returns its trailer dictionary.
    fn read_xref_table(&mut self, offset: usize) -> PResult<Dict> {
        let data = std::mem::take(&mut self.data);
        let result = (|| -> PResult<Dict> {
            let mut lx = Lexer::new(&data, offset + 4);
            if !lx.peek().is_some_and(is_ws) {
                reject!("xref keyword");
            }
            lx.skip_plain_ws();
            let mut staged: Vec<(u64, Entry)> = Vec::new();
            loop {
                lx.skip_plain_ws();
                if lx.keyword(b"trailer") {
                    lx.pos += 7;
                    break;
                }
                let first = lx.unsigned_int().ok_or(Reject("xref subsection"))?;
                if lx.peek() != Some(b' ') {
                    reject!("xref subsection");
                }
                lx.pos += 1;
                let count = lx.unsigned_int().ok_or(Reject("xref subsection"))?;
                if count > MAX_OBJECT_NUMBER {
                    reject!("xref subsection too large");
                }
                lx.skip_plain_ws();
                for i in 0..count {
                    let line = data.get(lx.pos..lx.pos + 20).ok_or(Reject("xref entry"))?;
                    let well_formed = line[..10].iter().all(u8::is_ascii_digit)
                        && line[10] == b' '
                        && line[11..16].iter().all(u8::is_ascii_digit)
                        && line[16] == b' '
                        && matches!(line[17], b'n' | b'f')
                        && matches!(&line[18..20], b" \n" | b" \r" | b"\r\n");
                    if !well_formed {
                        reject!("xref entry");
                    }
                    let value: u64 = std::str::from_utf8(&line[..10]).unwrap().parse().unwrap();
                    let generation: u64 = std::str::from_utf8(&line[11..16]).unwrap().parse().unwrap();
                    let entry = if line[17] == b'n' {
                        // An entry pointing nowhere is only a problem if something
                        // refers to the object; loading it will fail then.
                        if generation > 65535 {
                            reject!("xref entry");
                        }
                        Entry::InUse { offset: value as usize, generation: generation as u16 }
                    } else {
                        Entry::Free
                    };
                    staged.push((first + i, entry));
                    lx.pos += 20;
                }
            }
            let trailer = match lx.parse_object(0)? {
                Obj::Dict(dict) => (*dict).clone(),
                _ => reject!("trailer"),
            };
            for (num, entry) in staged {
                if num > MAX_OBJECT_NUMBER {
                    reject!("object number out of range");
                }
                self.entries.entry(num as u32).or_insert(entry);
            }
            Ok(trailer)
        })();
        self.data = data;
        let trailer = result?;
        // A hybrid file's extra entries sit in a stream the table points at.
        if let Some(stm) = trailer.get("/XRefStm") {
            let Obj::Int(position) = stm else { reject!("bad /XRefStm") };
            if *position <= 0 || *position as usize >= self.data.len() {
                reject!("bad /XRefStm");
            }
            self.read_xref_stream(*position as usize)?;
        }
        Ok(trailer)
    }

    /// A cross-reference stream; returns its dictionary (the trailer).
    fn read_xref_stream(&mut self, offset: usize) -> PResult<Dict> {
        let (num, _gen, object) = {
            let mut lx = Lexer::new(&self.data, offset);
            let (num, generation) = read_object_header(&mut lx)?;
            let object = parse_indirect_body(self, &mut lx, num, true)?;
            (num, generation, object)
        };
        let Obj::Stream(stream) = object else { reject!("xref stream expected") };
        let _ = num;
        let dict = &stream.dict;
        if dict.get("/Type") != Some(&Obj::Name(Rc::from("/XRef"))) {
            reject!("not an xref stream");
        }
        let size = match dict.get("/Size") {
            Some(Obj::Int(value)) if *value >= 0 => *value as u64,
            _ => reject!("xref stream /Size"),
        };
        let widths: Vec<usize> = match dict.get("/W") {
            Some(Obj::Array(items)) if items.len() == 3 => items
                .iter()
                .map(|w| match w {
                    Obj::Int(value) if (0..=8).contains(value) => Ok(*value as usize),
                    _ => Err(Reject("xref stream /W")),
                })
                .collect::<PResult<_>>()?,
            _ => reject!("xref stream /W"),
        };
        let index: Vec<u64> = match dict.get("/Index") {
            None => vec![0, size],
            Some(Obj::Array(items)) if items.len() % 2 == 0 => items
                .iter()
                .map(|v| match v {
                    Obj::Int(value) if *value >= 0 => Ok(*value as u64),
                    _ => Err(Reject("xref stream /Index")),
                })
                .collect::<PResult<_>>()?,
            _ => reject!("xref stream /Index"),
        };
        let entry_size: usize = widths.iter().sum();
        if entry_size == 0 {
            reject!("xref stream without entry data");
        }
        let body = filters::decode_stream(self, &stream)?;
        let mut cursor = 0usize;
        let field = |cursor: &mut usize, width: usize, default: u64| -> PResult<u64> {
            if width == 0 {
                return Ok(default);
            }
            let bytes = body.get(*cursor..*cursor + width).ok_or(Reject("xref stream too short"))?;
            *cursor += width;
            Ok(bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b)))
        };
        for pair in index.chunks(2) {
            for i in 0..pair[1] {
                let kind = field(&mut cursor, widths[0], 1)?;
                let second = field(&mut cursor, widths[1], 0)?;
                let third = field(&mut cursor, widths[2], 0)?;
                let entry = match kind {
                    0 => Entry::Free,
                    1 => {
                        if third > 65535 {
                            reject!("xref stream entry");
                        }
                        Entry::InUse { offset: second as usize, generation: third as u16 }
                    }
                    2 => {
                        if second == 0 || second > MAX_OBJECT_NUMBER || third > 1_000_000 {
                            reject!("xref stream entry");
                        }
                        Entry::Compressed { stream: second as u32, index: third as u32 }
                    }
                    _ => reject!("unknown xref entry type"),
                };
                self.put(pair[0] + i, entry)?;
            }
        }
        if cursor != body.len() {
            reject!("xref stream has extra data");
        }
        Ok(stream.dict.clone())
    }

    /// The object behind `num gen`, or a rejection when it cannot be read
    /// exactly as the cross-reference data says.
    pub fn load(&self, num: u32, generation: u16) -> PResult<Obj> {
        if let Some(found) = self.cache.borrow().get(&num) {
            return self.check_generation(num, generation, found.clone());
        }
        let entry = *self.entries.get(&num).ok_or(Reject("reference to an unknown object"))?;
        if !self.loading.borrow_mut().insert(num) {
            reject!("object depends on itself");
        }
        let result = self.load_entry(num, generation, entry);
        self.loading.borrow_mut().remove(&num);
        let object = result?;
        self.cache.borrow_mut().insert(num, object.clone());
        Ok(object)
    }

    fn check_generation(&self, num: u32, generation: u16, object: Obj) -> PResult<Obj> {
        match self.entries.get(&num) {
            Some(Entry::InUse { generation: g, .. }) if *g == generation => Ok(object),
            Some(Entry::Compressed { .. }) if generation == 0 => Ok(object),
            _ => reject!("generation does not match"),
        }
    }

    fn load_entry(&self, num: u32, generation: u16, entry: Entry) -> PResult<Obj> {
        match entry {
            Entry::Free => reject!("reference to a free object"),
            Entry::InUse { offset, generation: g } => {
                if g != generation {
                    reject!("generation does not match");
                }
                let mut lx = Lexer::new(&self.data, offset);
                let (found_num, found_gen) = read_object_header(&mut lx)?;
                if found_num != u64::from(num) || found_gen != u64::from(generation) {
                    reject!("xref entry does not point at its object");
                }
                parse_indirect_body(self, &mut lx, found_num, false)
            }
            Entry::Compressed { stream, index } => {
                if generation != 0 {
                    reject!("generation does not match");
                }
                let objstm = self.object_stream(stream)?;
                let (found, offset) = *objstm.index.get(index as usize).ok_or(Reject("object stream index"))?;
                if found != num {
                    reject!("object stream entry does not match");
                }
                let start = objstm.first.checked_add(offset).ok_or(Reject("object stream offset"))?;
                if start >= objstm.data.len() {
                    reject!("object stream offset");
                }
                let mut lx = Lexer::new(&objstm.data, start);
                let object = lx.parse_object(0)?;
                if matches!(object, Obj::Stream(_)) {
                    reject!("stream inside an object stream");
                }
                Ok(object)
            }
        }
    }

    fn object_stream(&self, stream_num: u32) -> PResult<Rc<ObjStm>> {
        if let Some(found) = self.objstms.borrow().get(&stream_num) {
            return Ok(Rc::clone(found));
        }
        match self.entries.get(&stream_num) {
            Some(Entry::InUse { generation, .. }) => {
                let generation = *generation;
                let Obj::Stream(stream) = self.load(stream_num, generation)? else { reject!("object stream expected") };
                if stream.dict.get("/Type") != Some(&Obj::Name(Rc::from("/ObjStm"))) {
                    reject!("not an object stream");
                }
                let n = match stream.dict.get("/N") {
                    Some(Obj::Int(value)) if *value >= 0 => *value as usize,
                    _ => reject!("object stream /N"),
                };
                let first = match stream.dict.get("/First") {
                    Some(Obj::Int(value)) if *value >= 0 => *value as usize,
                    _ => reject!("object stream /First"),
                };
                let data = filters::decode_stream(self, &stream)?;
                if n > data.len() / 3 || first > data.len() {
                    reject!("object stream header");
                }
                let mut lx = Lexer::new(&data[..first], 0);
                let mut index = Vec::with_capacity(n);
                for _ in 0..n {
                    lx.skip_ws();
                    let num = lx.unsigned_int().ok_or(Reject("object stream header"))?;
                    lx.skip_ws();
                    let offset = lx.unsigned_int().ok_or(Reject("object stream header"))?;
                    if num > MAX_OBJECT_NUMBER {
                        reject!("object stream header");
                    }
                    index.push((num as u32, offset as usize));
                }
                lx.skip_ws();
                if !lx.at_end() {
                    reject!("object stream header");
                }
                let parsed = Rc::new(ObjStm { index, first, data });
                self.objstms.borrow_mut().insert(stream_num, Rc::clone(&parsed));
                Ok(parsed)
            }
            _ => reject!("object stream is not a plain object"),
        }
    }

    /// Follows references (not into containers) like pypdf's `get_object()`.
    pub fn resolve(&self, object: &Obj) -> PResult<Obj> {
        let mut current = object.clone();
        for _ in 0..MAX_REF_CHAIN {
            match current {
                Obj::Ref(num, generation) => current = self.load(num, generation)?,
                other => return Ok(other),
            }
        }
        reject!("reference chain too long")
    }

    pub fn stream_bytes(&self, stream: &Stream) -> &[u8] {
        &self.data[stream.start..stream.start + stream.len]
    }
}

fn find_startxref(data: &[u8]) -> PResult<usize> {
    let tail_start = data.len().saturating_sub(1100);
    let tail = &data[tail_start..];
    let eof = rfind(tail, b"%%EOF").ok_or(Reject("no %%EOF"))?;
    if !tail[eof + 5..].iter().all(|b| is_ws(*b)) {
        reject!("data after %%EOF");
    }
    let marker = rfind(&tail[..eof], b"startxref").ok_or(Reject("no startxref"))?;
    let mut lx = Lexer::new(&tail[..eof], marker + 9);
    if !lx.peek().is_some_and(is_ws) {
        reject!("startxref");
    }
    lx.skip_plain_ws();
    let value = lx.unsigned_int().ok_or(Reject("startxref"))?;
    lx.skip_plain_ws();
    if !lx.at_end() {
        reject!("startxref");
    }
    if value == 0 || value as usize >= data.len() {
        reject!("startxref offset");
    }
    Ok(value as usize)
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).rev().find(|&i| &haystack[i..i + needle.len()] == needle)
}

/// `12 0 obj` at the cursor; any white space may separate the three words.
fn read_object_header(lx: &mut Lexer<'_>) -> PResult<(u64, u64)> {
    lx.skip_plain_ws();
    let num = lx.unsigned_int().ok_or(Reject("object header"))?;
    if !lx.peek().is_some_and(is_ws) {
        reject!("object header");
    }
    lx.skip_plain_ws();
    let generation = lx.unsigned_int().ok_or(Reject("object header"))?;
    if !lx.peek().is_some_and(is_ws) {
        reject!("object header");
    }
    lx.skip_plain_ws();
    if !lx.keyword(b"obj") {
        reject!("object header");
    }
    lx.pos += 3;
    Ok((num, generation))
}

/// The object after `N G obj`, a stream when `stream` follows, then `endobj`.
fn parse_indirect_body(pdf: &Pdf, lx: &mut Lexer<'_>, _num: u64, _is_xref: bool) -> PResult<Obj> {
    let object = lx.parse_object(0)?;
    lx.skip_ws();
    let result = if let (Obj::Dict(dict), true) = (&object, lx.keyword(b"stream")) {
        lx.pos += 6;
        match (lx.peek(), lx.data.get(lx.pos + 1)) {
            (Some(b'\n'), _) => lx.pos += 1,
            (Some(b'\r'), Some(b'\n')) => lx.pos += 2,
            _ => reject!("stream keyword must end the line"),
        }
        let length = match dict.get("/Length") {
            Some(Obj::Int(value)) if *value >= 0 => *value as usize,
            Some(Obj::Ref(n, g)) => match pdf.load(*n, *g)? {
                Obj::Int(value) if value >= 0 => value as usize,
                _ => reject!("bad /Length"),
            },
            _ => reject!("stream without /Length"),
        };
        if length > 75_000_000 {
            reject!("stream /Length too large");
        }
        let start = lx.pos;
        let end = start.checked_add(length).ok_or(Reject("bad /Length"))?;
        if end > lx.data.len() {
            reject!("stream /Length beyond the data");
        }
        lx.pos = end;
        lx.skip_plain_ws();
        if !lx.keyword(b"endstream") {
            reject!("stream /Length does not end at endstream");
        }
        lx.pos += 9;
        Obj::Stream(Rc::new(Stream { dict: (**dict).clone(), start, len: length }))
    } else {
        object
    };
    lx.skip_ws();
    if !lx.keyword(b"endobj") {
        reject!("missing endobj");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> PResult<Obj> {
        Lexer::new(text.as_bytes(), 0).parse_object(0)
    }

    #[test]
    fn objects_parse_like_pypdf() {
        assert_eq!(parse("12"), Ok(Obj::Int(12)));
        assert_eq!(parse("-3.5"), Ok(Obj::Real(-3.5)));
        assert_eq!(parse("5 0 R"), Ok(Obj::Ref(5, 0)));
        assert_eq!(parse("/A#20B"), Ok(Obj::Name(Rc::from("/A B"))));
        assert_eq!(parse("(a\\(b\\051\\q)"), Ok(Obj::Str(Rc::new(b"a(b)\\q".to_vec()))));
        assert_eq!(parse("<48 65 6C6c6F>"), Ok(Obj::Str(Rc::new(b"Hello".to_vec()))));
        assert_eq!(parse("<4>"), Ok(Obj::Str(Rc::new(vec![0x40]))));
        assert!(matches!(parse("[1 2 R /N (s) true null]"), Ok(Obj::Array(items)) if items.len() == 5));
        assert!(parse("<</A 1 /A 2>>").is_err());
        assert!(parse("<</A 1").is_err());
        assert!(parse("1e5").is_err());
        assert!(parse("99999999999999999999").is_err());
    }

    #[test]
    fn dictionaries_keep_order_and_values() {
        let Ok(Obj::Dict(dict)) = parse("<< /Type /Page /Kids [1 0 R] /N 3 >>") else { panic!() };
        assert_eq!(dict.keys().collect::<Vec<_>>(), vec!["/Type", "/Kids", "/N"]);
        assert_eq!(dict.get("/N"), Some(&Obj::Int(3)));
    }
}
