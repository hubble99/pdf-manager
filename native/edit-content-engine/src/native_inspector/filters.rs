//! Stream decoding for the inspector.
//!
//! Mirrors what the old reader (pypdf) returns for `get_data()` wherever it
//! returns anything it can vouch for, and refuses where pypdf would have "made
//! the best of it" (recovering a broken Flate stream, ignoring a missing end
//! marker, skipping filters it had no parameters for, decoding an image to a
//! TIFF it built itself). A refusal makes the file unsupported or the proof
//! unavailable; it never changes what a supported file yields.

use std::io::Read;

use flate2::bufread::ZlibDecoder;

use super::pdf::{reject, Obj, PResult, Pdf, Reject, Stream};

/// pypdf's limit for every decoder output.
pub const MAX_OUTPUT: usize = 75_000_000;
const MAX_ROW_BYTES: u64 = 4_000_000;
const MAX_COLUMNS: i64 = 250_000;

pub fn decode_stream(pdf: &Pdf, stream: &Stream) -> PResult<Vec<u8>> {
    let raw = pdf.stream_bytes(stream);
    let filters = filter_names(pdf, stream)?;
    if filters.is_empty() || raw.is_empty() {
        return Ok(raw.to_vec());
    }
    let parms = decode_parms(pdf, stream, filters.len())?;
    let mut data = raw.to_vec();
    for (name, params) in filters.iter().zip(parms.iter()) {
        data = match &**name {
            "/FlateDecode" | "/Fl" => flate(&data, params.as_ref(), pdf)?,
            "/ASCIIHexDecode" | "/AHx" => ascii_hex(&data)?,
            "/ASCII85Decode" | "/A85" => ascii85(&data)?,
            "/RunLengthDecode" | "/RL" => run_length(&data)?,
            // pypdf hands the encoded bytes back for these.
            "/DCTDecode" | "/DCT" | "/JPXDecode" => data,
            "/Crypt" => {
                if let Some(Obj::Dict(dict)) = params {
                    if dict.contains("/Name") || dict.contains("/Type") {
                        reject!("/Crypt with parameters");
                    }
                }
                data
            }
            _ => reject!("unsupported filter"),
        };
    }
    Ok(data)
}

fn filter_names(pdf: &Pdf, stream: &Stream) -> PResult<Vec<std::rc::Rc<str>>> {
    let Some(value) = stream.dict.get("/Filter") else { return Ok(Vec::new()) };
    match pdf.resolve(value)? {
        Obj::Name(name) => Ok(vec![name]),
        // A reference inside the array makes pypdf compare the reference itself
        // with the filter names, so it stops with "unsupported filter".
        Obj::Array(items) => items
            .iter()
            .map(|item| match item {
                Obj::Name(name) => Ok(name.clone()),
                _ => Err(Reject("filter array entry")),
            })
            .collect(),
        Obj::Null => Ok(Vec::new()),
        _ => reject!("bad /Filter"),
    }
}

/// One parameter object per filter. pypdf pairs them with `zip`, which silently
/// drops the filters that have no partner, so only a complete pairing is taken.
fn decode_parms(pdf: &Pdf, stream: &Stream, count: usize) -> PResult<Vec<Option<Obj>>> {
    let Some(value) = stream.dict.get("/DecodeParms") else { return Ok(vec![None; count]) };
    let resolved = pdf.resolve(value)?;
    let items: Vec<Obj> = match resolved {
        Obj::Array(items) => {
            if items.len() != count {
                reject!("/DecodeParms does not pair with /Filter");
            }
            items.iter().cloned().collect()
        }
        other if count == 1 => vec![other],
        _ => reject!("/DecodeParms does not pair with /Filter"),
    };
    let mut out = Vec::with_capacity(count);
    for item in items {
        out.push(match pdf.resolve(&item)? {
            Obj::Null => None,
            dict @ Obj::Dict(_) => Some(dict),
            _ => reject!("bad /DecodeParms entry"),
        });
    }
    Ok(out)
}

fn int_param(pdf: &Pdf, dict: &super::pdf::Dict, key: &str, default: i64) -> PResult<i64> {
    match dict.get(key) {
        None => Ok(default),
        Some(value) => match pdf.resolve(value)? {
            Obj::Int(n) if n >= 1 => Ok(n),
            _ => reject!("bad decode parameter"),
        },
    }
}

