use crate::identity::{ObjectRegistry, TargetEvidence, TargetRecord};
use crate::viewport::{Point, Quad, Rect};
use pdfium_render::prelude::{
    PdfColor, PdfDocument, PdfPageObjectCommon, PdfPageObjectType, PdfPageObjectsCommon,
    PdfPageTextObject,
};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiscovery {
    pub schema_version: String,
    pub read_only: bool,
    pub pages: Vec<NativePageDescriptor>,
    pub text_objects: Vec<NativeTextObjectDescriptor>,
    pub view_only_objects: Vec<ViewOnlyObjectDescriptor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePageDescriptor {
    pub page_index: u16,
    pub width_pt: f32,
    pub height_pt: f32,
    pub crop_box: Rect,
    pub rotation: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextObjectDescriptor {
    pub target_id: String,
    pub page_index: u16,
    pub native_object_identity: String,
    pub text: String,
    pub unicode_scalar_length: usize,
    pub bounds: Rect,
    pub rotated_quad: Quad,
    pub font: NativeFontBinding,
    pub font_size_pt: f32,
    pub fill_color: NativeColor,
    pub stroke_color: NativeColor,
    pub matrix: NativeMatrix,
    pub rotation: f32,
    pub render_mode: String,
    pub source_scope: SourceScope,
    pub editable: bool,
    pub view_only_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFontBinding {
    pub name: String,
    pub family: String,
    pub weight: String,
    pub embedded: bool,
    pub resource_subtype: Option<String>,
    pub resource_object: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeColor {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
    pub alpha: u8,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct NativeMatrix {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub e: f32,
    pub f: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceScope {
    pub kind: String,
    pub object_path: Vec<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewOnlyObjectDescriptor {
    pub page_index: u16,
    pub object_path: Vec<usize>,
    pub native_type: String,
    pub reason: String,
    pub rendered: bool,
    pub fabricated_text_object: bool,
}

pub fn discover_document(
    document: &PdfDocument<'_>,
    inspection: &Value,
    registry: &mut ObjectRegistry,
    revision: u64,
) -> Result<NativeDiscovery, String> {
    registry.begin_snapshot(revision);
    let mut result = NativeDiscovery {
        schema_version: "edit-content-inspection/v1".into(),
        read_only: true,
        pages: Vec::new(),
        text_objects: Vec::new(),
        view_only_objects: Vec::new(),
    };
    for page_index in 0..document.pages().len() {
        let descriptor_page_index = u16::try_from(page_index)
            .map_err(|_| "native page index exceeds the supported range".to_string())?;
        let page = document
            .pages()
            .get(page_index)
            .map_err(|_| "native page could not be inspected".to_string())?;
        let crop = page
            .boundaries()
            .crop()
            .or_else(|_| page.boundaries().media())
            .map_err(|_| "native crop box could not be inspected".to_string())?
            .bounds;
        result.pages.push(NativePageDescriptor {
            page_index: descriptor_page_index,
            width_pt: page.width().value,
            height_pt: page.height().value,
            crop_box: Rect {
                left: crop.left().value,
                bottom: crop.bottom().value,
                right: crop.right().value,
                top: crop.top().value,
            },
            rotation: page
                .rotation()
                .map_err(|_| "native page rotation could not be inspected".to_string())?
                .as_degrees(),
        });
        for (object_index, object) in page.objects().iter().enumerate() {
            let path = vec![object_index];
            match object.object_type() {
                PdfPageObjectType::Text => {
                    let text = object
                        .as_text_object()
                        .ok_or_else(|| "native text object conversion failed".to_string())?;
                    let has_clip_path = object.get_clip_path().is_some_and(|clip| !clip.is_empty());
                    result.text_objects.push(describe_text_object(
                        text,
                        descriptor_page_index,
                        path,
                        has_clip_path,
                        inspection,
                        registry,
                    )?);
                }
                object_type => result.view_only_objects.push(ViewOnlyObjectDescriptor {
                    page_index: descriptor_page_index,
                    object_path: path,
                    native_type: native_type_name(object_type).into(),
                    reason: "REJECTED_UNSUPPORTED_STRUCTURE".into(),
                    rendered: true,
                    fabricated_text_object: false,
                }),
            }
        }
    }
    Ok(result)
}

fn describe_text_object(
    text: &PdfPageTextObject<'_>,
    page_index: u16,
    object_path: Vec<usize>,
    has_clip_path: bool,
    inspection: &Value,
    registry: &mut ObjectRegistry,
) -> Result<NativeTextObjectDescriptor, String> {
    let native_text = text.text();
    let quad = text
        .bounds()
        .map_err(|_| "native text bounds could not be inspected".to_string())?;
    let rotated_quad = Quad {
        points: [
            Point {
                x: quad.x1().value,
                y: quad.y1().value,
            },
            Point {
                x: quad.x2().value,
                y: quad.y2().value,
            },
            Point {
                x: quad.x3().value,
                y: quad.y3().value,
            },
            Point {
                x: quad.x4().value,
                y: quad.y4().value,
            },
        ],
    };
    let bounds = Rect {
        left: quad.left().value,
        bottom: quad.bottom().value,
        right: quad.right().value,
        top: quad.top().value,
    };
    let font = text.font();
    let font_name = font.name();
    let font_family = font.family();
    let proven = inspection["pages"].as_array().and_then(|pages| pages.iter().find(|p|
        p["pageIndex"].as_u64() == Some(page_index as u64))).and_then(|page| {
            let object = page["nativeMarkedOwnership"].get(*object_path.first()?)?;
            if object["kind"] != 1 { return None; }
            let id = object["fontObject"].as_str()?;
            crate::resource_inspector::unique_font(page["fonts"].as_array()?.iter().filter(|font|
                font["scope"] == "page" && font["fontObject"].as_str() == Some(id)))
        });
    let matched_font = proven
        .or_else(|| matching_font(inspection, page_index, &font_name, &font_family))
        .or_else(|| matching_font_by_program(inspection, page_index, &font_name, &font_family, &font));
    let resource_subtype = matched_font
        .and_then(|value| value.get("subtype"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let resource_object = matched_font
        .and_then(|value| value.get("fontObject"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let type3 = resource_subtype.as_deref() == Some("/Type3");
    let fill = text
        .fill_color()
        .map_err(|_| "native fill color could not be inspected".to_string())?;
    let stroke = text
        .stroke_color()
        .map_err(|_| "native stroke color could not be inspected".to_string())?;
    let render_mode = format!("{:?}", text.render_mode());
    // Text that paints nothing (an OCR or accessibility layer over an image, ca 0) is not
    // what the reader sees: editing it would report success and change nothing visible.
    let invisible = paints_nothing(&render_mode, fill.alpha(), stroke.alpha());
    let view_only_reason = if type3 {
        Some("REJECTED_TYPE3".to_string())
    } else if invisible {
        Some(INVISIBLE_TEXT.to_string())
    } else if has_clip_path {
        Some("REJECTED_UNSUPPORTED_STRUCTURE".to_string())
    } else {
        None
    };
    let record: TargetRecord = registry.register(
        page_index,
        object_path.clone(),
        native_text.clone(),
        rotated_quad,
        !type3 && !has_clip_path && !invisible,
        view_only_reason.clone(),
    );
    registry.attach_evidence(
        &record.target_id,
        TargetEvidence {
            font_resource_object: resource_object.clone(),
            font_subtype: resource_subtype.clone(),
            glyph_coverage: matched_font
                .and_then(|value| value.get("glyphCoverage"))
                .cloned(),
            source_scope_kind: "page".into(),
            render_mode: render_mode.clone(),
            has_clip_path,
        },
    );
    let matrix = text
        .matrix()
        .map_err(|_| "native text matrix could not be inspected".to_string())?;
    Ok(NativeTextObjectDescriptor {
        target_id: record.target_id,
        page_index,
        native_object_identity: record.native_object_identity,
        unicode_scalar_length: native_text.chars().count(),
        text: native_text,
        bounds,
        rotated_quad,
        font: NativeFontBinding {
            name: font_name,
            family: font_family,
            weight: format!(
                "{:?}",
                font.weight()
                    .map_err(|_| "native font weight could not be inspected".to_string())?
            ),
            embedded: font
                .is_embedded()
                .map_err(|_| "native font embedding could not be inspected".to_string())?,
            resource_subtype,
            resource_object,
        },
        font_size_pt: text.scaled_font_size().value,
        fill_color: color(fill),
        stroke_color: color(stroke),
        matrix: NativeMatrix {
            a: matrix.a(),
            b: matrix.b(),
            c: matrix.c(),
            d: matrix.d(),
            e: matrix.e(),
            f: matrix.f(),
        },
        rotation: text.get_rotation_counter_clockwise_degrees(),
        render_mode,
        source_scope: SourceScope {
            kind: "page".into(),
            object_path,
        },
        editable: !type3 && !invisible,
        view_only_reason,
    })
}

/// View-only reason for text that paints nothing; also reported to the UI by hit tests.
pub const INVISIBLE_TEXT: &str = "INVISIBLE_TEXT";

/// Whether a text object's paint is empty: invisible render mode, or every painted channel
/// (fill, stroke or both, as the render mode says) fully transparent. Clip modes are left alone.
pub(crate) fn paints_nothing(render_mode: &str, fill_alpha: u8, stroke_alpha: u8) -> bool {
    match render_mode {
        "Invisible" => true,
        "FilledUnstroked" => fill_alpha == 0,
        "StrokedUnfilled" => stroke_alpha == 0,
        "FilledThenStroked" => fill_alpha == 0 && stroke_alpha == 0,
        _ => false,
    }
}

fn color(value: PdfColor) -> NativeColor {
    NativeColor {
        red: value.red(),
        green: value.green(),
        blue: value.blue(),
        alpha: value.alpha(),
    }
}

fn matching_font<'a>(
    inspection: &'a Value,
    page_index: u16,
    native_name: &str,
    native_family: &str,
) -> Option<&'a Value> {
    crate::resource_inspector::unique_font(named_fonts(inspection, page_index, native_name, native_family)?)
}

/// Fonts of the page whose base-font name equals the native name or family.
fn named_fonts<'a>(
    inspection: &'a Value,
    page_index: u16,
    native_name: &str,
    native_family: &str,
) -> Option<impl Iterator<Item = &'a Value>> {
    let normalize = |value: &str| {
        value
            .trim_start_matches('/')
            .split_once('+')
            .map(|(_, suffix)| suffix)
            .unwrap_or(value.trim_start_matches('/'))
            .replace([' ', '-'], "")
            .to_ascii_lowercase()
    };
    let names = [normalize(native_name), normalize(native_family)];
    let fonts = inspection
        .get("pages")?
        .as_array()?
        .iter()
        .find(|page| page.get("pageIndex").and_then(Value::as_u64) == Some(page_index as u64))?
        .get("fonts")?
        .as_array()?;
    Some(fonts.iter().filter(move |font| {
        ["effectiveBaseFont", "baseFont"]
            .iter()
            .filter_map(|key| font.get(key).and_then(Value::as_str))
            .map(&normalize)
            .any(|candidate| {
                names
                    .iter()
                    .any(|name| !name.is_empty() && *name == candidate)
            })
    }))
}

/// Several page fonts can carry one name (Quartz writes a subset per use). The embedded
/// font program tells them apart: the native font's bytes must equal the decoded program
/// of exactly one of the equally named dictionaries. Anything else stays unmatched.
fn matching_font_by_program<'a>(
    inspection: &'a Value,
    page_index: u16,
    native_name: &str,
    native_family: &str,
    font: &pdfium_render::prelude::PdfFont,
) -> Option<&'a Value> {
    const MAX_PROGRAM_BYTES: usize = 32 * 1024 * 1024;
    if !font.is_embedded().ok()? {
        return None;
    }
    let data = font.data().ok()?;
    if data.is_empty() || data.len() > MAX_PROGRAM_BYTES {
        return None;
    }
    let native_hash = crate::sha256_reader(&mut std::io::Cursor::new(&data)).ok()?;
    let has_program = |value: &Value| {
        value["fontPrograms"]
            .as_array()
            .is_some_and(|programs| programs.iter().any(|p| p["sha256"].as_str() == Some(&native_hash)))
    };
    let matching = named_fonts(inspection, page_index, native_name, native_family)?.filter(|candidate| {
        has_program(candidate)
            || candidate["descendants"]
                .as_array()
                .is_some_and(|descendants| descendants.iter().any(has_program))
    });
    let mut matching = matching.collect::<Vec<_>>();
    // Two dictionaries with one identical program are the same font resource only
    // when `unique_font` can prove it; otherwise the match stays ambiguous.
    matching.dedup_by(|a, b| a["fontObject"] == b["fontObject"]);
    crate::resource_inspector::unique_font(matching.into_iter())
}

fn native_type_name(object_type: PdfPageObjectType) -> &'static str {
    match object_type {
        PdfPageObjectType::Text => "text",
        PdfPageObjectType::Path => "path",
        PdfPageObjectType::Image => "image",
        PdfPageObjectType::Shading => "shading",
        PdfPageObjectType::XObjectForm => "form",
        PdfPageObjectType::Unsupported => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_only_proven_aliases_of_the_same_font() {
        let font = json!({"baseFont": "/Helvetica", "fontObject": "5:0",
            "semanticSha256": "a".repeat(64), "scope": "page"});
        let mut inspection = json!({"pages": [{"pageIndex": 0, "fonts": [font.clone(), font]}]});
        assert!(matching_font(&inspection, 0, "Helvetica", "Helvetica").is_some());
        for (field, value) in [
            ("fontObject", json!("6:0")),
            ("semanticSha256", json!("b".repeat(64))),
            ("semanticSha256", json!("z".repeat(64))),
            ("semanticSha256", Value::Null),
            ("fontObject", Value::Null),
        ] {
            let mut ambiguous = inspection.clone();
            ambiguous["pages"][0]["fonts"][1][field] = value;
            assert!(matching_font(&ambiguous, 0, "Helvetica", "Helvetica").is_none());
        }
        inspection["pages"][0]["fonts"][0]["semanticSha256"] = json!("z".repeat(64));
        inspection["pages"][0]["fonts"][1]["semanticSha256"] = json!("z".repeat(64));
        assert!(matching_font(&inspection, 0, "Helvetica", "Helvetica").is_none());
    }

    #[test]
    fn matches_type3_font_from_companion_inspection() {
        let inspection = json!({
            "pages": [{
                "pageIndex": 0,
                "fonts": [{"baseFont": "/ABCDEF+Demo-Font", "effectiveBaseFont": "/Demo-Font", "subtype": "/Type3"}]
            }]
        });
        assert_eq!(
            matching_font(&inspection, 0, "Demo Font", "Demo Font")
                .and_then(|font| font.get("subtype"))
                .and_then(Value::as_str),
            Some("/Type3")
        );
        assert_eq!(
            matching_font(&inspection, 1, "Demo Font", "Demo Font"),
            None
        );
    }
}

#[cfg(test)]
mod invisible_tests {
    use super::paints_nothing;

    #[test]
    fn only_text_with_no_visible_paint_is_invisible() {
        assert!(paints_nothing("Invisible", 255, 255));
        assert!(paints_nothing("FilledUnstroked", 0, 255));
        assert!(!paints_nothing("FilledUnstroked", 255, 0));
        assert!(paints_nothing("StrokedUnfilled", 255, 0));
        assert!(!paints_nothing("StrokedUnfilled", 0, 255));
        assert!(paints_nothing("FilledThenStroked", 0, 0));
        assert!(!paints_nothing("FilledThenStroked", 0, 1));
        assert!(!paints_nothing("FilledClipped", 0, 0), "clip modes are not judged here");
    }
}
