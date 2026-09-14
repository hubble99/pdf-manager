//! Persisted native evidence and unique correspondence. No publication authority.

use crate::discovery::discover_document;
use crate::identity::ObjectRegistry;
use crate::replacement::{file_hash, Candidate, EditExpectation};
use crate::resource_inspector::{InspectionOutcome, ResourceInspector};
use crate::{sha256_reader, PDFIUM_BUILD_IDENTITY, PDFIUM_LIBRARY_SHA256, PDFIUM_RENDER_VERSION};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::collections::BTreeMap;
use std::path::Path;

const INTEGRITY: &str = "REJECTED_COLLATERAL_INTEGRITY";
pub const VERIFIER_POLICY: &str = "edit-content-acceptance/v3";

/// A per-file bijection, never a resource-set-only image identity proof.
fn proven_image_bindings(page: &Value, count: usize) -> Result<BTreeMap<String, String>, &'static str> {
    let bindings = page["imageResourceBindings"].as_array().ok_or(INTEGRITY)?;
    let resources = if page["nativeMarkedOwnership"].is_array() { &page["markedContentProof"]["resources"] }
        else { &page["preservationResources"] };
    let dependencies = resources["/XObject"].as_array().ok_or(INTEGRITY)?;
    if count < 2 || bindings.len() != count || dependencies.len() != count {
        return Err(INTEGRITY);
    }
    let hash = |value: &Value| value.as_str().filter(|s| s.len() == 64 &&
        s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).map(str::to_owned).ok_or(INTEGRITY);
    let mut result = BTreeMap::new();
    for binding in bindings {
        if result.insert(hash(&binding["rawSha256"])?, hash(&binding["semanticSha256"])?).is_some() {
            return Err(INTEGRITY);
        }
    }
    let mut expected = dependencies.iter().map(hash).collect::<Result<Vec<_>, _>>()?;
    expected.sort();
    let mut actual = result.values().cloned().collect::<Vec<_>>();
    actual.sort();
    if actual != expected { return Err(INTEGRITY); }
    Ok(result)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub artifact_hash: String,
    pub revision: u64,
    pub pages: Vec<Value>,
    pub objects: Vec<ObjectEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEvidence {
    pub page: u16,
    pub index: usize,
    pub kind: String,
    pub text: Option<String>,
    pub quad: Vec<[f64; 2]>,
    pub style: Value,
    pub payload: Value,
}

fn finite(value: f32) -> Result<f64, &'static str> {
    if value.is_finite() {
        Ok(value as f64)
    } else {
        Err(INTEGRITY)
    }
}

fn color(value: PdfColor) -> Value {
    json!([value.red(), value.green(), value.blue(), value.alpha()])
}

