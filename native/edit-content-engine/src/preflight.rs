use crate::identity::{utf16_range_to_scalar, ObjectRegistry, ResolveError, TargetRecord};
use crate::viewport::{Quad, Rect};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const PREFLIGHT_SCHEMA: &str = "edit-content-preflight/v1";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightInput {
    pub expected_text: String,
    pub expected_old_text: String,
    pub replacement_text: String,
    pub utf16_start: usize,
    pub utf16_end: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationNeutralProof {
    pub original_sha256: String,
    pub accepted_sha256: String,
    pub accepted_revision: u64,
    pub accepted_history_length: usize,
    pub published_artifact_created: bool,
    pub mutation_attempted: bool,
    pub mutation_command_created: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    pub schema_version: String,
    pub eligible: bool,
    pub guard_reasons: Vec<String>,
    pub primary_guard_reason: Option<String>,
    pub target_id: String,
    pub resulting_text: Option<String>,
    pub unsupported_code_points: Vec<u32>,
    pub mutation_neutral: MutationNeutralProof,
}

pub fn evaluate_preflight(
    registry: &ObjectRegistry,
    revision: u64,
    target_id: &str,
    input: &PreflightInput,
    inspection: &Value,
    source_sha256: &str,
) -> PreflightReport {
    let proof = mutation_neutral_proof(revision, source_sha256);
    let record = match registry.resolve(revision, target_id) {
        Ok(record) => record,
        Err(error) => {
            let reason = match error {
                ResolveError::StaleRevision => "REJECTED_STALE_REVISION",
                ResolveError::ExpiredTarget | ResolveError::LegacyDescriptor => {
                    "REJECTED_TARGET_NOT_FOUND"
                }
            };
            return report(target_id, vec![reason.into()], None, Vec::new(), proof);
        }
    };
    if record.text != input.expected_text {
        return report(
            target_id,
            vec!["REJECTED_TARGET_NOT_FOUND".into()],
            None,
            Vec::new(),
            proof,
        );
    }
    let range = match utf16_range_to_scalar(&record.text, input.utf16_start, input.utf16_end) {
        Ok(range) => range,
        Err(_) => {
            return report(
                target_id,
                vec!["REJECTED_UNSUPPORTED_STRUCTURE".into()],
                None,
                Vec::new(),
                proof,
            )
        }
    };
    let characters: Vec<char> = record.text.chars().collect();
    let selected: String = characters[range.scalar_start..range.scalar_end]
        .iter()
        .collect();
    if selected != input.expected_old_text {
        return report(
            target_id,
            vec!["REJECTED_TARGET_NOT_FOUND".into()],
            None,
            Vec::new(),
            proof,
        );
    }
    let resulting_text = characters[..range.scalar_start]
        .iter()
        .chain(input.replacement_text.chars().collect::<Vec<_>>().iter())
        .chain(characters[range.scalar_end..].iter())
        .collect::<String>();

    let mut split = Vec::new();
    let mut unsupported = Vec::new();
    let mut type3 = Vec::new();
    let mut glyph = Vec::new();
    let mut collision = Vec::new();
    if visible_word_crosses_object(
        registry,
        revision,
        record,
        range.scalar_start,
        range.scalar_end,
    ) {
        split.push("REJECTED_SPLIT_TEXT_OBJECT".to_string());
    }
    if input.replacement_text.contains(['\n', '\r'])
        || requires_unsupported_shaping(&resulting_text)
        || record.evidence.source_scope_kind != "page"
        || record.evidence.has_clip_path
        || !supported_render_mode(&record.evidence.render_mode)
    {
        unsupported.push("REJECTED_UNSUPPORTED_STRUCTURE".to_string());
    }
    match record.evidence.font_subtype.as_deref() {
        Some("/Type3") => type3.push("REJECTED_TYPE3".to_string()),
        Some("/Type0" | "/Type1" | "/TrueType" | "/MMType1") => {}
        _ => unsupported.push("REJECTED_UNSUPPORTED_STRUCTURE".to_string()),
    }
    if record.view_only_reason.as_deref() == Some("REJECTED_TYPE3") {
        type3.push("REJECTED_TYPE3".to_string());
    } else if !record.editable {
        unsupported.push("REJECTED_UNSUPPORTED_STRUCTURE".to_string());
    }

    let mut unsupported_code_points = Vec::new();
    if type3.is_empty() {
        match glyph_coverage(registry, revision, record, &resulting_text) {
            GlyphVerdict::Covered => {}
            GlyphVerdict::Missing(points) => {
                unsupported_code_points = points;
                glyph.push("REJECTED_UNSUPPORTED_GLYPH".to_string());
            }
            GlyphVerdict::Unknown => {
                unsupported.push("REJECTED_UNSUPPORTED_STRUCTURE".to_string());
            }
        }
    }
    match collision_verdict(inspection, record.page_index) {
        CollisionVerdict::Safe => {}
        CollisionVerdict::Collision => {
            collision.push("REJECTED_FONT_RESOURCE_COLLISION".to_string())
        }
        CollisionVerdict::Unknown => unsupported.push("REJECTED_UNSUPPORTED_STRUCTURE".to_string()),
    }

    let mut reasons = Vec::new();
    for stage in [split, unsupported, type3, glyph, collision] {
        for reason in stage {
            if !reasons.contains(&reason) {
                reasons.push(reason);
            }
        }
    }
    report(
        target_id,
        reasons,
        Some(resulting_text),
        unsupported_code_points,
        proof,
    )
}

pub fn rejected_preflight_report(
    revision: u64,
    target_id: &str,
    source_sha256: &str,
    reason: &str,
) -> PreflightReport {
    report(
        target_id,
        vec![reason.into()],
        None,
        Vec::new(),
        mutation_neutral_proof(revision, source_sha256),
    )
}

fn mutation_neutral_proof(revision: u64, source_sha256: &str) -> MutationNeutralProof {
    MutationNeutralProof {
        original_sha256: source_sha256.into(),
        accepted_sha256: source_sha256.into(),
        accepted_revision: revision,
        accepted_history_length: 0,
        published_artifact_created: false,
        mutation_attempted: false,
        mutation_command_created: false,
    }
}

fn report(
    target_id: &str,
    guard_reasons: Vec<String>,
    resulting_text: Option<String>,
    unsupported_code_points: Vec<u32>,
    mutation_neutral: MutationNeutralProof,
) -> PreflightReport {
    PreflightReport {
        schema_version: PREFLIGHT_SCHEMA.into(),
        eligible: guard_reasons.is_empty(),
        primary_guard_reason: guard_reasons.first().cloned(),
        guard_reasons,
        target_id: target_id.into(),
        resulting_text,
        unsupported_code_points,
        mutation_neutral,
    }
}

fn supported_render_mode(value: &str) -> bool {
    matches!(
        value,
        "FilledUnstroked" | "StrokedUnfilled" | "FilledThenStroked"
    )
}

fn requires_unsupported_shaping(value: &str) -> bool {
    value.chars().any(|character| {
        let point = u32::from(character);
        matches!(
            point,
            0x0300..=0x036f
                | 0x0590..=0x08ff
                | 0x0900..=0x0dff
                | 0x200c..=0x200f
                | 0x202a..=0x202e
                | 0x2066..=0x2069
                | 0xfe00..=0xfe0f
                | 0xfe20..=0xfe2f
                | 0x1ab0..=0x1aff
                | 0x1dc0..=0x1dff
                | 0x1f3fb..=0x1f3ff
                | 0xe0100..=0xe01ef
        )
    })
}

fn visible_word_crosses_object(
    registry: &ObjectRegistry,
    revision: u64,
    target: &TargetRecord,
    scalar_start: usize,
    scalar_end: usize,
) -> bool {
    let target_chars: Vec<char> = target.text.chars().collect();
    if scalar_start == scalar_end
        || !target_chars[scalar_start..scalar_end]
            .iter()
            .any(|character| is_word(*character))
    {
        return false;
    }
    let touches_left = scalar_start == 0;
    let touches_right = scalar_end == target_chars.len();
    if !touches_left && !touches_right {
        return false;
    }
    let Ok(records) = registry.records_on_page(revision, target.page_index) else {
        return true;
    };
    let target_rect = quad_rect(target.quad);
    records.into_iter().any(|candidate| {
        if candidate.target_id == target.target_id || candidate.text.is_empty() {
            return false;
        }
        let candidate_rect = quad_rect(candidate.quad);
        if !same_text_line(target_rect, candidate_rect) {
            return false;
        }
        let tolerance = (target_rect.height().min(candidate_rect.height()) * 0.4).max(4.0);
        let left_gap = target_rect.left - candidate_rect.right;
        let right_gap = candidate_rect.left - target_rect.right;
        let joins_left = touches_left
            && candidate.text.chars().last().is_some_and(is_word)
            && target_chars
                .get(scalar_start)
                .is_some_and(|value| is_word(*value))
            && left_gap <= tolerance
            && candidate_rect.left < target_rect.left;
        let joins_right = touches_right
            && candidate.text.chars().next().is_some_and(is_word)
            && target_chars
                .get(scalar_end.saturating_sub(1))
                .is_some_and(|value| is_word(*value))
            && right_gap <= tolerance
            && candidate_rect.right > target_rect.right;
        let ambiguous_overlap = touches_left
            && touches_right
            && candidate.text.chars().any(is_word)
            && horizontal_overlap(target_rect, candidate_rect) > 0.0;
        joins_left || joins_right || ambiguous_overlap
    })
}

fn is_word(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '_' | '\'' | '’')
}