fn flate(data: &[u8], params: Option<&Obj>, pdf: &Pdf) -> PResult<Vec<u8>> {
    let mut input: &[u8] = data;
    let mut decoder = ZlibDecoder::new(&mut input).take(MAX_OUTPUT as u64 + 1);
    let mut out = Vec::new();
    if decoder.read_to_end(&mut out).is_err() {
        reject!("flate data is damaged");
    }
    if out.len() > MAX_OUTPUT {
        reject!("flate output too large");
    }
    drop(decoder);
    // pypdf ignores whatever follows the end of the stream; a line break or
    // padding after it is harmless, anything else is not trusted.
    if !input.iter().all(|b| matches!(b, 0 | 9 | 10 | 13 | 32)) {
        reject!("data after the flate stream");
    }

    let Some(Obj::Dict(dict)) = params else { return Ok(out) };
    let predictor = match dict.get("/Predictor") {
        None => 1,
        Some(Obj::Int(n)) => *n,
        Some(_) => reject!("bad /Predictor"),
    };
    if predictor == 1 {
        return Ok(out);
    }
    let columns = int_param(pdf, dict, "/Columns", 1)?;
    if columns > MAX_COLUMNS {
        reject!("too many columns");
    }
    let colors = int_param(pdf, dict, "/Colors", 1)?;
    if colors > 16 {
        reject!("too many colors");
    }
    let bits = int_param(pdf, dict, "/BitsPerComponent", 8)?;
    if bits > 16 {
        reject!("bad bits per component");
    }
    let row_with_filter = ((columns * colors * bits) as u64).div_ceil(8) + 1;
    if row_with_filter > MAX_ROW_BYTES {
        reject!("row too long");
    }
    let row_with_filter = row_with_filter as usize;
    match predictor {
        2 => {
            let row = row_with_filter - 1;
            let bpp = row / columns as usize;
            for i in 0..out.len() {
                if i % row >= bpp {
                    out[i] = out[i].wrapping_add(out[i - bpp]);
                }
            }
            Ok(out)
        }
        10..=15 => png_unpredict(&out, columns as usize, row_with_filter),
        _ => reject!("unsupported predictor"),
    }
}

fn png_unpredict(data: &[u8], columns: usize, row_length: usize) -> PResult<Vec<u8>> {
    if data.len() % row_length != 0 {
        reject!("predictor data is not rectangular");
    }
    let bpp = (row_length - 1) / columns;
    let mut out = Vec::with_capacity(data.len() / row_length * (row_length - 1));
    let mut previous = vec![0u8; row_length];
    for chunk in data.chunks(row_length) {
        let mut row = chunk.to_vec();
        match row[0] {
            0 => {}
            1 => {
                for i in bpp + 1..row_length {
                    row[i] = row[i].wrapping_add(row[i - bpp]);
                }
            }
            2 => {
                for i in 1..row_length {
                    row[i] = row[i].wrapping_add(previous[i]);
                }
            }
            3 => {
                for i in 1..=bpp.min(row_length - 1) {
                    row[i] = row[i].wrapping_add(previous[i] / 2);
                }
                for i in bpp + 1..row_length {
                    let floor = ((row[i - bpp] as u16 + previous[i] as u16) / 2) as u8;
                    row[i] = row[i].wrapping_add(floor);
                }
            }
            4 => {
                for i in 1..=bpp.min(row_length - 1) {
                    row[i] = row[i].wrapping_add(previous[i]);
                }
                for i in bpp + 1..row_length {
                    let left = row[i - bpp] as i32;
                    let up = previous[i] as i32;
                    let up_left = previous[i - bpp] as i32;
                    let p = left + up - up_left;
                    let (dl, du, dul) = ((p - left).abs(), (p - up).abs(), (p - up_left).abs());
                    let paeth = if dl <= du && dl <= dul {
                        left
                    } else if du <= dul {
                        up
                    } else {
                        up_left
                    };
                    row[i] = row[i].wrapping_add(paeth as u8);
                }
            }
            _ => reject!("unsupported PNG filter"),
        }
        out.extend_from_slice(&row[1..]);
        previous = row;
        if out.len() > MAX_OUTPUT {
            reject!("predictor output too large");
        }
    }
    Ok(out)
}

fn ascii_hex(data: &[u8]) -> PResult<Vec<u8>> {
    let Some(end) = data.iter().position(|b| *b == b'>') else { reject!("ASCIIHex without end marker") };
    let mut digits = Vec::new();
    for b in &data[..end] {
        match b {
            b' ' | b'\t' | b'\n' | b'\r' => {}
            b if b.is_ascii_hexdigit() => digits.push(*b),
            _ => reject!("bad ASCIIHex data"),
        }
    }
    if digits.len() % 2 == 1 {
        digits.push(b'0');
    }
    let value = |b: u8| (b as char).to_digit(16).unwrap() as u8;
    Ok(digits.chunks(2).map(|pair| value(pair[0]) * 16 + value(pair[1])).collect())
}

