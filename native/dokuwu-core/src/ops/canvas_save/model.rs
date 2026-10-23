//! The annotations the Canvas editor sends: a JSON array with one entry per PDF
//! page. An entry is `""` (nothing to draw), a string (a picture to lay over the
//! whole page) or an object with the page's objects. The schema is the one the
//! Python backend read; unknown fields are ignored and numbers may arrive as
//! numbers, numeric strings or `null` (which means "not given").
//!
//! The file can carry large base64 pictures, so it is read once and each page's
//! entry is parsed only when that page is stamped (`RawValue` keeps the text of
//! an entry without building a tree for it).

use std::borrow::Cow;
use std::collections::HashMap;

use serde::de::{self, Deserializer, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::Value;

use crate::error::{CoreError, CoreResult};

/// One entry of the array, as text.
pub type RawEntry<'a> = &'a RawValue;

/// Splits the annotations file into its per-page entries and checks each one
/// the way the old route did, so a bad file fails before the PDF is opened.
pub fn parse_entries(bytes: &[u8]) -> CoreResult<Vec<RawEntry<'_>>> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| CoreError::InvalidInput("Annotations file must be UTF-8 encoded JSON.".into()))?;
    let entries: Vec<RawEntry<'_>> = serde_json::from_str(text).map_err(|e| {
        if e.is_data() {
            CoreError::InvalidInput("Annotations JSON must be an array with one entry per PDF page.".into())
        } else {
            CoreError::InvalidInput(format!("Invalid annotations JSON at line {}, column {}.", e.line(), e.column()))
        }
    })?;
    for (index, entry) in entries.iter().enumerate() {
        match entry.get().trim_start().as_bytes().first() {
            Some(b'"') => {}
            Some(b'{') => {
                // Only an entry that mentions the legacy type is parsed here.
                if entry.get().contains("\"content_edit\"") {
                    let value: Value = serde_json::from_str(entry.get())
                        .map_err(|e| CoreError::InvalidInput(format!("Annotation entry at page index {index}: {e}")))?;
                    if contains_content_edit(&value) {
                        return Err(CoreError::InvalidInput(format!(
                            "Annotation entry at page index {index}: selectable text editing is unavailable in the stable Edit Canvas editor."
                        )));
                    }
                }
            }
            _ => {
                return Err(CoreError::InvalidInput(format!(
                    "Annotation entry at page index {index} must be a string, object, or empty string."
                )))
            }
        }
    }
    Ok(entries)
}

fn contains_content_edit(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.get("type").and_then(Value::as_str) == Some("content_edit") || map.values().any(contains_content_edit)
        }
        Value::Array(items) => items.iter().any(contains_content_edit),
        _ => false,
    }
}

/// What one page's entry holds.
pub enum PageEntry<'a> {
    /// Nothing to draw.
    Empty,
    /// A picture laid over the whole page (a data URL or plain base64).
    Raster(Cow<'a, str>),
    Page(Box<PageAnnotations<'a>>),
}

pub fn parse_page(entry: RawEntry<'_>) -> Result<PageEntry<'_>, String> {
    if entry.get().trim_start().starts_with('"') {
        let text: Cow<'_, str> = serde_json::from_str(entry.get()).map_err(|e| e.to_string())?;
        return Ok(if text.is_empty() { PageEntry::Empty } else { PageEntry::Raster(text) });
    }
    let page: PageAnnotations<'_> = serde_json::from_str(entry.get()).map_err(|e| e.to_string())?;
    Ok(PageEntry::Page(Box::new(page)))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct PageAnnotations<'a> {
    pub native_objects: Option<Vec<NativeObject<'a>>>,
    /// Older payloads: plain rectangles, ellipses and lines.
    pub shapes: Vec<NativeObject<'a>>,
    #[serde(deserialize_with = "number")]
    pub canvas_width: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub canvas_height: Option<f64>,
    #[serde(borrow)]
    pub image_assets: HashMap<String, Cow<'a, str>>,
    #[serde(borrow, deserialize_with = "text_or_null")]
    pub image_b64: Option<Cow<'a, str>>,
    pub raster_rect: Option<Vec<Value>>,
}

/// One object drawn in the editor. Which fields matter depends on `type`.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NativeObject<'a> {
    #[serde(rename = "type", deserialize_with = "text_or_null_owned")]
    pub kind: Option<String>,
    #[serde(deserialize_with = "text_or_null_owned")]
    pub id: Option<String>,
    #[serde(deserialize_with = "number")]
    pub x: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub y: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub width: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub height: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub angle: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub stroke_width: Option<f64>,
    #[serde(deserialize_with = "text_or_null_owned")]
    pub stroke_color: Option<String>,
    #[serde(deserialize_with = "text_or_null_owned")]
    pub fill_color: Option<String>,
    #[serde(deserialize_with = "number")]
    pub fill_opacity: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub opacity: Option<f64>,
    pub vector_corners: Option<Vec<Value>>,
    /// A line's `[x1, y1, x2, y2]`, or a pen's path commands.
    pub points: Option<Vec<Value>>,
    pub vector_path: Option<Vec<Value>>,
    pub transform_matrix: Option<Vec<Value>>,
    pub path_offset: Option<Vec<Value>>,

    // Text.
    #[serde(deserialize_with = "text_or_null_owned")]
    pub text: Option<String>,
    pub lines: Option<Vec<String>>,
    pub line_widths: Option<Vec<Value>>,
    #[serde(deserialize_with = "text_or_null_owned")]
    pub font_family: Option<String>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    #[serde(deserialize_with = "number")]
    pub font_size: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub font_weight: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub font_face_weight: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub synthetic_stroke_em: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub letter_spacing: Option<f64>,
    #[serde(deserialize_with = "number")]
    pub line_height: Option<f64>,
    #[serde(deserialize_with = "text_or_null_owned")]
    pub text_align: Option<String>,
    #[serde(deserialize_with = "text_or_null_owned")]
    pub color: Option<String>,

    // Images.
    #[serde(deserialize_with = "text_or_null_owned")]
    pub asset_id: Option<String>,
    #[serde(borrow, deserialize_with = "text_or_null")]
    pub src: Option<Cow<'a, str>>,
}

/// A number given as a number, a numeric string or a boolean; `null` and a
/// missing field are `None`.
fn number<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = Option<f64>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a number")
        }
        fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E> {
            Ok(Some(v))
        }
        fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
            Ok(Some(v as f64))
        }
        fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
            Ok(Some(v as f64))
        }
        fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E> {
            Ok(Some(if v { 1.0 } else { 0.0 }))
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            v.trim().parse::<f64>().map(Some).map_err(|_| E::custom(format!("{v:?} is not a number")))
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
    }
    d.deserialize_any(V)
}