fn quad_rect(quad: Quad) -> Rect {
    Rect {
        left: quad
            .points
            .iter()
            .map(|point| point.x)
            .fold(f32::INFINITY, f32::min),
        bottom: quad
            .points
            .iter()
            .map(|point| point.y)
            .fold(f32::INFINITY, f32::min),
        right: quad
            .points
            .iter()
            .map(|point| point.x)
            .fold(f32::NEG_INFINITY, f32::max),
        top: quad
            .points
            .iter()
            .map(|point| point.y)
            .fold(f32::NEG_INFINITY, f32::max),
    }
}

fn same_text_line(left: Rect, right: Rect) -> bool {
    let overlap = left.top.min(right.top) - left.bottom.max(right.bottom);
    overlap > left.height().min(right.height()) * 0.4
}

fn horizontal_overlap(left: Rect, right: Rect) -> f32 {
    left.right.min(right.right) - left.left.max(right.left)
}

enum GlyphVerdict {
    Covered,
    Missing(Vec<u32>),
    Unknown,
}

fn glyph_coverage(
    registry: &ObjectRegistry,
    revision: u64,
    record: &TargetRecord,
    resulting_text: &str,
) -> GlyphVerdict {
    let mut existing: BTreeSet<u32> = record.text.chars().map(u32::from).collect();
    if let Some(identity) = record.evidence.font_resource_object.as_deref() {
        let Ok(records) = registry.records_on_page(revision, record.page_index) else {
            return GlyphVerdict::Unknown;
        };
        for candidate in records {
            if candidate.evidence.font_resource_object.as_deref() == Some(identity) {
                existing.extend(candidate.text.chars().map(u32::from));
            }
        }
    }
    let requested: BTreeSet<u32> = resulting_text
        .chars()
        .filter(|character| !character.is_whitespace())
        .map(u32::from)
        .collect();
    let Some(coverage) = record.evidence.glyph_coverage.as_ref() else {
        return if requested.is_subset(&existing) {
            GlyphVerdict::Covered
        } else {
            GlyphVerdict::Unknown
        };
    };
    let status = coverage.get("status").and_then(Value::as_str);
    if status != Some("proven") {
        return if requested.is_subset(&existing) {
            GlyphVerdict::Covered
        } else {
            GlyphVerdict::Unknown
        };
    }
    let Some(ranges) = coverage.get("ranges").and_then(Value::as_array) else {
        return GlyphVerdict::Unknown;
    };
    let mut missing = requested
        .difference(&existing)
        .copied()
        .filter(|point| {
            !ranges.iter().any(|range| {
                let Some(values) = range.as_array() else {
                    return false;
                };
                values.len() == 2
                    && values[0]
                        .as_u64()
                        .is_some_and(|start| start <= *point as u64)
                    && values[1].as_u64().is_some_and(|end| end >= *point as u64)
            })
        })
        .collect::<Vec<_>>();
    missing.sort_unstable();
    if missing.is_empty() {
        GlyphVerdict::Covered
    } else {
        GlyphVerdict::Missing(missing)
    }
}