/// Adobe-style Ascii85 that must carry its `~>` end marker.
fn ascii85(data: &[u8]) -> PResult<Vec<u8>> {
    let is_ws = |b: &u8| matches!(b, 0 | 9 | 10 | 13 | 32);
    let start = data.iter().position(|b| !is_ws(b)).unwrap_or(data.len());
    let end = data.iter().rposition(|b| !is_ws(b)).map_or(start, |i| i + 1);
    let mut body = &data[start..end];
    if body.len() > 2 && body.ends_with(b">") {
        // pypdf lets white space sit between the `~` and the `>`, so do not.
        if !body.ends_with(b"~>") {
            reject!("bad Ascii85 end marker");
        }
    }
    if !body.ends_with(b"~>") {
        reject!("Ascii85 without end marker");
    }
    body = &body[..body.len() - 2];
    if body.starts_with(b"<~") {
        body = &body[2..];
    }
    let mut out = Vec::new();
    let mut group = [0u8; 5];
    let mut filled = 0usize;
    for &b in body {
        if is_ws(&b) {
            continue;
        }
        match b {
            b'z' => {
                if filled != 0 {
                    reject!("misplaced z in Ascii85");
                }
                out.extend_from_slice(&[0, 0, 0, 0]);
            }
            b'!'..=b'u' => {
                group[filled] = b - b'!';
                filled += 1;
                if filled == 5 {
                    let value = group.iter().fold(0u64, |acc, d| acc * 85 + u64::from(*d));
                    if value > u64::from(u32::MAX) {
                        reject!("Ascii85 overflow");
                    }
                    out.extend_from_slice(&(value as u32).to_be_bytes());
                    filled = 0;
                }
            }
            _ => reject!("bad Ascii85 data"),
        }
        if out.len() > MAX_OUTPUT {
            reject!("Ascii85 output too large");
        }
    }
    if filled == 1 {
        reject!("truncated Ascii85 group");
    }
    if filled > 1 {
        for slot in group.iter_mut().skip(filled) {
            *slot = 84;
        }
        let value = group.iter().fold(0u64, |acc, d| acc * 85 + u64::from(*d));
        if value > u64::from(u32::MAX) {
            reject!("Ascii85 overflow");
        }
        out.extend_from_slice(&(value as u32).to_be_bytes()[..filled - 1]);
    }
    Ok(out)
}

/// Run-length data that ends with its EOD byte and nothing after it.
fn run_length(data: &[u8]) -> PResult<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    loop {
        let Some(&length) = data.get(i) else { reject!("RunLength without EOD") };
        i += 1;
        if length == 128 {
            if i != data.len() {
                reject!("RunLength has data after EOD");
            }
            return Ok(out);
        }
        if length < 128 {
            let count = length as usize + 1;
            let chunk = data.get(i..i + count).ok_or(Reject("RunLength run is cut off"))?;
            out.extend_from_slice(chunk);
            i += count;
        } else {
            let &byte = data.get(i).ok_or(Reject("RunLength run is cut off"))?;
            i += 1;
            out.extend(std::iter::repeat_n(byte, 257 - length as usize));
        }
        if out.len() > MAX_OUTPUT {
            reject!("RunLength output too large");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_hex_needs_its_end_marker_and_clean_digits() {
        assert_eq!(ascii_hex(b"48 65 6c6C 6F>").unwrap(), b"Hello");
        assert_eq!(ascii_hex(b"4>").unwrap(), vec![0x40]);
        assert!(ascii_hex(b"4865").is_err());
        assert!(ascii_hex(b"48g5>").is_err());
    }

    #[test]
    fn ascii85_matches_the_adobe_variant() {
        assert_eq!(ascii85(b"<~87cURD]i,\"Ebo80~>").unwrap(), b"Hello World!");
        assert_eq!(ascii85(b"87cURD]i,\"Ebo80~>").unwrap(), b"Hello World!");
        assert_eq!(ascii85(b"<~z~>").unwrap(), vec![0, 0, 0, 0]);
        assert_eq!(ascii85(b"<~87cURDZ~>").unwrap(), b"Hello");
        assert!(ascii85(b"87cURD]i,\"Ebo80").is_err());
        assert!(ascii85(b"<~8~>").is_err());
        assert!(ascii85(b"<~s8W-\"~>").is_err());
        assert!(ascii85(b"<~87cUzRD~>").is_err());
    }

    #[test]
    fn run_length_needs_an_eod_at_the_very_end() {
        assert_eq!(run_length(&[2, b'a', b'b', b'c', 254, b'x', 128]).unwrap(), b"abcxxx");
        assert!(run_length(&[2, b'a', b'b', b'c']).is_err());
        assert!(run_length(&[1, b'a']).is_err());
        assert!(run_length(&[128, 0]).is_err());
    }

    #[test]
    fn png_prediction_undoes_each_filter() {
        // columns = 2, one byte per pixel: rows of 3 bytes.
        let rows = [0, 10, 20, 1, 5, 5, 2, 1, 1, 3, 1, 1, 4, 1, 1];
        let out = png_unpredict(&rows, 2, 3).unwrap();
        assert_eq!(&out[..4], &[10, 20, 5, 10]);
        assert_eq!(out.len(), 10);
        assert!(png_unpredict(&[9, 0, 0], 2, 3).is_err());
        assert!(png_unpredict(&[0, 0], 2, 3).is_err());
    }
}
