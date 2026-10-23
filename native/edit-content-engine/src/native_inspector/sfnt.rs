//! Just enough of the sfnt (TrueType/OpenType) container to answer the two
//! questions the inspector asks of an embedded font program: which characters
//! does its character map cover, and is a given glyph provably empty.
//!
//! Anything the old reader (fontTools) would have failed on is a failure here
//! too (`None`), so a damaged or unusual font yields "unknown", never a guess.

use std::collections::{BTreeMap, BTreeSet, HashMap};

/// The preferences of `getBestCmap`.
const PREFERRED: [(u16, u16); 8] = [(3, 10), (0, 6), (0, 4), (3, 1), (0, 3), (0, 2), (0, 1), (0, 0)];
const MAX_MAPPINGS: u64 = 0x11_0000;

pub struct Sfnt<'a> {
    data: &'a [u8],
    tables: HashMap<[u8; 4], (usize, usize)>,
}

fn be16(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

fn be32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

impl<'a> Sfnt<'a> {
    /// Font number 0 of a collection, like the old reader asked for.
    pub fn parse(data: &'a [u8]) -> Option<Sfnt<'a>> {
        Self::parse_with(data, true)
    }

    /// A single font; a collection is refused (the old reader raised for it).
    pub fn parse_plain(data: &'a [u8]) -> Option<Sfnt<'a>> {
        Self::parse_with(data, false)
    }

    fn parse_with(data: &'a [u8], allow_collection: bool) -> Option<Sfnt<'a>> {
        let mut base = 0usize;
        if data.starts_with(b"ttcf") {
            if !allow_collection {
                return None;
            }
            let count = be32(data, 8)?;
            if count == 0 {
                return None;
            }
            base = be32(data, 12)? as usize;
        }
        let version = data.get(base..base + 4)?;
        if !matches!(version, [0, 1, 0, 0] | b"OTTO" | b"true") {
            return None;
        }
        let count = be16(data, base + 4)? as usize;
        data.get(base..base + 12)?;
        let mut tables = HashMap::new();
        for i in 0..count {
            let entry = base + 12 + i * 16;
            let tag: [u8; 4] = data.get(entry..entry + 4)?.try_into().ok()?;
            let offset = be32(data, entry + 8)? as usize;
            let length = be32(data, entry + 12)? as usize;
            tables.insert(tag, (offset, length));
        }
        Some(Sfnt { data, tables })
    }

    pub fn has(&self, tag: &[u8; 4]) -> bool {
        self.tables.contains_key(tag)
    }

    /// The length the table directory states, whatever the file really holds.
    pub fn directory_length(&self, tag: &[u8; 4]) -> Option<usize> {
        self.tables.get(tag).map(|&(_, length)| length)
    }

    /// Whether fontTools could name the glyphs: a CFF program names them itself,
    /// a TrueType font needs `maxp` (and, with a `post` table, `maxp` too).
    fn glyph_names_available(&self) -> bool {
        if self.has(b"CFF ") {
            return true;
        }
        let Some(maxp) = self.table(b"maxp") else { return false };
        match be16(maxp, 4) {
            Some(0) | None => return false,
            _ => {}
        }
        true
    }

    /// The table's bytes as a file read would return them (cut at the end of the data).
    pub fn table(&self, tag: &[u8; 4]) -> Option<&'a [u8]> {
        let &(offset, length) = self.tables.get(tag)?;
        let start = offset.min(self.data.len());
        let end = offset.saturating_add(length).min(self.data.len());
        Some(&self.data[start..end])
    }
}

/// `set(font.getBestCmap())`, or the union of all subtables when there is no
/// usable preferred one. `None` where fontTools would have raised or found
/// nothing.
pub fn cmap_codepoints(font: &[u8]) -> Option<BTreeSet<u32>> {
    let sfnt = Sfnt::parse(font)?;
    // Glyph names are needed to build the map.
    if !sfnt.glyph_names_available() {
        return None;
    }
    let table = sfnt.table(b"cmap")?;
    let mut cmap = Cmap::parse(table)?;
    for (platform, encoding) in PREFERRED {
        if let Some(index) = cmap.subtables.iter().position(|s| s.platform == platform && s.encoding == encoding) {
            let map = cmap.decode(index)?;
            if !map.is_empty() {
                return Some(map.keys().copied().collect());
            }
            break;
        }
    }
    let mut points = BTreeSet::new();
    for index in 0..cmap.subtables.len() {
        points.extend(cmap.decode(index)?.keys().copied());
    }
    (!points.is_empty()).then_some(points)
}

struct Subtable<'a> {
    platform: u16,
    encoding: u16,
    format: u16,
    /// The subtable as it sits in the table, header included.
    data: &'a [u8],
    /// Set when this subtable shares its offset with an earlier one.
    same_as: Option<usize>,
    decoded: Option<Option<BTreeMap<u32, u32>>>,
}

struct Cmap<'a> {
    subtables: Vec<Subtable<'a>>,
}

impl<'a> Cmap<'a> {
    fn parse(data: &'a [u8]) -> Option<Cmap<'a>> {
        let count = be16(data, 2)? as usize;
        be16(data, 0)?;
        let mut subtables: Vec<Subtable<'a>> = Vec::new();
        let mut seen: HashMap<usize, usize> = HashMap::new();
        for i in 0..count {
            let record = 4 + i * 8;
            let platform = be16(data, record)?;
            let encoding = be16(data, record + 2)?;
            let offset = i32::from_be_bytes(data.get(record + 4..record + 8)?.try_into().ok()?);
            if offset < 0 {
                return None;
            }
            let offset = offset as usize;
            let format = be16(data, offset)?;
            let length = match format {
                8 | 10 | 12 | 13 => be32(data, offset + 4)? as usize,
                14 => be32(data, offset + 2)? as usize,
                _ => be16(data, offset + 2)? as usize,
            };
            if length == 0 {
                continue;
            }
            let end = offset.saturating_add(length).min(data.len());
            let slice = &data[offset.min(data.len())..end];
            // The header checks fontTools makes up front, for every subtable.
            match format {
                0 | 2 | 4 | 6 => {
                    be16(slice, 4)?;
                    if slice.len() != length {
                        return None;
                    }
                }
                12 | 13 => {
                    let groups = be32(slice, 12)? as usize;
                    be32(slice, 4)?;
                    if slice.len() != 16usize.checked_add(groups.checked_mul(12)?)? || slice.len() != length {
                        return None;
                    }
                }
                14 => {
                    be32(slice, 6)?;
                }
                _ => {}
            }
            let same_as = seen.get(&offset).copied();
            seen.entry(offset).or_insert(i.min(subtables.len()));
            subtables.push(Subtable { platform, encoding, format, data: slice, same_as, decoded: None });
        }
        let mut cmap = Cmap { subtables };
        // A subtable that shares an earlier one's offset takes its map right away,
        // which decodes (and can fail on) the first one.
        for index in 0..cmap.subtables.len() {
            if let Some(first) = cmap.subtables[index].same_as {
                cmap.decode(first)?;
            }
        }
        Some(cmap)
    }

    fn decode(&mut self, index: usize) -> Option<BTreeMap<u32, u32>> {
        if let Some(first) = self.subtables[index].same_as {
            return self.decode(first);
        }
        if self.subtables[index].decoded.is_none() {
            let sub = &self.subtables[index];
            let result = decode_subtable(sub.format, sub.data);
            self.subtables[index].decoded = Some(result);
        }
        self.subtables[index].decoded.clone().unwrap()
    }
}

fn decode_subtable(format: u16, data: &[u8]) -> Option<BTreeMap<u32, u32>> {
    let mut map = BTreeMap::new();
    let mut put = |code: u32, gid: u32| {
        if gid != 0 {
            map.insert(code, gid);
        }
    };
    match format {
        0 => {
            if data.len() != 262 {
                return None;
            }
            for (code, gid) in data[6..].iter().enumerate() {
                put(code as u32, u32::from(*gid));
            }
        }
        4 => {
            let body = data.get(6..)?;
            let seg_count = (be16(body, 0)? / 2) as usize;
            let words = &body[8..];
            if words.len() % 2 != 0 {
                return None;
            }
            let word = |i: usize| be16(words, i * 2);
            // endCode[segCount], reservedPad, startCode, idDelta, idRangeOffset, glyphIndexArray
            let needed = seg_count * 4 + 1;
            if words.len() / 2 < needed {
                return None;
            }
            let total_words = words.len() / 2;
            let gi_start = needed;
            let gi_len = total_words - gi_start;
            for i in 0..seg_count.saturating_sub(1) {
                let end = u32::from(word(i)?);
                let start = u32::from(word(seg_count + 1 + i)?);
                let delta = u32::from(word(2 * seg_count + 1 + i)?);
                let range_offset = i64::from(word(3 * seg_count + 1 + i)?);
                if end < start {
                    continue;
                }
                for code in start..=end {
                    let gid = if range_offset == 0 {
                        (code + delta) & 0xFFFF
                    } else {
                        let partial = range_offset / 2 - i64::from(start) + i as i64 - seg_count as i64;
                        let index = i64::from(code) + partial;
                        if index < 0 || index as usize >= gi_len {
                            return None;
                        }
                        let raw = u32::from(word(gi_start + index as usize)?);
                        if raw != 0 { (raw + delta) & 0xFFFF } else { 0 }
                    };
                    put(code, gid);
                }
            }
        }
        6 => {
            let body = data.get(6..)?;
            let first = u32::from(be16(body, 0)?);
            let entries = be16(body, 2)? as usize;
            let available = &body[4..];
            let wanted = &available[..(entries * 2).min(available.len())];
            if wanted.len() % 2 != 0 {
                return None;
            }
            for (i, pair) in wanted.chunks(2).enumerate() {
                put(first + i as u32, u32::from(u16::from_be_bytes([pair[0], pair[1]])));
            }
        }
        12 | 13 => {
            let groups = be32(data, 12)? as usize;
            let mut total = 0u64;
            for g in 0..groups {
                let at = 16 + g * 12;
                let start = be32(data, at)?;
                let end = be32(data, at + 4)?;
                let glyph = be32(data, at + 8)?;
                if end < start {
                    continue;
                }
                total += u64::from(end) - u64::from(start) + 1;
                if total > MAX_MAPPINGS * 4 {
                    return None;
                }
                for (i, code) in (start..=end).enumerate() {
                    let gid = if format == 12 { u64::from(glyph) + i as u64 } else { u64::from(glyph) };
                    if gid != 0 {
                        map.insert(code, gid.min(u64::from(u32::MAX)) as u32);
                    }
                }
            }
        }
        14 => {
            // Variation selectors add no code points of their own; only make
            // sure the records are all there, as fontTools reads them.
            let body = data.get(10..)?;
            let records = be32(data, 6)? as usize;
            for n in 0..records {
                let at = n * 11;
                body.get(at..at + 11)?;
                let default_offset = be32(body, at + 3)? as usize;
                let non_default_offset = be32(body, at + 7)? as usize;
                if default_offset != 0 {
                    let start = default_offset.checked_sub(10)?;
                    let count = be32(body, start)? as usize;
                    body.get(start + 4..start + 4 + count.checked_mul(4)?)?;
                }
                if non_default_offset != 0 {
                    let start = non_default_offset.checked_sub(10)?;
                    let count = be32(body, start)? as usize;
                    body.get(start + 4..start + 4 + count.checked_mul(5)?)?;
                }
            }
        }
        // Format 2 (legacy CJK) and the formats fontTools does not read.
        _ => return None,
    }
    Some(map)
}

/// The old "WinAnsi space is an empty glyph" proof for a TrueType font: exactly
/// one Windows Unicode cmap with a format 4 subtable that maps U+0020, every
/// Unicode subtable agreeing on the glyph, and that glyph occupying no bytes of
/// `glyf`. Outline formats other than plain `glyf`, colour and bitmap tables,
/// and variable fonts are not trusted.
pub fn winansi_space_is_empty(font: &[u8]) -> bool {
    winansi_space_is_empty_inner(font).unwrap_or(false)
}

fn winansi_space_is_empty_inner(font: &[u8]) -> Option<bool> {
    let sfnt = Sfnt::parse_plain(font)?;
    const REFUSED: [&[u8; 4]; 13] = [
        b"CFF ", b"CFF2", b"COLR", b"CPAL", b"SVG ", b"CBDT", b"CBLC", b"EBDT", b"EBLC", b"EBSC", b"bdat", b"bloc",
        b"sbix",
    ];
    if REFUSED.iter().any(|tag| sfnt.has(tag)) {
        return Some(false);
    }
    let variable = sfnt.has(b"fvar") || sfnt.has(b"gvar");
    if variable && !(sfnt.has(b"fvar") && sfnt.has(b"gvar")) {
        return Some(false);
    }
    if !sfnt.glyph_names_available() {
        return None;
    }
    let mut cmap = Cmap::parse(sfnt.table(b"cmap")?)?;
    let windows: Vec<usize> =
        (0..cmap.subtables.len()).filter(|&i| cmap.subtables[i].platform == 3 && cmap.subtables[i].encoding == 1).collect();
    if windows.len() != 1 || cmap.subtables[windows[0]].format != 4 {
        return Some(false);
    }
    let gid = match cmap.decode(windows[0])?.get(&32) {
        Some(gid) => *gid,
        None => return Some(false),
    };
    for index in 0..cmap.subtables.len() {
        let (platform, encoding) = (cmap.subtables[index].platform, cmap.subtables[index].encoding);
        if platform == 0 || (platform == 3 && matches!(encoding, 0 | 1 | 10)) {
            if cmap.decode(index)?.get(&32) != Some(&gid) {
                return Some(false);
            }
        }
    }
    let head = sfnt.table(b"head")?;
    if head.len() < 54 {
        return None;
    }
    let long_format = i16::from_be_bytes([head[50], head[51]]) != 0;
    let maxp = sfnt.table(b"maxp")?;
    if be32(maxp, 0)? == 0x0001_0000 && maxp.len() < 32 {
        return None;
    }
    let loca = sfnt.table(b"loca")?;
    let width = if long_format { 4 } else { 2 };
    if loca.len() % width != 0 {
        return None;
    }
    let entries = loca.len() / width;
    let at = |i: usize| -> Option<u64> {
        let raw = loca.get(i * width..(i + 1) * width)?;
        Some(if long_format { u64::from(u32::from_be_bytes(raw.try_into().ok()?)) } else { 2 * u64::from(u16::from_be_bytes(raw.try_into().ok()?)) })
    };
    let glyf_length = sfnt.directory_length(b"glyf")? as u64;
    let gid = gid as usize;
    if !(0 < gid && gid + 1 < entries) {
        return Some(false);
    }
    let (start, end) = (at(gid)?, at(gid + 1)?);
    if !(start == end && end <= glyf_length) {
        return Some(false);
    }
    if variable {
        // A zero-length glyph has no outline points; only a bounded variation
        // record that moves the four metric phantom points cannot create one.
        if !axes_are_bounded(sfnt.table(b"fvar")?)? {
            return Some(false);
        }
        return Some(gvar_moves_only_phantom_points(sfnt.table(b"gvar")?, gid)?);
    }
    Some(true)
}

/// `0 < len(fvar.axes) <= 16`, reading the table the way fontTools does.
fn axes_are_bounded(fvar: &[u8]) -> Option<bool> {
    let axes_offset = be16(fvar, 4)? as usize;
    let axis_count = be16(fvar, 8)? as usize;
    let axis_size = be16(fvar, 10)? as usize;
    let instance_count = be16(fvar, 12)? as usize;
    let instance_size = be16(fvar, 14)? as usize;
    if axis_size != 20 || !(1..=16).contains(&axis_count) {
        return Some(false);
    }
    let axes_end = axes_offset.checked_add(axis_count * axis_size)?;
    let instances_end = axes_end.checked_add(instance_count.checked_mul(instance_size)?)?;
    if instances_end > fvar.len() {
        return None;
    }
    Some(true)
}

fn gvar_moves_only_phantom_points(gvar: &[u8], gid: usize) -> Option<bool> {
    const PHANTOM_POINTS: usize = 4;
    let axis_count = be16(gvar, 4)? as usize;
    let shared_count = be16(gvar, 6)? as usize;
    let glyph_count = be16(gvar, 12)? as usize;
    let long_offsets = be16(gvar, 14)? & 1 != 0;
    let array_offset = be32(gvar, 16)? as usize;
    if gid >= glyph_count {
        return None;
    }
    let offset_at = |i: usize| -> Option<usize> {
        if long_offsets {
            Some(be32(gvar, 20 + i * 4)? as usize)
        } else {
            Some(be16(gvar, 20 + i * 2)? as usize * 2)
        }
    };
    let (start, end) = (array_offset.checked_add(offset_at(gid)?)?, array_offset.checked_add(offset_at(gid + 1)?)?);
    if start == end {
        return Some(true);
    }
    let data = gvar.get(start..end)?;
    let flags_and_count = be16(data, 0)?;
    let count = (flags_and_count & 0x0FFF) as usize;
    let shared_points = flags_and_count & 0x8000 != 0;
    let data_offset = be16(data, 2)? as usize;
    if count > 64 {
        return Some(false);
    }
    // Tuple headers.
    let mut headers = Vec::new();
    let mut at = 4usize;
    for _ in 0..count {
        let size = be16(data, at)? as usize;
        let index = be16(data, at + 2)?;
        at += 4;
        if index & 0x8000 != 0 {
            data.get(at..at + axis_count * 2)?;
            at += axis_count * 2;
        } else if (index & 0x0FFF) as usize >= shared_count {
            return None;
        }
        if index & 0x4000 != 0 {
            data.get(at..at + axis_count * 4)?;
            at += axis_count * 4;
        }
        headers.push((size, index & 0x2000 != 0));
    }
    let body = data.get(data_offset..)?;
    let mut pos = 0usize;
    let mut shared: Option<Option<Vec<usize>>> = None;
    if shared_points {
        let (points, used) = packed_points(body.get(pos..)?)?;
        pos += used;
        shared = Some(points);
    }
    for (size, private) in headers {
        let tuple = body.get(pos..pos.checked_add(size)?)?;
        pos += size;
        let mut at = 0usize;
        let points = if private {
            let (points, used) = packed_points(tuple)?;
            at += used;
            points
        } else {
            shared.clone()?
        };
        let delta_count = match &points {
            Some(list) => {
                if list.iter().any(|p| *p >= PHANTOM_POINTS) {
                    return None;
                }
                list.len()
            }
            None => PHANTOM_POINTS,
        };
        at += packed_deltas(tuple.get(at..)?, delta_count)?;
        at += packed_deltas(tuple.get(at..)?, delta_count)?;
        let _ = at;
    }
    Some(true)
}

/// Packed point numbers: the points (`None` for "all") and the bytes used.
fn packed_points(data: &[u8]) -> Option<(Option<Vec<usize>>, usize)> {
    let mut at = 0usize;
    let first = *data.first()? as usize;
    at += 1;
    let count = if first == 0 {
        return Some((None, at));
    } else if first & 0x80 != 0 {
        let second = *data.get(at)? as usize;
        at += 1;
        ((first & 0x7F) << 8) | second
    } else {
        first
    };
    let mut points = Vec::with_capacity(count);
    let mut current = 0usize;
    while points.len() < count {
        let control = *data.get(at)? as usize;
        at += 1;
        let run = (control & 0x7F) + 1;
        for _ in 0..run {
            let step = if control & 0x80 != 0 {
                let v = be16(data, at)? as usize;
                at += 2;
                v
            } else {
                let v = *data.get(at)? as usize;
                at += 1;
                v
            };
            current += step;
            points.push(current);
            if points.len() > count {
                return None;
            }
        }
    }
    Some((Some(points), at))
}

/// Skips `count` packed deltas; returns the bytes they use.
fn packed_deltas(data: &[u8], count: usize) -> Option<usize> {
    let mut at = 0usize;
    let mut done = 0usize;
    while done < count {
        let control = *data.get(at)? as usize;
        at += 1;
        let run = (control & 0x3F) + 1;
        if control & 0x80 == 0 {
            let width = if control & 0x40 != 0 { 2 } else { 1 };
            data.get(at..at + run * width)?;
            at += run * width;
        }
        done += run;
        if done > count {
            return None;
        }
    }
    Some(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmap_with(subtables: &[(u16, u16, Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![0, 0];
        out.extend((subtables.len() as u16).to_be_bytes());
        let mut offset = 4 + subtables.len() * 8;
        for (platform, encoding, body) in subtables {
            out.extend(platform.to_be_bytes());
            out.extend(encoding.to_be_bytes());
            out.extend((offset as u32).to_be_bytes());
            offset += body.len();
        }
        for (_, _, body) in subtables {
            out.extend(body);
        }
        out
    }

    fn format0(gids: &[(u8, u8)]) -> Vec<u8> {
        let mut body = vec![0, 0, 1, 6, 0, 0];
        let mut table = [0u8; 256];
        for (code, gid) in gids {
            table[*code as usize] = *gid;
        }
        body.extend(table);
        body
    }

    fn font_with(tables: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![0, 1, 0, 0];
        out.extend((tables.len() as u16).to_be_bytes());
        out.extend([0u8; 6]);
        let mut offset = 12 + tables.len() * 16;
        for (tag, body) in tables {
            out.extend(*tag);
            out.extend([0u8; 4]);
            out.extend((offset as u32).to_be_bytes());
            out.extend((body.len() as u32).to_be_bytes());
            offset += body.len();
        }
        for (_, body) in tables {
            out.extend(body);
        }
        out
    }

    fn maxp(glyphs: u16) -> Vec<u8> {
        let mut out = vec![0, 0, 0x50, 0, 0, 0];
        out[4..6].copy_from_slice(&glyphs.to_be_bytes());
        out
    }

    #[test]
    fn format_0_skips_the_notdef_glyph() {
        let cmap = cmap_with(&[(1, 0, format0(&[(65, 3), (66, 0), (67, 9)]))]);
        let font = font_with(&[(b"cmap", cmap), (b"maxp", maxp(10))]);
        let points = cmap_codepoints(&font).unwrap();
        assert_eq!(points.into_iter().collect::<Vec<_>>(), vec![65, 67]);
    }

    #[test]
    fn the_preferred_subtable_wins_and_an_empty_one_falls_back_to_the_union() {
        let cmap = cmap_with(&[(1, 0, format0(&[(65, 3)])), (3, 1, format0(&[(66, 3)]))]);
        let font = font_with(&[(b"cmap", cmap), (b"maxp", maxp(10))]);
        assert_eq!(cmap_codepoints(&font).unwrap().into_iter().collect::<Vec<_>>(), vec![66]);
        let cmap = cmap_with(&[(1, 0, format0(&[(65, 3)])), (3, 1, format0(&[]))]);
        let font = font_with(&[(b"cmap", cmap), (b"maxp", maxp(10))]);
        assert_eq!(cmap_codepoints(&font).unwrap().into_iter().collect::<Vec<_>>(), vec![65]);
    }

    #[test]
    fn damaged_fonts_are_unknown() {
        assert!(cmap_codepoints(b"not a font").is_none());
        let cmap = cmap_with(&[(3, 1, format0(&[(65, 3)]))]);
        // No maxp: fontTools cannot name the glyphs.
        assert!(cmap_codepoints(&font_with(&[(b"cmap", cmap.clone())])).is_none());
        // A subtable whose length disagrees with the data.
        let mut bad = cmap.clone();
        let last = bad.len() - 1;
        bad.truncate(last);
        assert!(cmap_codepoints(&font_with(&[(b"cmap", bad), (b"maxp", maxp(10))])).is_none());
    }
}