/// Capture only clip paths whose fill rule cannot affect their meaning: one
/// closed, strictly convex polygon made exclusively from straight segments.
/// All curves, multiple subpaths, open paths, and degenerate geometry remain
/// unsupported because PDFium does not expose the clip fill rule.
fn simple_clip_path(object: &PdfPageObject<'_>) -> Result<Value, &'static str> {
    let Some(clip) = object.get_clip_path() else {
        return Ok(json!([]));
    };
    if clip.is_empty() {
        return Ok(json!([]));
    }
    if clip.len() != 1 {
        return Err(INTEGRITY);
    }
    let path = clip.get(0).map_err(|_| INTEGRITY)?;
    let segments = path.iter().collect::<Vec<_>>();
    if !(4..=33).contains(&segments.len())
        || segments[0].segment_type() != PdfPathSegmentType::MoveTo
        || segments[0].is_close()
        || segments[1..]
            .iter()
            .any(|segment| segment.segment_type() != PdfPathSegmentType::LineTo)
        || segments[..segments.len() - 1]
            .iter()
            .any(|segment| segment.is_close())
        || !segments.last().is_some_and(|segment| segment.is_close())
    {
        return Err(INTEGRITY);
    }
    let points = segments
        .iter()
        .map(|segment| Ok([finite(segment.x().value)?, finite(segment.y().value)?]))
        .collect::<Result<Vec<_>, &'static str>>()?;
    let first = points[0];
    let last = *points.last().ok_or(INTEGRITY)?;
    if !near(first[0], last[0], 0.000001, 0.0) || !near(first[1], last[1], 0.000001, 0.0) {
        return Err(INTEGRITY);
    }
    let vertices = &points[..points.len() - 1];
    let mut orientation = 0.0_f64;
    for index in 0..vertices.len() {
        let a = vertices[index];
        let b = vertices[(index + 1) % vertices.len()];
        let c = vertices[(index + 2) % vertices.len()];
        let cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if !cross.is_finite() || cross.abs() <= 0.000001 {
            return Err(INTEGRITY);
        }
        if orientation == 0.0 {
            orientation = cross.signum();
        } else if cross.signum() != orientation {
            return Err(INTEGRITY);
        }
    }
    Ok(json!(segments
        .iter()
        .map(|segment| json!({
            "kind": format!("{:?}", segment.segment_type()),
            "close": segment.is_close(),
            "point": [segment.x().value, segment.y().value],
        }))
        .collect::<Vec<_>>()))
}

/// Capture all evidence before mutation or from freshly reopened serialized bytes.
pub fn capture(
    pdfium: &Pdfium,
    path: &Path,
    inspector: &dyn ResourceInspector,
    revision: u64,
) -> Result<Snapshot, &'static str> {
    let artifact_hash = file_hash(path)?;
    let InspectionOutcome::Supported(resources) = inspector.inspect(path) else {
        return Err(INTEGRITY);
    };
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|_| INTEGRITY)?;
    if document.pages().len() > 256 {
        return Err(INTEGRITY);
    }
    let mut registry = ObjectRegistry::new("verification-only");
    let native =
        discover_document(&document, &resources, &mut registry, revision).map_err(|_| INTEGRITY)?;
    let mut pages = Vec::new();
    let mut objects = Vec::new();
    let resource_pages = resources["pages"].as_array().ok_or(INTEGRITY)?;
    if resource_pages.len() != native.pages.len() {
        return Err(INTEGRITY);
    }
    for descriptor in &native.pages {
        let resource_page = resource_pages
            .iter()
            .find(|page| page["pageIndex"].as_u64() == Some(descriptor.page_index as u64))
            .ok_or(INTEGRITY)?;
        let marked = resource_page["nativeMarkedOwnership"].as_array();
        let preservation = if marked.is_some() { &resource_page["markedContentProof"]["resources"] }
            else { &resource_page["preservationResources"] };
        if !preservation.is_object()
            || resource_page["pagePreservation"]
                .as_str()
                .is_none_or(|hash| hash.len() != 64)
        {
            return Err(INTEGRITY);
        }
        let geometry = [
            descriptor.width_pt,
            descriptor.height_pt,
            descriptor.crop_box.left,
            descriptor.crop_box.bottom,
            descriptor.crop_box.right,
            descriptor.crop_box.top,
            descriptor.rotation,
        ]
        .into_iter()
        .map(finite)
        .collect::<Result<Vec<_>, _>>()?;
        pages.push(
            json!({"geometry": geometry, "resources": preservation,
            "pagePreservation": resource_page["pagePreservation"]}),
        );
        let page = document
            .pages()
            .get(descriptor.page_index as _)
            .map_err(|_| INTEGRITY)?;
        if marked.is_some_and(|m| m.len() != page.objects().len() as usize) { return Err(INTEGRITY); }
        let image_count = page.objects().iter().filter(|o| o.as_image_object().is_some()).count();
        let mut image_bindings = if image_count > 1 {
            Some(proven_image_bindings(resource_page, image_count)?)
        } else { None };
        for (index, object) in page.objects().iter().enumerate() {
            if !object.is_active().map_err(|_| INTEGRITY)? {
                return Err(INTEGRITY);
            }
            let bounds = object.bounds().map_err(|_| INTEGRITY)?;
            let quad = vec![
                [finite(bounds.x1().value)?, finite(bounds.y1().value)?],
                [finite(bounds.x2().value)?, finite(bounds.y2().value)?],
                [finite(bounds.x3().value)?, finite(bounds.y3().value)?],
                [finite(bounds.x4().value)?, finite(bounds.y4().value)?],
            ];
            let matrix = object.matrix().map_err(|_| INTEGRITY)?;
            let matrix = [
                matrix.a(),
                matrix.b(),
                matrix.c(),
                matrix.d(),
                matrix.e(),
                matrix.f(),
            ]
            .into_iter()
            .map(finite)
            .collect::<Result<Vec<_>, _>>()?;
            let mut style = json!({"matrix": matrix});
            if let Some(marked) = marked {
                if marked[index]["kind"].as_i64() != Some(object.object_type() as i64) { return Err(INTEGRITY); }
                style["graphicsState"] = marked[index]["graphicsState"].clone();
                // Existing MCIDs are semantic marked-content membership, not
                // ordinal identity. Duplicate marks still need unique matching.
                style["markedContentId"] = marked[index]["markedContentId"].clone();
            }
            style["clipPath"] = simple_clip_path(&object)?;
            if object.as_text_object().is_some() || object.as_path_object().is_some() {
                style["strokeWidth"] =
                    json!(finite(object.stroke_width().map_err(|_| INTEGRITY)?.value)?);
                style["join"] = json!(format!("{:?}", object.line_join().map_err(|_| INTEGRITY)?));
                style["cap"] = json!(format!("{:?}", object.line_cap().map_err(|_| INTEGRITY)?));
                style["dashPhase"] =
                    json!(finite(object.dash_phase().map_err(|_| INTEGRITY)?.value)?);
                style["dashArray"] = json!(object
                    .dash_array()
                    .map_err(|_| INTEGRITY)?
                    .into_iter()
                    .map(|p| finite(p.value))
                    .collect::<Result<Vec<_>, _>>()?);
            }
            let (kind, text, payload) = if let Some(text) = object.as_text_object() {
                let descriptor = native
                    .text_objects
                    .iter()
                    .find(|text| {
                        text.page_index == descriptor.page_index
                            && text.source_scope.object_path == vec![index]
                    })
                    .ok_or(INTEGRITY)?;
                let font_id = descriptor.font.resource_object.as_ref().ok_or(INTEGRITY)?;
                let fonts = resource_page["fonts"].as_array().ok_or(INTEGRITY)?;
                let matches = fonts.iter().filter(|font| {
                    font["fontObject"].as_str() == Some(font_id.as_str()) && font["scope"] == "page"
                });
                let font = crate::resource_inspector::unique_font(matches).ok_or(INTEGRITY)?;
                let fingerprint = font["semanticSha256"]
                    .as_str()
                    .filter(|hash| hash.len() == 64)
                    .ok_or(INTEGRITY)?;
                style["fontSize"] = json!(finite(descriptor.font_size_pt)?);
                style["fillColor"] = color(text.fill_color().map_err(|_| INTEGRITY)?);
                style["strokeColor"] = color(text.stroke_color().map_err(|_| INTEGRITY)?);
                style["renderMode"] = json!(descriptor.render_mode);
                style["rotation"] = json!(finite(descriptor.rotation)?);
                style["font"] = json!({"name": descriptor.font.name, "family": descriptor.font.family,
                    "weight": descriptor.font.weight, "embedded": descriptor.font.embedded, "identity": fingerprint});
                ("text", Some(text.text()), Value::Null)
            } else if let Some(path) = object.as_path_object() {
                if path.has_transparency() && marked.is_none() {
                    return Err(INTEGRITY);
                }
                style["fillColor"] = color(path.fill_color().map_err(|_| INTEGRITY)?);
                style["strokeColor"] = color(path.stroke_color().map_err(|_| INTEGRITY)?);
                style["strokeWidth"] =
                    json!(finite(path.stroke_width().map_err(|_| INTEGRITY)?.value)?);
                style["join"] = json!(format!("{:?}", path.line_join().map_err(|_| INTEGRITY)?));
                style["cap"] = json!(format!("{:?}", path.line_cap().map_err(|_| INTEGRITY)?));
                style["dashPhase"] =
                    json!(finite(path.dash_phase().map_err(|_| INTEGRITY)?.value)?);
                style["dashArray"] = json!(path
                    .dash_array()
                    .map_err(|_| INTEGRITY)?
                    .into_iter()
                    .map(|p| finite(p.value))
                    .collect::<Result<Vec<_>, _>>()?);
                let segments = path.segments();
                let mut points = Vec::new();
                for segment in segments.iter() {
                    points.push(json!({"kind": format!("{:?}", segment.segment_type()), "close": segment.is_close(),
                        "point": [finite(segment.x().value)?, finite(segment.y().value)?]}));
                }
                (
                    "path",
                    None,
                    json!({"fill": format!("{:?}", path.fill_mode().map_err(|_| INTEGRITY)?),
                    "stroked": path.is_stroked().map_err(|_| INTEGRITY)?, "segments": points}),
                )
            } else if let Some(image) = object.as_image_object() {
                // Native pixels omit masks. A unique encoded stream binds each
                // named image to its complete resource identity, including masks.
                let dependencies = preservation["/XObject"]
                    .as_array()
                    .ok_or(INTEGRITY)?;
                if image_count == 1 && dependencies.len() != 1 {
                    return Err(INTEGRITY);
                }
                let width = image.width().map_err(|_| INTEGRITY)?;
                let height = image.height().map_err(|_| INTEGRITY)?;
                if width <= 0
                    || height <= 0
                    || (width as u64)
                        .saturating_mul(height as u64)
                        .saturating_mul(4)
                        > 64 * 1024 * 1024
                {
                    return Err(INTEGRITY);
                }
                let resource_identity = if let Some(bindings) = image_bindings.as_mut() {
                    let bytes = image.get_raw_image_data().map_err(|_| INTEGRITY)?;
                    if bytes.is_empty() || bytes.len() > 64 * 1024 * 1024 { return Err(INTEGRITY); }
                    let raw_hash = sha256_reader(&mut std::io::Cursor::new(bytes)).map_err(|_| INTEGRITY)?;
                    // Consume each binding exactly once; duplicate native images
                    // cannot stand in for a missing resource use.
                    json!(bindings.remove(&raw_hash).ok_or(INTEGRITY)?)
                } else { dependencies[0].clone() };
                let bitmap = image.get_raw_image().map_err(|_| INTEGRITY)?;
                let fingerprint = sha256_reader(&mut std::io::Cursor::new(bitmap.as_bytes()))
                    .map_err(|_| INTEGRITY)?;
                (
                    "image",
                    None,
                    json!({"width": width, "height": height, "pixels": fingerprint,
                    "resourceIdentity": resource_identity,
                    "colorSpace": format!("{:?}", image.color_space().map_err(|_| INTEGRITY)?),
                    "bitsPerPixel": image.bits_per_pixel().map_err(|_| INTEGRITY)?}),
                )
            } else {
                return Err(INTEGRITY);
            };
            objects.push(ObjectEvidence {
                page: descriptor.page_index,
                index,
                kind: kind.into(),
                text,
                quad,
                style,
                payload,
            });
        }
        if image_bindings.is_some_and(|bindings| !bindings.is_empty()) { return Err(INTEGRITY); }
    }
    drop(document);
    if file_hash(path)? != artifact_hash {
        return Err(INTEGRITY);
    }
    Ok(Snapshot {
        artifact_hash,
        revision,
        pages,
        objects,
    })
}