enum CollisionVerdict {
    Safe,
    Collision,
    Unknown,
}

fn collision_verdict(inspection: &Value, page_index: u16) -> CollisionVerdict {
    if inspection.get("supported").and_then(Value::as_bool) != Some(true) {
        return CollisionVerdict::Unknown;
    }
    let Some(pages) = inspection.get("pages").and_then(Value::as_array) else {
        return CollisionVerdict::Unknown;
    };
    let Some(page) = pages
        .iter()
        .find(|page| page.get("pageIndex").and_then(Value::as_u64) == Some(page_index as u64))
    else {
        return CollisionVerdict::Unknown;
    };
    let Some(fonts) = page.get("fonts").and_then(Value::as_array) else {
        return CollisionVerdict::Unknown;
    };
    let shared = inspection
        .get("sharedResources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut buckets: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for font in fonts {
        if font.get("scope").and_then(Value::as_str) != Some("page") {
            return CollisionVerdict::Unknown;
        }
        let Some(resource_object) = font.get("resourceObject").and_then(Value::as_str) else {
            return CollisionVerdict::Unknown;
        };
        if font
            .get("resourceInheritedFrom")
            .is_some_and(|owner| !owner.is_null() && owner.as_str().is_none())
        {
            return CollisionVerdict::Unknown;
        }
        if let Some(shared_entry) = shared.iter().find(|entry| {
            entry.get("resourceObject").and_then(Value::as_str) == Some(resource_object)
        }) {
            let known = shared_entry
                .get("pageIndexes")
                .and_then(Value::as_array)
                .is_some_and(|indexes| {
                    indexes
                        .iter()
                        .any(|index| index.as_u64() == Some(page_index as u64))
                });
            if !known {
                return CollisionVerdict::Unknown;
            }
        }
        if add_font_buckets(font, &mut buckets).is_err() {
            return CollisionVerdict::Unknown;
        }
    }
    if buckets.values().any(|identities| identities.len() > 1) {
        CollisionVerdict::Collision
    } else {
        CollisionVerdict::Safe
    }
}

