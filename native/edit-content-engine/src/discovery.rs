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
                    result.text_objects.push(describe_text_object(
                        text,
                        descriptor_page_index,
                        path,
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
    let matched_font = matching_font(inspection, page_index, &font_name, &font_family);
    let resource_subtype = matched_font
        .and_then(|value| value.get("subtype"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let resource_object = matched_font
        .and_then(|value| value.get("fontObject"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let type3 = resource_subtype.as_deref() == Some("/Type3");
    let view_only_reason = type3.then(|| "REJECTED_TYPE3".to_string());
    let render_mode = format!("{:?}", text.render_mode());
    let record: TargetRecord = registry.register(
        page_index,
        object_path.clone(),
        native_text.clone(),
        rotated_quad,
        !type3,
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
        },
    );
    let fill = text
        .fill_color()
        .map_err(|_| "native fill color could not be inspected".to_string())?;
    let stroke = text
        .stroke_color()
        .map_err(|_| "native stroke color could not be inspected".to_string())?;
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
        editable: !type3,
        view_only_reason,
    })
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
    let mut matches = fonts.iter().filter(|font| {
        ["effectiveBaseFont", "baseFont"]
            .iter()
            .filter_map(|key| font.get(key).and_then(Value::as_str))
            .map(&normalize)
            .any(|candidate| {
                names
                    .iter()
                    .any(|name| !name.is_empty() && *name == candidate)
            })
    });
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first)
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