fn near(a: f64, b: f64, absolute: f64, relative: f64) -> bool {
    a.is_finite() && b.is_finite() && (a - b).abs() <= absolute + relative * a.abs().max(b.abs())
}

fn equivalent(a: &Value, b: &Value, key: &str) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => {
            let (Some(a), Some(b)) = (a.as_f64(), b.as_f64()) else {
                return false;
            };
            match key {
                "matrix" => near(a, b, 0.000001, 0.000001),
                "fontSize" => near(a, b, 0.0001, 0.0),
                "geometry" | "point" => near(a, b, 0.01, 0.0),
                _ => a.is_finite() && b.is_finite() && a == b,
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b, key))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| equivalent(a, b, key)))
        }
        _ => a == b,
    }
}

fn same_quad(a: &[[f64; 2]], b: &[[f64; 2]]) -> bool {
    a.len() == 4
        && b.len() == 4
        && a.iter()
            .zip(b)
            .all(|(a, b)| a.iter().zip(b).all(|(a, b)| near(*a, *b, 0.01, 0.0)))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub baseline_hash: String,
    pub candidate_hash: String,
    pub revision: u64,
    pub engine_build: String,
    pub engine_sha256: String,
    pub wrapper: String,
    pub policy: String,
    pub object_census: Vec<usize>,
    pub old_occurrences_before: usize,
    pub old_occurrences_after: usize,
    pub checks: Vec<String>,
}