fn add_font_buckets(
    font: &Value,
    buckets: &mut BTreeMap<(String, String), BTreeSet<String>>,
) -> Result<(), ()> {
    let subtype = font.get("subtype").and_then(Value::as_str).ok_or(())?;
    let identity = font.get("fontObject").and_then(Value::as_str).ok_or(())?;
    let base_font = font.get("baseFont").and_then(Value::as_str).ok_or(())?;
    if base_font.is_empty() {
        return Err(());
    }
    let effective = font
        .get("collisionEffectiveBaseFont")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| collision_effective_base_font(base_font, subtype));
    buckets
        .entry((effective, subtype.into()))
        .or_default()
        .insert(identity.into());
    if let Some(descendants) = font.get("descendants").and_then(Value::as_array) {
        for descendant in descendants {
            add_font_buckets(descendant, buckets)?;
        }
    }
    Ok(())
}

fn collision_effective_base_font(base_font: &str, subtype: &str) -> String {
    let name = base_font.trim_start_matches('/');
    if matches!(subtype, "/Type0" | "/CIDFontType0" | "/CIDFontType2") {
        return name.into();
    }
    let bytes = name.as_bytes();
    if bytes.len() > 7
        && bytes[6] == b'+'
        && bytes[..6].iter().all(|value| value.is_ascii_uppercase())
    {
        name[7..].into()
    } else {
        name.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::TargetEvidence;
    use crate::viewport::Point;
    use serde_json::json;

    fn quad(left: f32, right: f32) -> Quad {
        Quad {
            points: [
                Point { x: left, y: 0.0 },
                Point { x: right, y: 0.0 },
                Point { x: right, y: 10.0 },
                Point { x: left, y: 10.0 },
            ],
        }
    }

    fn safe_inspection() -> Value {
        json!({
            "supported": true,
            "pages": [{
                "pageIndex": 0,
                "fonts": [{
                    "resourceObject": "10:0",
                    "scope": "page",
                    "fontObject": "11:0",
                    "baseFont": "/ABCDEF+Demo",
                    "collisionEffectiveBaseFont": "Demo",
                    "subtype": "/TrueType",
                    "descendants": []
                }]
            }],
            "sharedResources": []
        })
    }

    fn input(text: &str, old: &str, replacement: &str) -> PreflightInput {
        PreflightInput {
            expected_text: text.into(),
            expected_old_text: old.into(),
            replacement_text: replacement.into(),
            utf16_start: text.find(old).unwrap(),
            utf16_end: text.find(old).unwrap() + old.encode_utf16().count(),
        }
    }

    fn register(
        registry: &mut ObjectRegistry,
        path: usize,
        text: &str,
        quad: Quad,
        evidence: TargetEvidence,
    ) -> String {
        let record = registry.register(0, vec![path], text.into(), quad, true, None);
        registry.attach_evidence(&record.target_id, evidence);
        record.target_id
    }

    fn evidence() -> TargetEvidence {
        TargetEvidence {
            font_resource_object: Some("11:0".into()),
            font_subtype: Some("/TrueType".into()),
            glyph_coverage: Some(json!({"status": "proven", "ranges": [[32, 126]]})),
            source_scope_kind: "page".into(),
            render_mode: "FilledUnstroked".into(),
            has_clip_path: false,
        }
    }

    fn evaluate(
        registry: &ObjectRegistry,
        target: &str,
        input: &PreflightInput,
        inspection: &Value,
    ) -> PreflightReport {
        evaluate_preflight(registry, 0, target, input, inspection, &"a".repeat(64))
    }

    #[test]
    fn split_words_and_ambiguous_fragments_reject_without_joining() {
        for fragments in [
            vec!["o", "ff", "ice"],
            vec!["P", "emerintah"],
            vec!["ab", "cd"],
        ] {
            let mut registry = ObjectRegistry::new("split");
            registry.begin_snapshot(0);
            let mut left = 0.0;
            let mut targets = Vec::new();
            for (index, fragment) in fragments.iter().enumerate() {
                let right = left + fragment.len() as f32 * 5.0;
                targets.push(register(
                    &mut registry,
                    index,
                    fragment,
                    quad(left, right),
                    evidence(),
                ));
                left = right + 0.5;
            }
            let index = targets.len() / 2;
            let report = evaluate(
                &registry,
                &targets[index],
                &input(fragments[index], fragments[index], "x"),
                &safe_inspection(),
            );
            assert_eq!(
                report.primary_guard_reason.as_deref(),
                Some("REJECTED_SPLIT_TEXT_OBJECT")
            );
            assert!(!report.mutation_neutral.mutation_attempted);
        }
    }

    #[test]
    fn one_object_target_with_supported_glyphs_is_eligible() {
        let mut registry = ObjectRegistry::new("safe");
        registry.begin_snapshot(0);
        let target = register(
            &mut registry,
            0,
            "office today",
            quad(0.0, 60.0),
            evidence(),
        );
        let report = evaluate(
            &registry,
            &target,
            &input("office today", "office", "agency"),
            &safe_inspection(),
        );
        assert!(report.eligible);
        assert_eq!(report.resulting_text.as_deref(), Some("agency today"));
    }

    #[test]
    fn unsupported_structure_type3_clipping_and_reflow_fail_closed() {
        let cases = [
            (
                TargetEvidence {
                    font_subtype: Some("/Unknown".into()),
                    ..evidence()
                },
                "plain",
                "REJECTED_UNSUPPORTED_STRUCTURE",
            ),
            (
                TargetEvidence {
                    font_subtype: Some("/Type3".into()),
                    ..evidence()
                },
                "plain",
                "REJECTED_TYPE3",
            ),
            (
                TargetEvidence {
                    source_scope_kind: "form".into(),
                    ..evidence()
                },
                "plain",
                "REJECTED_UNSUPPORTED_STRUCTURE",
            ),
            (
                TargetEvidence {
                    render_mode: "FilledUnstrokedClipping".into(),
                    ..evidence()
                },
                "plain",
                "REJECTED_UNSUPPORTED_STRUCTURE",
            ),
            (
                TargetEvidence {
                    has_clip_path: true,
                    ..evidence()
                },
                "plain",
                "REJECTED_UNSUPPORTED_STRUCTURE",
            ),
        ];
        for (case_evidence, replacement, expected) in cases {
            let mut registry = ObjectRegistry::new("unsupported");
            registry.begin_snapshot(0);
            let target = register(&mut registry, 0, "simple", quad(0.0, 30.0), case_evidence);
            let report = evaluate(
                &registry,
                &target,
                &input("simple", "simple", replacement),
                &safe_inspection(),
            );
            assert!(report.guard_reasons.contains(&expected.to_string()));
        }
        let mut registry = ObjectRegistry::new("reflow");
        registry.begin_snapshot(0);
        let target = register(&mut registry, 0, "simple", quad(0.0, 30.0), evidence());
        let report = evaluate(
            &registry,
            &target,
            &input("simple", "simple", "two\nlines"),
            &safe_inspection(),
        );
        assert_eq!(
            report.primary_guard_reason.as_deref(),
            Some("REJECTED_UNSUPPORTED_STRUCTURE")
        );

        let shaping = evaluate(
            &registry,
            &target,
            &input("simple", "simple", "e\u{301}"),
            &safe_inspection(),
        );
        assert_eq!(
            shaping.primary_guard_reason.as_deref(),
            Some("REJECTED_UNSUPPORTED_STRUCTURE")
        );
    }

    #[test]
    fn exact_font_coverage_rejects_missing_and_unknown_without_substitution() {
        let mut registry = ObjectRegistry::new("glyph");
        registry.begin_snapshot(0);
        let target = register(&mut registry, 0, "Indonesia", quad(0.0, 45.0), evidence());
        let missing = evaluate(
            &registry,
            &target,
            &input("Indonesia", "Indonesia", "Indősia"),
            &safe_inspection(),
        );
        assert_eq!(
            missing.primary_guard_reason.as_deref(),
            Some("REJECTED_UNSUPPORTED_GLYPH")
        );
        assert_eq!(missing.unsupported_code_points, vec!['ő' as u32]);

        let unknown_evidence = TargetEvidence {
            glyph_coverage: Some(json!({"status": "unknown", "ranges": []})),
            ..evidence()
        };
        let unknown_target = register(&mut registry, 1, "Save", quad(60.0, 90.0), unknown_evidence);
        let unknown = evaluate(
            &registry,
            &unknown_target,
            &input("Save", "Save", "Saveq"),
            &safe_inspection(),
        );
        assert!(unknown
            .guard_reasons
            .contains(&"REJECTED_UNSUPPORTED_STRUCTURE".into()));
    }

    #[test]
    fn unknown_cmap_uses_only_characters_proven_by_the_exact_font_resource() {
        let unknown = TargetEvidence {
            glyph_coverage: Some(json!({"status": "unknown", "ranges": []})),
            ..evidence()
        };
        let mut registry = ObjectRegistry::new("exact-font-usage");
        registry.begin_snapshot(0);
        let target = register(&mut registry, 0, "Save", quad(0.0, 30.0), unknown.clone());
        register(&mut registry, 1, "draft", quad(40.0, 65.0), unknown.clone());
        let covered = evaluate(
            &registry,
            &target,
            &input("Save", "Save", "Saved"),
            &safe_inspection(),
        );
        assert!(covered.eligible);

        let mut distinct = unknown;
        distinct.font_resource_object = Some("12:0".into());
        let mut registry = ObjectRegistry::new("distinct-font-usage");
        registry.begin_snapshot(0);
        let target = register(&mut registry, 0, "Save", quad(0.0, 30.0), distinct);
        register(&mut registry, 1, "draft", quad(40.0, 65.0), evidence());
        let unproven = evaluate(
            &registry,
            &target,
            &input("Save", "Save", "Saved"),
            &safe_inspection(),
        );
        assert_eq!(
            unproven.primary_guard_reason.as_deref(),
            Some("REJECTED_UNSUPPORTED_STRUCTURE")
        );
    }

    #[test]
    fn collision_buckets_reject_distinct_dicts_but_not_aliases() {
        let mut inspection = safe_inspection();
        let first = inspection["pages"][0]["fonts"][0].clone();
        let mut second = first.clone();
        second["fontObject"] = json!("12:0");
        second["baseFont"] = json!("/UVWXYZ+Demo");
        for differing_field in [
            "encoding",
            "toUnicode",
            "fontPrograms",
            "widths",
            "cidToGidMap",
        ] {
            let mut case = inspection.clone();
            let mut differing = second.clone();
            differing[differing_field] = json!({"sha256": format!("different-{differing_field}")});
            case["pages"][0]["fonts"]
                .as_array_mut()
                .unwrap()
                .push(differing);
            assert!(matches!(
                collision_verdict(&case, 0),
                CollisionVerdict::Collision
            ));
        }
        inspection["pages"][0]["fonts"]
            .as_array_mut()
            .unwrap()
            .push(first);
        assert!(matches!(
            collision_verdict(&inspection, 0),
            CollisionVerdict::Safe
        ));

        assert_eq!(
            collision_effective_base_font("/ABCDEF+Demo", "/TrueType"),
            "Demo"
        );
        assert_eq!(
            collision_effective_base_font("/ABCDEF+Demo", "/Type0"),
            "ABCDEF+Demo"
        );
    }

    #[test]
    fn collision_scope_is_page_local_and_unknown_nested_scope_fails_closed() {
        let mut inspection = safe_inspection();
        let mut bad_page = inspection["pages"][0].clone();
        bad_page["pageIndex"] = json!(1);
        let mut duplicate = bad_page["fonts"][0].clone();
        duplicate["fontObject"] = json!("99:0");
        bad_page["fonts"].as_array_mut().unwrap().push(duplicate);
        inspection["pages"].as_array_mut().unwrap().push(bad_page);
        assert!(matches!(
            collision_verdict(&inspection, 0),
            CollisionVerdict::Safe
        ));
        assert!(matches!(
            collision_verdict(&inspection, 1),
            CollisionVerdict::Collision
        ));

        inspection["pages"][0]["fonts"][0]["scope"] = json!("page/XObject:/FormA");
        assert!(matches!(
            collision_verdict(&inspection, 0),
            CollisionVerdict::Unknown
        ));

        let mut inherited = safe_inspection();
        inherited["pages"][0]["fonts"][0]["resourceInheritedFrom"] = json!("2:0");
        inherited["sharedResources"] = json!([{"resourceObject": "10:0", "pageIndexes": [0, 2]}]);
        assert!(matches!(
            collision_verdict(&inherited, 0),
            CollisionVerdict::Safe
        ));
        inherited["sharedResources"][0]["pageIndexes"] = json!([2]);
        assert!(matches!(
            collision_verdict(&inherited, 0),
            CollisionVerdict::Unknown
        ));
        inherited["sharedResources"] = json!([]);
        inherited["pages"][0]["fonts"][0]["resourceInheritedFrom"] = json!(42);
        assert!(matches!(
            collision_verdict(&inherited, 0),
            CollisionVerdict::Unknown
        ));
    }

    #[test]
    fn guard_order_and_mutation_neutral_proof_are_deterministic() {
        let mut registry = ObjectRegistry::new("deterministic");
        registry.begin_snapshot(0);
        let target = register(
            &mut registry,
            0,
            "A",
            quad(0.0, 5.0),
            TargetEvidence {
                font_subtype: Some("/Type3".into()),
                render_mode: "InvisibleClipping".into(),
                ..evidence()
            },
        );
        register(&mut registry, 1, "B", quad(5.2, 10.2), evidence());
        let mut collision = safe_inspection();
        let mut duplicate = collision["pages"][0]["fonts"][0].clone();
        duplicate["fontObject"] = json!("12:0");
        collision["pages"][0]["fonts"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        let first = evaluate(&registry, &target, &input("A", "A", "Z"), &collision);
        let second = evaluate(&registry, &target, &input("A", "A", "Z"), &collision);
        assert_eq!(first, second);
        assert_eq!(
            first.guard_reasons,
            vec![
                "REJECTED_SPLIT_TEXT_OBJECT",
                "REJECTED_UNSUPPORTED_STRUCTURE",
                "REJECTED_TYPE3",
                "REJECTED_FONT_RESOURCE_COLLISION",
            ]
        );
        assert_eq!(
            first.mutation_neutral.original_sha256,
            first.mutation_neutral.accepted_sha256
        );
        assert_eq!(first.mutation_neutral.accepted_revision, 0);
        assert_eq!(first.mutation_neutral.accepted_history_length, 0);
        assert!(!first.mutation_neutral.published_artifact_created);
        assert!(!first.mutation_neutral.mutation_attempted);
        assert!(!first.mutation_neutral.mutation_command_created);

        let malformed = rejected_preflight_report(
            0,
            &target,
            &"a".repeat(64),
            "REJECTED_UNSUPPORTED_STRUCTURE",
        );
        assert_eq!(malformed.mutation_neutral.original_sha256, "a".repeat(64));
        assert_eq!(malformed.mutation_neutral.accepted_sha256, "a".repeat(64));
        assert!(!malformed.mutation_neutral.mutation_attempted);
    }
}
