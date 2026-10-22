//! Barcodes (Code 128, EAN-13, EAN-8, Code 39) as PNG or SVG.
//!
//! Each encoder turns the text into a module pattern (`true` = bar, one entry
//! per module); [`render`] draws that pattern, with the human-readable text
//! under the bars, the way `python-barcode` did. The encoders are written here
//! instead of taken from a crate so their output is pinned by tests.

mod render;
mod tables;

use tables::*;

use super::code_image::invalid;
pub use super::code_image::{Generated, OutputFormat};
use crate::error::CoreResult;

/// Longest text accepted. A 1000 character Code 128 is a 25,000 px wide image.
pub const MAX_CONTENT_CHARS: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarcodeKind {
    Code128,
    Ean13,
    Ean8,
    Code39,
}

impl BarcodeKind {
    /// `code128`, `ean13`, `ean8` or `code39`, in any case.
    pub fn parse(name: &str) -> CoreResult<Self> {
        match name.to_ascii_lowercase().as_str() {
            "code128" => Ok(Self::Code128),
            "ean13" => Ok(Self::Ean13),
            "ean8" => Ok(Self::Ean8),
            "code39" => Ok(Self::Code39),
            _ => Err(invalid(format!("Unsupported barcode type: {name}"))),
        }
    }
}

/// An encoded barcode, before drawing.
#[derive(Debug, Clone, PartialEq)]
pub struct Encoded {
    /// One entry per module, left to right; `true` is a bar.
    pub modules: Vec<bool>,
    /// The text printed under the bars (includes a check digit that was added).
    pub text: String,
    /// Width of one module and of each quiet zone, in millimetres.
    pub(crate) module_mm: f64,
    pub(crate) quiet_mm: f64,
}

/// Generates a barcode image for `content`.
pub fn generate(content: &str, barcode_type: &str, format: &str) -> CoreResult<Generated> {
    if content.trim().is_empty() {
        return Err(invalid("Content cannot be empty."));
    }
    let kind = BarcodeKind::parse(barcode_type)?;
    let format = OutputFormat::parse(format)?;
    let encoded = encode(kind, content)?;
    let bytes = match format {
        OutputFormat::Png => render::png(&encoded)?,
        OutputFormat::Svg => render::svg(&encoded).into_bytes(),
    };
    Ok(Generated {
        bytes,
        mime: format.mime(),
    })
}

/// Encodes `content` as `kind`, validating it first.
pub fn encode(kind: BarcodeKind, content: &str) -> CoreResult<Encoded> {
    if content.chars().count() > MAX_CONTENT_CHARS {
        return Err(invalid("Content is too long for a barcode."));
    }
    match kind {
        BarcodeKind::Code128 => code128(content),
        BarcodeKind::Code39 => code39(content),
        BarcodeKind::Ean13 => ean(content.trim(), 13),
        BarcodeKind::Ean8 => ean(content.trim(), 8),
    }
}

fn bits(pattern: &str, into: &mut Vec<bool>) {
    into.extend(pattern.bytes().map(|b| b == b'1'));
}

// ── Code 128 ─────────────────────────────────────────────────────────────────

const SET_A: usize = 0;
const SET_B: usize = 1;
const SET_C: usize = 2;
const START: [u32; 3] = [103, 104, 105];
/// Symbol that switches to set A, B or C.
const SWITCH: [u32; 3] = [101, 100, 99];

fn encodable(set: usize, c: u8) -> bool {
    match set {
        SET_A => c <= 95,
        _ => (32..=127).contains(&c),
    }
}

fn symbol_value(set: usize, c: u8) -> u32 {
    match set {
        SET_A if c < 32 => u32::from(c) + 64,
        _ => u32::from(c) - 32,
    }
}

/// How the cheapest path reached a state.
#[derive(Clone, Copy)]
enum Step {
    Start,
    Char,
    Pair,
    Switch,
}

/// Symbols of a Code 128 text: start code, data and switch symbols, the way
/// needing the fewest symbols (digit pairs in set C, everything else in A or B).
fn code128_symbols(data: &[u8]) -> Vec<u32> {
    let n = data.len();
    const INF: u32 = u32::MAX / 2;
    // cost[i][set]: fewest symbols after the first i characters, in `set`.
    let mut cost = vec![[INF; 3]; n + 1];
    let mut from: Vec<[(usize, Step); 3]> = vec![[(0, Step::Start); 3]; n + 1];
    let mut update =
        |cost: &mut Vec<[u32; 3]>, i: usize, set: usize, value: u32, via: (usize, Step)| {
            if value < cost[i][set] {
                cost[i][set] = value;
                from[i][set] = via;
            }
        };
    for set in 0..3 {
        update(&mut cost, 0, set, 1, (set, Step::Start));
    }
    for i in 0..=n {
        // A switch costs one symbol; two in a row never pay off.
        for from_set in 0..3 {
            for to_set in 0..3 {
                if from_set != to_set && cost[i][from_set] < INF {
                    let value = cost[i][from_set] + 1;
                    update(&mut cost, i, to_set, value, (from_set, Step::Switch));
                }
            }
        }
        if i == n {
            break;
        }
        for set in [SET_A, SET_B] {
            if cost[i][set] < INF && encodable(set, data[i]) {
                let value = cost[i][set] + 1;
                update(&mut cost, i + 1, set, value, (set, Step::Char));
            }
        }
        if cost[i][SET_C] < INF
            && i + 1 < n
            && data[i].is_ascii_digit()
            && data[i + 1].is_ascii_digit()
        {
            let value = cost[i][SET_C] + 1;
            update(&mut cost, i + 2, SET_C, value, (SET_C, Step::Pair));
        }
    }

    // Ties go to set B (then A), the choice a reader of the old output expects.
    let mut set = [SET_B, SET_A, SET_C]
        .into_iter()
        .min_by_key(|s| cost[n][*s])
        .unwrap_or(SET_B);
    let mut i = n;
    let mut reversed = Vec::new();
    loop {
        let (prev_set, step) = from[i][set];
        match step {
            Step::Start => {
                reversed.push(START[set]);
                break;
            }
            Step::Char => {
                i -= 1;
                reversed.push(symbol_value(set, data[i]));
            }
            Step::Pair => {
                i -= 2;
                reversed.push(u32::from(data[i] - b'0') * 10 + u32::from(data[i + 1] - b'0'));
            }
            Step::Switch => reversed.push(SWITCH[set]),
        }
        set = prev_set;
    }
    reversed.reverse();
    reversed
}