/// Only produced by comparing saved/reopened evidence, never by regeneration.
pub struct VerifiedCandidate {
    candidate: Candidate,
    report: VerificationReport,
}

impl VerifiedCandidate {
    pub fn report(&self) -> &VerificationReport {
        &self.report
    }
    pub fn path(&self) -> &Path {
        &self.candidate.path
    }
    pub fn recheck(&self) -> Result<(), &'static str> {
        if file_hash(self.path())? != self.report.candidate_hash
            || fs::metadata(self.path()).map_err(|_| INTEGRITY)?.len() != self.candidate.bytes
        {
            Err(INTEGRITY)
        } else {
            Ok(())
        }
    }

    pub fn into_parts(self) -> (Candidate, VerificationReport) {
        (self.candidate, self.report)
    }
}

pub fn verify(
    pdfium: &Pdfium,
    candidate: Candidate,
    inspector: &dyn ResourceInspector,
) -> Result<VerifiedCandidate, &'static str> {
    let baseline = &candidate.baseline;
    if baseline.artifact_hash != candidate.baseline_sha256
        || baseline.revision != candidate.revision
        || file_hash(&candidate.path)? != candidate.sha256
    {
        return Err(INTEGRITY);
    }
    let reopened = capture(pdfium, &candidate.path, inspector, candidate.revision)?;
    let report = compare(baseline, &reopened, &candidate.expectation)?;
    if reopened.artifact_hash != candidate.sha256 {
        return Err(INTEGRITY);
    }
    let mut permissions = fs::metadata(&candidate.path)
        .map_err(|_| INTEGRITY)?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&candidate.path, permissions).map_err(|_| INTEGRITY)?;
    let verified = VerifiedCandidate { candidate, report };
    verified.recheck()?;
    Ok(verified)
}

pub fn compare(
    baseline: &Snapshot,
    candidate: &Snapshot,
    edit: &EditExpectation,
) -> Result<VerificationReport, &'static str> {
    if baseline
        .objects
        .iter()
        .chain(&candidate.objects)
        .any(|object| !has_supported_preservation_evidence(object))
    {
        return Err(INTEGRITY);
    }
    if baseline.revision != candidate.revision
        || baseline.pages.len() != candidate.pages.len()
        || !baseline
            .pages
            .iter()
            .zip(&candidate.pages)
            .all(|(a, b)| equivalent(a, b, "page"))
    {
        return Err(INTEGRITY);
    }
    let target = baseline
        .objects
        .iter()
        .position(|object| {
            object.page == edit.target.page_index
                && edit.target.object_path == vec![object.index]
                && object.text.as_deref() == Some(edit.target.text.as_str())
        })
        .ok_or(INTEGRITY)?;
    if baseline.objects.len() as i64 + edit.object_count_delta as i64
        != candidate.objects.len() as i64
    {
        return Err(INTEGRITY);
    }
    let mut correspondence = Vec::new();
    let mut used = vec![false; candidate.objects.len()];
    for (index, original) in baseline.objects.iter().enumerate() {
        if index == target && edit.removed {
            continue;
        }
        let expected_text = if index == target {
            Some(edit.resulting_text.as_str())
        } else {
            original.text.as_deref()
        };
        let matches: Vec<_> = candidate
            .objects
            .iter()
            .enumerate()
            .filter(|(_, other)| {
                original.page == other.page
                    && original.kind == other.kind
                    && expected_text == other.text.as_deref()
                    && equivalent(&original.style, &other.style, "style")
                    && equivalent(&original.payload, &other.payload, "payload")
                    // PDFium can recompute a text object's derived tight width
                    // after serialization even when its text, exact font,
                    // transform, and rendering style are unchanged. The matrix
                    // remains the positioning proof; non-text collateral still
                    // requires the independently measured quad.
                    && (index == target
                        || original.kind == "text"
                        || same_quad(&original.quad, &other.quad))
            })
            .map(|(index, _)| index)
            .collect();
        if matches.len() != 1 || used[matches[0]] {
            return Err(INTEGRITY);
        }
        used[matches[0]] = true;
        correspondence.push((index, matches[0]));
    }
    if used.iter().any(|used| !used) {
        return Err(INTEGRITY);
    }
    let occurrences = |text: &str| text.matches(&edit.old_text).count();
    if edit.old_text.is_empty() {
        return Err(INTEGRITY);
    }
    let before = baseline
        .objects
        .iter()
        .filter_map(|o| o.text.as_deref())
        .map(occurrences)
        .sum::<usize>();
    let expected = before - occurrences(&edit.target.text) + occurrences(&edit.resulting_text);
    let after = candidate
        .objects
        .iter()
        .filter_map(|o| o.text.as_deref())
        .map(occurrences)
        .sum::<usize>();
    if after != expected {
        return Err(INTEGRITY);
    }
    if !edit.removed {
        let (_, mapped) = correspondence
            .iter()
            .find(|(index, _)| *index == target)
            .ok_or(INTEGRITY)?;
        check_layout(
            baseline,
            &baseline.objects[target],
            &candidate.objects[*mapped],
        )?;
    }
    let object_census = (0..candidate.pages.len())
        .map(|page| {
            candidate
                .objects
                .iter()
                .filter(|o| o.page as usize == page)
                .count()
        })
        .collect();
    Ok(VerificationReport {
        baseline_hash: baseline.artifact_hash.clone(),
        candidate_hash: candidate.artifact_hash.clone(),
        revision: baseline.revision,
        engine_build: PDFIUM_BUILD_IDENTITY.into(),
        engine_sha256: PDFIUM_LIBRARY_SHA256.into(),
        wrapper: PDFIUM_RENDER_VERSION.into(),
        policy: VERIFIER_POLICY.into(),
        object_census,
        old_occurrences_before: before,
        old_occurrences_after: after,
        checks: [
            "target",
            "occurrences",
            "unique-correspondence",
            "font-identity",
            "geometry-style",
            "census",
            "resources",
            "layout",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
    })
}