fn text_or_null<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Cow<'de, str>>, D::Error> {
    Option::<Cow<'de, str>>::deserialize(d)
}

fn text_or_null_owned<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}

/// A number out of a JSON value (numbers and numeric strings).
pub fn value_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// All entries of a JSON array as numbers; `None` when any is not one.
pub fn numbers(values: &[Value]) -> Option<Vec<f64>> {
    values.iter().map(value_f64).collect()
}

/// Python's `str.splitlines`, which also breaks on \r, \v, \f, \x1c-\x1e,
/// \x85,   and  .
pub fn split_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        let breaks = matches!(c, '\n' | '\r' | '\u{0b}' | '\u{0c}' | '\u{1c}' | '\u{1d}' | '\u{1e}' | '\u{85}' | '\u{2028}' | '\u{2029}');
        if !breaks {
            continue;
        }
        lines.push(&text[start..i]);
        let mut end = i + c.len_utf8();
        if c == '\r' {
            if let Some(&(j, '\n')) = chars.peek() {
                chars.next();
                end = j + 1;
            }
        }
        start = end;
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_are_checked_like_the_old_route() {
        let ok = parse_entries(br#"["", "abc", {"native_objects": []}]"#).unwrap();
        assert_eq!(ok.len(), 3);
        let err = |text: &str| match parse_entries(text.as_bytes()) {
            Err(CoreError::InvalidInput(m)) => m,
            other => panic!("{other:?}"),
        };
        assert!(err("[{").starts_with("Invalid annotations JSON at line"));
        assert_eq!(err("{}"), "Annotations JSON must be an array with one entry per PDF page.");
        assert_eq!(err("[1]"), "Annotation entry at page index 0 must be a string, object, or empty string.");
        assert_eq!(err("[null]"), "Annotation entry at page index 0 must be a string, object, or empty string.");
        let legacy = err(r#"["", {"native_objects": [{"type": "content_edit"}]}]"#);
        assert!(legacy.contains("page index 1") && legacy.contains("selectable text editing is unavailable"));
        // The word alone, not as a type, is fine.
        assert!(parse_entries(br#"[{"native_objects": [{"type": "text", "text": "content_edit"}]}]"#).is_ok());
    }

    #[test]
    fn numbers_may_be_strings_and_null_means_missing() {
        let page = match parse_page(
            parse_entries(br#"[{"canvas_width": "200", "canvas_height": null, "native_objects": [{"type": "rect", "x": 1, "strokeWidth": "2.5"}]}]"#)
                .unwrap()[0],
        )
        .unwrap()
        {
            PageEntry::Page(p) => p,
            _ => panic!(),
        };
        assert_eq!(page.canvas_width, Some(200.0));
        assert_eq!(page.canvas_height, None);
        let object = &page.native_objects.as_ref().unwrap()[0];
        assert_eq!((object.x, object.stroke_width), (Some(1.0), Some(2.5)));
    }

    #[test]
    fn splitlines_matches_python() {
        assert_eq!(split_lines("a\nb\r\nc\rd"), vec!["a", "b", "c", "d"]);
        assert_eq!(split_lines("a\n"), vec!["a"]);
        assert_eq!(split_lines(""), Vec::<&str>::new());
        assert_eq!(split_lines("a\u{2028}b"), vec!["a", "b"]);
        assert_eq!(split_lines("\n\n"), vec!["", ""]);
    }
}
