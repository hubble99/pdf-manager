//! JSON the way Python's `json.dumps(sort_keys=True, separators=(",", ":"))`
//! writes it.
//!
//! The inspection carries SHA-256 fingerprints of such text. The two sides of a
//! comparison (the file before an edit and the file after it) are always hashed
//! by this same code, so exact agreement with Python is not needed for
//! correctness; it is kept anyway because it lets the fingerprints be compared
//! byte for byte with the ones the old inspector produced.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Int(i64),
    /// An integral float too large for `i64`, written as its exact digits.
    Digits(String),
    Float(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(BTreeMap<String, J>),
}

impl J {
    pub fn obj(entries: impl IntoIterator<Item = (&'static str, J)>) -> J {
        J::Obj(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    pub fn str(text: impl Into<String>) -> J {
        J::Str(text.into())
    }

    pub fn dump(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(true) => out.push_str("true"),
            J::Bool(false) => out.push_str("false"),
            J::Int(n) => {
                let _ = write!(out, "{n}");
            }
            J::Digits(digits) => out.push_str(digits),
            J::Float(x) => out.push_str(&float_repr(*x)),
            J::Str(text) => write_string(text, out),
            J::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            J::Obj(map) => {
                out.push('{');
                for (i, (key, value)) in map.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_string(key, out);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            J::Null => Value::Null,
            J::Bool(b) => Value::Bool(*b),
            J::Int(n) => Value::from(*n),
            J::Digits(digits) => digits.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number),
            J::Float(x) => serde_json::Number::from_f64(*x).map_or(Value::Null, Value::Number),
            J::Str(text) => Value::String(text.clone()),
            J::Arr(items) => Value::Array(items.iter().map(J::to_value).collect()),
            J::Obj(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), v.to_value())).collect()),
        }
    }
}

fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ' '..='~' => out.push(c),
            _ => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    let _ = write!(out, "\\u{unit:04x}");
                }
            }
        }
    }
    out.push('"');
}

/// `repr(float)`: the shortest text that reads back as the same number, in
/// Python's choice between plain and exponent notation.
pub fn float_repr(x: f64) -> String {
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let sci = format!("{:e}", x.abs());
    let (mantissa, exponent) = sci.split_once('e').expect("LowerExp always has an exponent");
    let exponent: i32 = exponent.parse().expect("exponent is an integer");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let decpt = exponent + 1;
    let n = digits.len() as i32;
    let mut out = String::new();
    if x < 0.0 {
        out.push('-');
    }
    if decpt > 16 || decpt < -3 {
        out.push_str(&digits[..1]);
        if n > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let e = decpt - 1;
        let _ = write!(out, "e{}{:02}", if e < 0 { '-' } else { '+' }, e.abs());
    } else if decpt <= 0 {
        out.push_str("0.");
        out.push_str(&"0".repeat((-decpt) as usize));
        out.push_str(&digits);
    } else if decpt >= n {
        out.push_str(&digits);
        out.push_str(&"0".repeat((decpt - n) as usize));
        out.push_str(".0");
    } else {
        out.push_str(&digits[..decpt as usize]);
        out.push('.');
        out.push_str(&digits[decpt as usize..]);
    }
    out
}

/// What `int(value) if value.is_integer() else value` does to a float.
pub fn normalized_number(x: f64) -> J {
    if x.fract() == 0.0 {
        if x.abs() < 9.0e18 {
            J::Int(x as i64)
        } else {
            J::Digits(format!("{x:.0}"))
        }
    } else {
        J::Float(x)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_read_like_python_repr() {
        for (value, text) in [
            (0.1, "0.1"),
            (1.0, "1.0"),
            (-2.5, "-2.5"),
            (100.0, "100.0"),
            (1e15, "1000000000000000.0"),
            (1e16, "1e+16"),
            (1.5e17, "1.5e+17"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (1.2345e-7, "1.2345e-07"),
            (277.832, "277.832"),
            (0.78431, "0.78431"),
            (-0.0, "-0.0"),
            (123456.789, "123456.789"),
        ] {
            assert_eq!(float_repr(value), text, "{value}");
        }
    }

    #[test]
    fn strings_escape_like_ensure_ascii() {
        let mut out = String::new();
        write_string("a\"\\\n\u{7f}é😀", &mut out);
        assert_eq!(out, "\"a\\\"\\\\\\n\\u007f\\u00e9\\ud83d\\ude00\"");
    }

    #[test]
    fn objects_sort_their_keys_and_numbers_normalize() {
        let value = J::obj([("b", J::Int(1)), ("a", J::Arr(vec![normalized_number(3.0), normalized_number(0.5), J::Null]))]);
        assert_eq!(value.dump(), "{\"a\":[3,0.5,null],\"b\":1}");
        assert_eq!(normalized_number(1e20), J::Digits("100000000000000000000".into()));
    }
}