fn has_supported_preservation_evidence(object: &ObjectEvidence) -> bool {
    match object.kind.as_str() {
        "text" => object.text.is_some() && object.payload.is_null(),
        "path" => {
            object.text.is_none()
                && object.payload["fill"].is_string()
                && object.payload["stroked"].is_boolean()
                && object.payload["segments"].is_array()
        }
        "image" => {
            object.text.is_none()
                && object.payload["width"]
                    .as_i64()
                    .is_some_and(|value| value > 0)
                && object.payload["height"]
                    .as_i64()
                    .is_some_and(|value| value > 0)
                && object.payload["pixels"]
                    .as_str()
                    .is_some_and(|value| value.len() == 64)
                && !object.payload["resourceIdentity"].is_null()
                && object.payload["colorSpace"].is_string()
                && object.payload["bitsPerPixel"]
                    .as_u64()
                    .is_some_and(|value| value > 0)
        }
        _ => false,
    }
}

// Convex native quads; uncertain/degenerate geometry rejects rather than reflowing.
fn area(polygon: &[[f64; 2]]) -> f64 {
    if polygon.len() < 3 {
        return 0.0;
    }
    polygon
        .iter()
        .zip(polygon.iter().cycle().skip(1))
        .take(polygon.len())
        .map(|(a, b)| a[0] * b[1] - b[0] * a[1])
        .sum::<f64>()
        / 2.0
}

fn intersection(subject: &[[f64; 2]], clip: &[[f64; 2]]) -> Result<f64, &'static str> {
    if subject.len() != 4
        || clip.len() != 4
        || subject.iter().chain(clip).flatten().any(|v| !v.is_finite())
    {
        return Err(INTEGRITY);
    }
    // Strictly disjoint finite envelopes prove zero intersection even when an
    // unchanged object's native quad is degenerate. Touching envelopes still
    // require the existing non-degenerate convex proof below.
    for axis in 0..2 {
        let range = |points: &[[f64; 2]]| points.iter().fold(
            (f64::INFINITY, f64::NEG_INFINITY),
            |(lo, hi), p| (lo.min(p[axis]), hi.max(p[axis])),
        );
        let (a, b) = range(subject);
        let (c, d) = range(clip);
        if b < c || d < a { return Ok(0.0); }
    }
    let orientation = area(clip).signum();
    if area(clip) == 0.0 || area(subject) == 0.0 {
        return Err(INTEGRITY);
    }
    let mut output = subject.to_vec();
    for (a, b) in clip.iter().zip(clip.iter().cycle().skip(1)).take(4) {
        let side = |p: [f64; 2]| {
            orientation * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]))
        };
        let input = std::mem::take(&mut output);
        if input.is_empty() {
            break;
        }
        let mut previous = *input.last().unwrap();
        for current in input {
            let before = side(previous);
            let after = side(current);
            if (before >= 0.0) != (after >= 0.0) {
                let t = before / (before - after);
                output.push([
                    previous[0] + t * (current[0] - previous[0]),
                    previous[1] + t * (current[1] - previous[1]),
                ]);
            }
            if after >= 0.0 {
                output.push(current);
            }
            previous = current;
        }
    }
    let result = area(&output).abs();
    if result.is_finite() {
        Ok(result)
    } else {
        Err(INTEGRITY)
    }
}