fn code128(content: &str) -> CoreResult<Encoded> {
    let bad: Vec<String> = content
        .chars()
        .filter(|c| !c.is_ascii())
        .map(String::from)
        .collect();
    if !bad.is_empty() {
        return Err(invalid(format!(
            "The following characters are not valid for Code 128: {}",
            bad.join(", ")
        )));
    }
    let symbols = code128_symbols(content.as_bytes());
    let checksum = symbols
        .iter()
        .enumerate()
        .map(|(i, v)| if i == 0 { *v } else { i as u32 * v })
        .sum::<u32>()
        % 103;
    let mut modules = Vec::new();
    for symbol in symbols.iter().copied().chain([checksum]) {
        bits(CODE128[symbol as usize], &mut modules);
    }
    bits(CODE128_STOP, &mut modules);
    Ok(Encoded {
        modules,
        text: content.to_owned(),
        module_mm: 0.2,
        quiet_mm: 2.54,
    })
}

// ── Code 39 ──────────────────────────────────────────────────────────────────

fn code39(content: &str) -> CoreResult<Encoded> {
    let text = content.to_ascii_uppercase();
    let bad: Vec<String> = text
        .chars()
        .filter(|c| !CODE39_CHARS.contains(*c))
        .map(String::from)
        .collect();
    if !bad.is_empty() {
        return Err(invalid(format!(
            "The following characters are not valid for Code 39: {}",
            bad.join(", ")
        )));
    }
    let index = |c: char| CODE39_CHARS.find(c).unwrap_or(0);
    // Mod 43 check character, added like python-barcode did.
    let check = text.chars().map(index).sum::<usize>() % 43;
    let text = format!("{text}{}", CODE39_CHARS.as_bytes()[check] as char);

    let mut modules = Vec::new();
    bits(CODE39_EDGE, &mut modules);
    for c in text.chars() {
        modules.push(false);
        bits(CODE39[index(c)], &mut modules);
    }
    modules.push(false);
    bits(CODE39_EDGE, &mut modules);
    Ok(Encoded {
        modules,
        text,
        module_mm: 0.2,
        quiet_mm: 2.54,
    })
}

// ── EAN ──────────────────────────────────────────────────────────────────────

/// Check digit of the digits before it: weights 3 and 1 from the right.
fn ean_check_digit(digits: &[u8]) -> u8 {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, d)| u32::from(*d) * if i % 2 == 0 { 3 } else { 1 })
        .sum();
    ((10 - sum % 10) % 10) as u8
}

/// EAN-13 (`length` 13) or EAN-8 (`length` 8) from the digits without or with
/// their check digit. A given check digit must be right.
fn ean(content: &str, length: usize) -> CoreResult<Encoded> {
    let name = if length == 13 { "EAN-13" } else { "EAN-8" };
    let body = length - 1;
    if !content.bytes().all(|b| b.is_ascii_digit()) || ![body, length].contains(&content.len()) {
        return Err(invalid(format!(
            "{name} requires exactly {body} or {length} numeric digits."
        )));
    }
    let mut digits: Vec<u8> = content.bytes().map(|b| b - b'0').collect();
    let check = ean_check_digit(&digits[..body]);
    if digits.len() == length {
        if digits[body] != check {
            return Err(invalid(format!(
                "The check digit of this {name} is wrong, it should be {check}."
            )));
        }
    } else {
        digits.push(check);
    }

    let mut modules = Vec::new();
    bits(EAN_EDGE, &mut modules);
    let set = |name: char, digit: u8| match name {
        'A' => EAN_A[digit as usize],
        'B' => EAN_B[digit as usize],
        _ => EAN_C[digit as usize],
    };
    if length == 13 {
        let parity = EAN_LEFT[digits[0] as usize].as_bytes();
        for (i, digit) in digits[1..7].iter().enumerate() {
            bits(set(parity[i] as char, *digit), &mut modules);
        }
        bits(EAN_MIDDLE, &mut modules);
        for digit in &digits[7..] {
            bits(set('C', *digit), &mut modules);
        }
    } else {
        for digit in &digits[..4] {
            bits(set('A', *digit), &mut modules);
        }
        bits(EAN_MIDDLE, &mut modules);
        for digit in &digits[4..] {
            bits(set('C', *digit), &mut modules);
        }
    }
    bits(EAN_EDGE, &mut modules);
    let text = digits.iter().map(|d| char::from(b'0' + d)).collect();
    Ok(Encoded {
        modules,
        text,
        module_mm: 0.33,
        quiet_mm: 6.5,
    })
}