fn check_layout(
    baseline: &Snapshot,
    original: &ObjectEvidence,
    changed: &ObjectEvidence,
) -> Result<(), &'static str> {
    let geometry = baseline.pages[original.page as usize]["geometry"]
        .as_array()
        .ok_or(INTEGRITY)?;
    let get = |index: usize| geometry.get(index).and_then(Value::as_f64).ok_or(INTEGRITY);
    let (left, bottom, right, top) = (get(2)?, get(3)?, get(4)?, get(5)?);
    let page = [[left, bottom], [right, bottom], [right, top], [left, top]];
    // Compare escape itself, not only total visible area (which changes with text).
    let escaped = |quad: &[[f64; 2]]| -> Result<f64, &'static str> {
        Ok(area(quad).abs() - intersection(quad, &page)?)
    };
    if escaped(&changed.quad)? > escaped(&original.quad)? {
        return Err("REJECTED_LAYOUT");
    }
    for neighbor in baseline
        .objects
        .iter()
        .filter(|o| o.page == original.page && o.index != original.index)
    {
        if intersection(&changed.quad, &neighbor.quad)?
            > intersection(&original.quad, &neighbor.quad)?
        {
            return Err("REJECTED_LAYOUT");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::TargetEvidence;
    use crate::preflight::PreflightInput;
    use crate::viewport::{Point, Quad};

    #[test]
    fn disjoint_degenerate_neighbor_has_proven_zero_intersection() {
        let point = vec![[50.0, 50.0]; 4];
        assert_eq!(intersection(&quad(10.0, 20.0), &point), Ok(0.0));
        // Touching/overlapping degenerate bounds and malformed bounds still
        // cannot supply the convex-area proof. No empty-text exemption.
        assert!(intersection(&quad(10.0, 20.0), &vec![[15.0, 15.0]; 4]).is_err());
        assert!(intersection(&quad(10.0, 20.0), &vec![[20.0, 15.0]; 4]).is_err());
        assert!(intersection(&quad(10.0, 20.0), &vec![[f64::NAN, 50.0]; 4]).is_err());
    }

    #[test]
    fn marked_identity_disambiguates_only_distinct_preserved_marks() {
        let (mut before, edit) = fixture("word", "word", "ward");
        let mut other = before.objects[0].clone();
        other.index = 1;
        other.text = Some("kept".into());
        other.quad = quad(50.0, 60.0);
        other.style["markedContentId"] = json!(8);
        before.objects.push(other.clone());
        other.index = 2;
        other.style["markedContentId"] = json!(9);
        before.objects.push(other);
        let mut after = candidate(&before, &edit);
        after.objects.swap(1, 2);
        assert!(compare(&before, &after, &edit).is_ok());
        after.objects[1].style["markedContentId"] = json!(8);
        assert!(compare(&before, &after, &edit).is_err());
        before.objects[2].style["markedContentId"] = json!(8);
        assert!(compare(&before, &after, &edit).is_err());
    }

    fn quad(left: f64, right: f64) -> Vec<[f64; 2]> {
        vec![[left, 10.0], [right, 10.0], [right, 20.0], [left, 20.0]]
    }

    fn fixture(text: &str, old: &str, replacement: &str) -> (Snapshot, EditExpectation) {
        let target_quad = Quad {
            points: [
                Point { x: 10.0, y: 10.0 },
                Point { x: 20.0, y: 10.0 },
                Point { x: 20.0, y: 20.0 },
                Point { x: 10.0, y: 20.0 },
            ],
        };
        let mut registry = ObjectRegistry::new("verifier-tests");
        registry.begin_snapshot(4);
        let mut target = registry.register(0, vec![0], text.into(), target_quad, true, None);
        target.evidence = TargetEvidence::default();
        let input = PreflightInput {
            expected_text: text.into(),
            expected_old_text: old.into(),
            replacement_text: replacement.into(),
            utf16_start: 0,
            utf16_end: old.encode_utf16().count(),
        };
        let edit = EditExpectation::derive(&target, &input).unwrap();
        let object = ObjectEvidence {
            page: 0,
            index: 0,
            kind: "text".into(),
            text: Some(text.into()),
            quad: quad(10.0, 20.0),
            style: json!({"font": "exact-program", "fontSize": 12.0,
                "fillColor": [0, 0, 0, 255], "matrix": [1, 0, 0, 1, 10, 10]}),
            payload: Value::Null,
        };
        (
            Snapshot {
                artifact_hash: "a".repeat(64),
                revision: 4,
                pages: vec![json!({"geometry": [100, 100, 0, 0, 100, 100, 0], "resources": {}})],
                objects: vec![object],
            },
            edit,
        )
    }

    fn candidate(baseline: &Snapshot, edit: &EditExpectation) -> Snapshot {
        let mut result = baseline.clone();
        result.artifact_hash = "b".repeat(64);
        if edit.removed {
            result.objects.remove(0);
        } else {
            result.objects[0].text = Some(edit.resulting_text.clone());
        }
        result
    }

    // This helper exists only in the cfg(test) module. Production has no flag
    // or protocol field that can bypass preflight before verification.
    fn test_only_bypass_preflight(
        baseline: &Snapshot,
        candidate: &Snapshot,
        edit: &EditExpectation,
    ) -> Result<VerificationReport, &'static str> {
        compare(baseline, candidate, edit)
    }

    #[test]
    fn repeated_and_boundary_created_occurrences_use_the_planned_full_string() {
        for (text, old, replacement, before, after) in [
            ("word word", "word", "text", 2, 1),
            ("aaa", "aa", "a", 1, 1),
            ("word", "word", "", 1, 0),
            ("word", "word", "wordword", 1, 2),
        ] {
            let (baseline, edit) = fixture(text, old, replacement);
            let report = compare(&baseline, &candidate(&baseline, &edit), &edit).unwrap();
            assert_eq!(
                (report.old_occurrences_before, report.old_occurrences_after),
                (before, after)
            );
        }
    }

    #[test]
    fn untouched_other_page_text_and_font_program_are_mandatory() {
        let (mut baseline, edit) = fixture("word", "word", "text");
        baseline.pages.push(baseline.pages[0].clone());
        let mut other = baseline.objects[0].clone();
        other.page = 1;
        baseline.objects.push(other);
        let good = candidate(&baseline, &edit);
        assert!(compare(&baseline, &good, &edit).is_ok());
        let mut bad = good.clone();
        bad.objects[1].style["font"] = json!("same-Unicode-different-font-program");
        assert!(compare(&baseline, &bad, &edit).is_err());
        bad = good;
        bad.objects[1].text = Some("corrupted collateral".into());
        assert!(compare(&baseline, &bad, &edit).is_err());

        let mut derived_width = candidate(&baseline, &edit);
        derived_width.objects[1].quad[1][0] += 0.4;
        derived_width.objects[1].quad[2][0] += 0.4;
        assert!(compare(&baseline, &derived_width, &edit).is_ok());
        derived_width.objects[1].style["matrix"][4] = json!(10.1);
        assert!(compare(&baseline, &derived_width, &edit).is_err());
    }

    #[test]
    fn test_only_preflight_bypass_still_rejects_web_resource_and_font_corruption() {
        let (mut baseline, edit) = fixture("word", "word", "text");
        baseline.pages[0]["resources"] = json!({"/XObject": ["a".repeat(64)]});
        let good = candidate(&baseline, &edit);

        let mut corrupted_resource = good.clone();
        corrupted_resource.pages[0]["resources"] = json!({"/XObject": ["b".repeat(64)]});
        assert!(test_only_bypass_preflight(&baseline, &corrupted_resource, &edit).is_err());

        let mut corrupted_font = good;
        corrupted_font.objects[0].style["font"] = json!({"identity": "b".repeat(64)});
        assert!(test_only_bypass_preflight(&baseline, &corrupted_font, &edit).is_err());
    }

    #[test]
    fn exact_graphics_state_rejects_sub_color_precision_alpha_changes() {
        let (mut baseline, edit) = fixture("word", "word", "text");
        let mut other = baseline.objects[0].clone();
        other.index = 1;
        other.text = Some("other".into());
        other.quad = quad(80.0, 90.0);
        other.style["matrix"][4] = json!(80);
        baseline.objects.push(other);
        for object in &mut baseline.objects {
            object.style["graphicsState"] = json!([0.78431, 1.0, "/Normal"]);
        }
        let good = candidate(&baseline, &edit);
        assert!(compare(&baseline, &good, &edit).is_ok());
        for state in [json!([0.784311, 1.0, "/Normal"]), json!([0.78431, 1.0, "/Multiply"]), Value::Null] {
            let mut bad = good.clone();
            bad.objects[1].style["graphicsState"] = state;
            assert!(compare(&baseline, &bad, &edit).is_err());
        }
    }

    #[test]
    fn image_binding_requires_complete_unique_raw_to_semantic_bijection() {
        let a = "a".repeat(64); let b = "b".repeat(64);
        let c = "c".repeat(64); let d = "d".repeat(64);
        let page = json!({"preservationResources": {"/XObject": [c, d]},
            "imageResourceBindings": [{"rawSha256": a, "semanticSha256": c},
                {"rawSha256": b, "semanticSha256": d}]});
        let mut valid = proven_image_bindings(&page, 2).unwrap();
        assert_eq!(valid.remove(&a), Some(c));
        assert!(valid.remove(&a).is_none());
        assert_eq!(valid.remove(&b), Some(d));
        assert!(valid.is_empty());
        assert!(proven_image_bindings(&page, 3).is_err());
        for (field, value) in [("rawSha256", json!(a)), ("rawSha256", json!("z".repeat(64))),
            ("semanticSha256", json!("f".repeat(64))), ("semanticSha256", Value::Null)] {
            let mut bad = page.clone();
            bad["imageResourceBindings"][1][field] = value;
            assert!(proven_image_bindings(&bad, 2).is_err());
        }
        let mut missing = page;
        missing["imageResourceBindings"] = Value::Null;
        assert!(proven_image_bindings(&missing, 2).is_err());
    }

    #[test]
    fn supported_path_and_image_fingerprints_are_exact_and_unknown_opaque_rejects() {
        let (mut baseline, edit) = fixture("word", "word", "text");
        baseline.objects.push(ObjectEvidence {
            page: 0,
            index: 1,
            kind: "path".into(),
            text: None,
            quad: quad(30.0, 40.0),
            style: json!({"matrix": [1, 0, 0, 1, 0, 0], "fillColor": [0, 0, 0, 255]}),
            payload: json!({"fill": "Winding", "stroked": true,
                "segments": [{"kind": "LineTo", "close": false, "point": [30.0, 10.0]}]}),
        });
        baseline.objects.push(ObjectEvidence {
            page: 0,
            index: 2,
            kind: "image".into(),
            text: None,
            quad: quad(50.0, 60.0),
            style: json!({"matrix": [1, 0, 0, 1, 50, 10]}),
            payload: json!({"width": 10, "height": 10, "pixels": "a".repeat(64),
                "resourceIdentity": "b".repeat(64), "colorSpace": "DeviceRGB",
                "bitsPerPixel": 24}),
        });
        let good = candidate(&baseline, &edit);
        assert!(compare(&baseline, &good, &edit).is_ok());

        let mut changed_path = good.clone();
        changed_path.objects[1].payload["segments"][0]["point"][0] = json!(30.02);
        assert!(compare(&baseline, &changed_path, &edit).is_err());
        let mut changed_image = good.clone();
        changed_image.objects[2].payload["pixels"] = json!("c".repeat(64));
        assert!(compare(&baseline, &changed_image, &edit).is_err());

        // Swapping resource/mask ownership is unsafe even with identical native
        // pixels and the same complete page resource multiset.
        let mut two_images = baseline.clone();
        let mut second = two_images.objects[2].clone();
        second.index = 3;
        second.quad = quad(80.0, 90.0);
        second.style["matrix"] = json!([1, 0, 0, 1, 80, 10]);
        second.payload["resourceIdentity"] = json!("d".repeat(64));
        two_images.objects.push(second);
        let mut swapped = candidate(&two_images, &edit);
        assert!(compare(&two_images, &swapped, &edit).is_ok());
        swapped.objects[2].payload["resourceIdentity"] = json!("d".repeat(64));
        swapped.objects[3].payload["resourceIdentity"] = json!("b".repeat(64));
        assert!(compare(&two_images, &swapped, &edit).is_err());

        let mut opaque = baseline.clone();
        opaque.objects[1].kind = "opaque".into();
        assert!(compare(&opaque, &candidate(&opaque, &edit), &edit).is_err());
        let mut missing = baseline.clone();
        missing.objects[2].payload = Value::Null;
        assert!(compare(&missing, &candidate(&missing, &edit), &edit).is_err());
    }

    #[test]
    fn renumbering_is_not_identity_but_ambiguous_correspondence_rejects() {
        let (baseline, edit) = fixture("word", "word", "text");
        let mut good = candidate(&baseline, &edit);
        good.objects[0].index = 900;
        assert!(compare(&baseline, &good, &edit).is_ok());
        let mut reordered_baseline = baseline.clone();
        let mut neighbor = reordered_baseline.objects[0].clone();
        neighbor.index = 1;
        neighbor.text = Some("neighbor".into());
        neighbor.quad = quad(30.0, 40.0);
        reordered_baseline.objects.push(neighbor);
        let mut reordered = candidate(&reordered_baseline, &edit);
        reordered.objects.reverse();
        assert!(compare(&reordered_baseline, &reordered, &edit).is_ok());
        let mut ambiguous = baseline.clone();
        let mut duplicate = ambiguous.objects[0].clone();
        duplicate.index = 1;
        duplicate.text = Some("untouched".into());
        ambiguous.objects.push(duplicate.clone());
        duplicate.index = 2;
        ambiguous.objects.push(duplicate);
        assert!(compare(&ambiguous, &candidate(&ambiguous, &edit), &edit).is_err());
    }

    #[test]
    fn old_text_or_empty_looking_retained_object_does_not_prove_regeneration() {
        let (baseline, edit) = fixture("word", "word", "text");
        assert!(compare(&baseline, &baseline, &edit).is_err());
        let (baseline, edit) = fixture("word", "word", "");
        let mut whitespace = baseline.clone();
        whitespace.objects[0].text = Some(String::new());
        assert!(compare(&baseline, &whitespace, &edit).is_err());
    }

    #[test]
    fn exact_policy_boundaries_and_nonfinite_geometry() {
        assert!(near(0.0, 0.0001, 0.0001, 0.0));
        assert!(!near(0.0, 0.000100001, 0.0001, 0.0));
        assert!(near(0.0, 0.01, 0.01, 0.0));
        assert!(!near(0.0, 0.01000001, 0.01, 0.0));
        assert!(near(1000.0, 1000.001, 0.000001, 0.000001));
        assert!(!near(1000.0, 1000.002, 0.000001, 0.000001));
        assert!(!near(f64::NAN, 0.0, 0.01, 0.0));
        let (baseline, edit) = fixture("word", "word", "text");
        let mut bad = candidate(&baseline, &edit);
        bad.objects[0].quad[0][0] = f64::INFINITY;
        assert!(compare(&baseline, &bad, &edit).is_err());
        bad = candidate(&baseline, &edit);
        bad.objects[0].style["fillColor"][0] = json!(1);
        assert!(compare(&baseline, &bad, &edit).is_err());
    }

    #[test]
    fn layout_distinguishes_existing_overlap_growth_and_page_escape() {
        let (mut baseline, edit) = fixture("word", "word", "text");
        let mut neighbor = baseline.objects[0].clone();
        neighbor.index = 1;
        neighbor.text = Some("neighbor".into());
        neighbor.quad = quad(18.0, 30.0);
        baseline.objects.push(neighbor);
        let mut result = candidate(&baseline, &edit);
        assert!(compare(&baseline, &result, &edit).is_ok());
        result.objects[0].quad = quad(10.0, 17.0);
        assert!(compare(&baseline, &result, &edit).is_ok());
        result.objects[0].quad = quad(10.0, 21.0);
        assert_eq!(
            compare(&baseline, &result, &edit).unwrap_err(),
            "REJECTED_LAYOUT"
        );
        result.objects[0].quad = quad(-1.0, 17.0);
        assert_eq!(
            compare(&baseline, &result, &edit).unwrap_err(),
            "REJECTED_LAYOUT"
        );
    }
}
