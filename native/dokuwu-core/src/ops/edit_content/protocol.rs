//! The frontend's Edit Content contract: command envelope, strict payloads
//! and reply shapes.
//!
//! Requests are validated as strictly as the old HTTP surface was: unknown
//! fields are refused, identifiers and numbers keep their limits, and each
//! payload is rebuilt from its typed struct so the worker only ever sees the
//! fields this contract names.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::coordinator::SessionView;
use super::state::Outcome;

pub const REQUEST_SCHEMA: &str = "edit-content-request/v1";
pub const REPLY_SCHEMA: &str = "edit-content-reply/v1";
const MAX_TEXT_CHARS: usize = 131_072;
const MAX_ID_CHARS: usize = 128;

/// A request that is not valid for this contract (never reaches a session).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidRequest(pub String);

impl InvalidRequest {
    fn new(message: &str) -> Self {
        Self(message.to_owned())
    }
}

impl std::fmt::Display for InvalidRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// `^[A-Za-z0-9_-]{1,128}$`
pub fn is_opaque_id(value: &str) -> bool {
    (1..=MAX_ID_CHARS).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Command {
    Inspect,
    Render,
    Apply,
    History,
    Save,
    Close,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Envelope {
    pub schema_version: String,
    pub request_id: String,
    pub session_id: String,
    pub command: Command,
    pub expected_accepted_revision: i64,
    #[serde(default)]
    pub target_id: Option<String>,
    pub payload: Map<String, Value>,
}

impl Envelope {
    pub fn parse(value: Value) -> Result<Self, InvalidRequest> {
        let envelope: Envelope = serde_json::from_value(value).map_err(|e| InvalidRequest(format!("Invalid Edit Content request: {e}")))?;
        if envelope.schema_version != REQUEST_SCHEMA
            || !is_opaque_id(&envelope.request_id)
            || !is_opaque_id(&envelope.session_id)
            || envelope.expected_accepted_revision < 0
            || envelope.target_id.as_deref().is_some_and(|id| !is_opaque_id(id))
        {
            return Err(InvalidRequest::new("Invalid Edit Content request identity."));
        }
        Ok(envelope)
    }

    fn typed<T: for<'de> Deserialize<'de>>(&self) -> Result<T, InvalidRequest> {
        serde_json::from_value(Value::Object(self.payload.clone())).map_err(|e| InvalidRequest(format!("Invalid request payload: {e}")))
    }

    pub fn require_target(&self, message: &str) -> Result<&str, InvalidRequest> {
        self.target_id.as_deref().ok_or_else(|| InvalidRequest::new(message))
    }
}

fn within(text: &str, min: usize) -> bool {
    let count = text.chars().count();
    count >= min && count <= MAX_TEXT_CHARS
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HitPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ViewportSize {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CropBox {
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
    pub top: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Rotation {
    #[serde(rename = "0")]
    R0,
    #[serde(rename = "90")]
    R90,
    #[serde(rename = "180")]
    R180,
    #[serde(rename = "270")]
    R270,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ViewportTransform {
    pub crop_box: CropBox,
    pub rotation: Rotation,
    pub zoom: f64,
    pub device_pixel_ratio: f64,
    pub scroll_css: HitPoint,
    pub viewport_origin_css: HitPoint,
    pub viewport_size_css: ViewportSize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HitTestOperation {
    #[serde(rename = "hitTest")]
    HitTest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CoordinateSpace {
    #[serde(rename = "viewportCss")]
    ViewportCss,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HitTestPayload {
    pub operation: HitTestOperation,
    pub page_index: i64,
    pub coordinate_space: CoordinateSpace,
    pub point: HitPoint,
    pub viewport_transform: ViewportTransform,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ValidateRangeOperation {
    #[serde(rename = "validateTextRange")]
    ValidateTextRange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ValidateRangePayload {
    pub operation: ValidateRangeOperation,
    pub utf16_start: i64,
    pub utf16_end: i64,
    pub expected_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RenderPayload {
    pub page_index: i64,
    pub width_px: i64,
    pub height_px: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EditPayload {
    pub expected_text: String,
    pub expected_old_text: String,
    pub replacement_text: String,
    pub utf16_start: i64,
    pub utf16_end: i64,
}

impl EditPayload {
    fn validate(&self) -> Result<(), InvalidRequest> {
        if !within(&self.expected_text, 0)
            || !within(&self.expected_old_text, 1)
            || !within(&self.replacement_text, 0)
            || self.utf16_start < 0
            || self.utf16_end < 1
        {
            return Err(InvalidRequest::new("Invalid edit payload."));
        }
        Ok(())
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("plain struct")
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyPayload {
    edit: EditPayload,
}

#[derive(Debug, Deserialize)]
pub enum PreflightOperation {
    #[serde(rename = "preflight")]
    Preflight,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreflightPayload {
    #[allow(dead_code)]
    operation: PreflightOperation,
    edit: EditPayload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryAction {
    Undo,
    Redo,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HistoryPayload {
    action: HistoryAction,
    #[serde(default)]
    pending_draft: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavePayload {
    #[serde(default)]
    draft: Option<EditPayload>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CloseDecision {
    Discard,
    #[default]
    None,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ClosePayload {
    #[serde(default)]
    pending_draft: bool,
    #[serde(default)]
    decision: CloseDecision,
}

/// What a validated envelope asks for.
#[derive(Debug)]
pub enum Request {
    /// Discovery of the accepted document.
    Discovery,
    HitTest(Value),
    ValidateRange { target_id: String, payload: Value },
    Preflight { target_id: String, edit: Value },
    Render { page_index: i64, width_px: i64, height_px: i64 },
    Apply { target_id: String, edit: Value },
    History { action: HistoryAction, pending_draft: bool },
    Save { target_id: Option<String>, draft: Option<Value> },
    Close { pending_draft: bool, decision: CloseDecision },
}

fn ranged(value: i64, min: i64, max: i64) -> Result<i64, InvalidRequest> {
    if (min..=max).contains(&value) {
        Ok(value)
    } else {
        Err(InvalidRequest::new("Invalid request payload: value out of range."))
    }
}

fn finite_positive(value: f64) -> Result<(), InvalidRequest> {
    if value.is_finite() && value > 0.0 {
        Ok(())
    } else {
        Err(InvalidRequest::new("Invalid request payload: value must be positive."))
    }
}

impl Request {
    pub fn from_envelope(envelope: &Envelope) -> Result<Self, InvalidRequest> {
        match envelope.command {
            Command::Inspect => {
                let operation = envelope.payload.get("operation").and_then(Value::as_str);
                match operation {
                    Some("hitTest") => {
                        let payload: HitTestPayload = envelope.typed()?;
                        ranged(payload.page_index, 0, 255)?;
                        let view = &payload.viewport_transform;
                        finite_positive(view.zoom)?;
                        finite_positive(view.device_pixel_ratio)?;
                        finite_positive(view.viewport_size_css.x)?;
                        finite_positive(view.viewport_size_css.y)?;
                        Ok(Self::HitTest(serde_json::to_value(&payload).expect("plain struct")))
                    }
                    Some("validateTextRange") => {
                        let payload: ValidateRangePayload = envelope.typed()?;
                        if payload.utf16_start < 0 || payload.utf16_end < 0 || !within(&payload.expected_text, 0) {
                            return Err(InvalidRequest::new("Invalid request payload."));
                        }
                        let target_id = envelope.require_target("Range validation requires targetId.")?.to_owned();
                        Ok(Self::ValidateRange { target_id, payload: serde_json::to_value(&payload).expect("plain struct") })
                    }
                    Some("preflight") => {
                        let target_id = envelope.require_target("Preflight requires targetId.")?.to_owned();
                        let payload: PreflightPayload = envelope.typed()?;
                        payload.edit.validate()?;
                        Ok(Self::Preflight { target_id, edit: payload.edit.to_value() })
                    }
                    _ if !envelope.payload.is_empty() => Err(InvalidRequest::new("Unsupported object operation.")),
                    _ => Ok(Self::Discovery),
                }
            }
            Command::Render => {
                let payload: RenderPayload = envelope.typed()?;
                ranged(payload.page_index, 0, 255)?;
                ranged(payload.width_px, 1, 4096)?;
                ranged(payload.height_px, 1, 4096)?;
                Ok(Self::Render { page_index: payload.page_index, width_px: payload.width_px, height_px: payload.height_px })
            }
            Command::Apply => {
                let target_id = envelope.require_target("Apply requires targetId.")?.to_owned();
                let payload: ApplyPayload = envelope.typed()?;
                payload.edit.validate()?;
                Ok(Self::Apply { target_id, edit: payload.edit.to_value() })
            }
            Command::History => {
                let payload: HistoryPayload = envelope.typed()?;
                Ok(Self::History { action: payload.action, pending_draft: payload.pending_draft })
            }
            Command::Save => {
                let payload: SavePayload = envelope.typed()?;
                if let Some(draft) = &payload.draft {
                    draft.validate()?;
                    envelope.require_target("Save with a draft requires targetId.")?;
                }
                Ok(Self::Save { target_id: envelope.target_id.clone(), draft: payload.draft.as_ref().map(EditPayload::to_value) })
            }
            Command::Close => {
                let payload: ClosePayload = envelope.typed()?;
                Ok(Self::Close { pending_draft: payload.pending_draft, decision: payload.decision })
            }
        }
    }
}

pub fn reply(
    request_id: &str,
    session_id: &str,
    status: &str,
    revision: i64,
    result: Value,
    guard_reason: Option<&str>,
    error: Option<&str>,
) -> Value {
    let mut reply = serde_json::json!({
        "schemaVersion": REPLY_SCHEMA,
        "requestId": request_id,
        "sessionId": session_id,
        "status": status,
        "acceptedRevision": revision,
        "result": result,
    });
    let map = reply.as_object_mut().expect("object literal");
    if let Some(reason) = guard_reason {
        map.insert("guardReason".into(), reason.into());
    }
    if let Some(error) = error {
        map.insert("error".into(), error.into());
    }
    reply
}

pub fn accepted_read_reply(request_id: &str, session_id: &str, revision: i64, result: Value) -> Value {
    reply(request_id, session_id, "accepted", revision, result, None, None)
}

pub fn outcome_reply(outcome: &Outcome, view: &SessionView) -> Value {
    reply(
        &outcome.request_id,
        &view.session_id,
        "accepted",
        outcome.revision,
        serde_json::json!({
            "state": view,
            "outputId": outcome.output_id,
            "clearDraft": outcome.clear_draft,
        }),
        None,
        None,
    )
}

/// The reply to a request id seen before: its recorded outcome, never a replay.
pub fn duplicate(previous: &Value) -> Value {
    let mut copy = previous.clone();
    let map = copy.as_object_mut().expect("replies are objects");
    let original_status = map.get("status").cloned().unwrap_or(Value::Null);
    let original_result = map.get("result").cloned().unwrap_or_else(|| Value::Object(Map::new()));
    map.insert("status".into(), "duplicate".into());
    map.insert("result".into(), serde_json::json!({ "originalStatus": original_status, "originalResult": original_result }));
    copy
}

/// What the user is told for a stable rejection reason.
pub fn safe_error(reason: &str) -> &'static str {
    match reason {
        "REJECTED_STALE_REVISION" => "The document changed. Refresh the page and select the text again.",
        "REJECTED_STALE_TARGET" => "The selected text is no longer current. Select it again.",
        "REJECTED_SPLIT_TEXT_OBJECT" => "This word spans multiple native text objects and cannot be edited safely.",
        "REJECTED_TYPE3" => "Text using a Type 3 font is view-only in Edit Content V1.",
        "REJECTED_UNSUPPORTED_GLYPH" => "The existing font cannot represent the replacement text.",
        "REJECTED_FONT_RESOURCE_COLLISION" => "This page has colliding font resources and cannot be regenerated safely.",
        "REJECTED_LAYOUT" => "The replacement would require unsupported layout changes.",
        "REJECTED_COLLATERAL_INTEGRITY" => "The regenerated PDF did not preserve untouched content exactly enough.",
        "REJECTED_PERSISTENCE" => "The replacement did not persist correctly after reopening the PDF.",
        "REJECTED_PUBLICATION" => "The verified PDF could not be published safely.",
        _ => "This edit is unsupported or could not be verified safely.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(command: &str, payload: Value, target: Option<&str>) -> Value {
        let mut value = json!({
            "schemaVersion": REQUEST_SCHEMA, "requestId": "req-1", "sessionId": "s".repeat(32),
            "command": command, "expectedAcceptedRevision": 0, "payload": payload,
        });
        if let Some(target) = target {
            value["targetId"] = target.into();
        }
        value
    }

    fn edit() -> Value {
        json!({"expectedText": "a b", "expectedOldText": "a", "replacementText": "c", "utf16Start": 0, "utf16End": 1})
    }

    fn request(command: &str, payload: Value, target: Option<&str>) -> Result<Request, InvalidRequest> {
        Request::from_envelope(&Envelope::parse(envelope(command, payload, target))?)
    }

    #[test]
    fn the_envelope_is_strict() {
        assert!(Envelope::parse(envelope("inspect", json!({}), None)).is_ok());
        let mut extra = envelope("inspect", json!({}), None);
        extra["unexpected"] = json!(1);
        assert!(Envelope::parse(extra).is_err());
        for (key, value) in [
            ("schemaVersion", json!("edit-content-request/v2")),
            ("requestId", json!("bad id")),
            ("requestId", json!("x".repeat(129))),
            ("sessionId", json!("../etc")),
            ("command", json!("shutdown")),
            ("expectedAcceptedRevision", json!(-1)),
            ("targetId", json!("a/b")),
        ] {
            let mut bad = envelope("inspect", json!({}), None);
            bad[key] = value;
            assert!(Envelope::parse(bad).is_err(), "{key}");
        }
        let mut missing = envelope("inspect", json!({}), None);
        missing.as_object_mut().unwrap().remove("payload");
        assert!(Envelope::parse(missing).is_err());
    }

    #[test]
    fn inspect_chooses_the_operation_and_refuses_unknown_ones() {
        assert!(matches!(request("inspect", json!({}), None), Ok(Request::Discovery)));
        assert!(request("inspect", json!({"operation": "other"}), None).is_err());
        assert!(request("inspect", json!({"anything": 1}), None).is_err());
        let range = json!({"operation": "validateTextRange", "utf16Start": 0, "utf16End": 2, "expectedText": "ab"});
        assert!(request("inspect", range.clone(), None).is_err(), "needs a target");
        assert!(matches!(request("inspect", range, Some("t1")), Ok(Request::ValidateRange { .. })));
        assert!(request("inspect", json!({"operation": "preflight", "edit": edit()}), None).is_err());
        assert!(matches!(request("inspect", json!({"operation": "preflight", "edit": edit()}), Some("t1")), Ok(Request::Preflight { .. })));
    }

    fn hit(zoom: f64, page: i64) -> Value {
        json!({
            "operation": "hitTest", "pageIndex": page, "coordinateSpace": "viewportCss", "point": {"x": 1, "y": 2},
            "viewportTransform": {
                "cropBox": {"left": 0, "bottom": 0, "right": 10, "top": 10}, "rotation": "90", "zoom": zoom,
                "devicePixelRatio": 1, "scrollCss": {"x": 0, "y": 0}, "viewportOriginCss": {"x": 0, "y": 0},
                "viewportSizeCss": {"x": 5, "y": 5},
            },
        })
    }

    #[test]
    fn a_hit_test_keeps_its_shape_and_limits() {
        let Ok(Request::HitTest(value)) = request("inspect", hit(1.0, 3), None) else { panic!("hit test") };
        assert_eq!(value["viewportTransform"]["rotation"], "90");
        assert_eq!(value["pageIndex"], 3);
        assert!(request("inspect", hit(0.0, 3), None).is_err());
        assert!(request("inspect", hit(1.0, 256), None).is_err());
        assert!(request("inspect", hit(1.0, -1), None).is_err());
        let mut rotated = hit(1.0, 0);
        rotated["viewportTransform"]["rotation"] = json!("45");
        assert!(request("inspect", rotated, None).is_err());
        let mut extra = hit(1.0, 0);
        extra["point"]["z"] = json!(1);
        assert!(request("inspect", extra, None).is_err());
    }

    #[test]
    fn render_and_edit_payloads_keep_their_limits() {
        assert!(request("render", json!({"pageIndex": 0, "widthPx": 4096, "heightPx": 1}), None).is_ok());
        for bad in [
            json!({"pageIndex": 0, "widthPx": 4097, "heightPx": 1}),
            json!({"pageIndex": 0, "widthPx": 0, "heightPx": 1}),
            json!({"pageIndex": 256, "widthPx": 1, "heightPx": 1}),
            json!({"pageIndex": 0, "widthPx": 1}),
            json!({"pageIndex": 0, "widthPx": 1, "heightPx": 1, "extra": true}),
        ] {
            assert!(request("render", bad, None).is_err());
        }
        assert!(request("apply", json!({"edit": edit()}), None).is_err(), "needs a target");
        assert!(matches!(request("apply", json!({"edit": edit()}), Some("t1")), Ok(Request::Apply { .. })));
        let mut empty_old = edit();
        empty_old["expectedOldText"] = json!("");
        assert!(request("apply", json!({"edit": empty_old}), Some("t1")).is_err());
        let mut long = edit();
        long["replacementText"] = json!("é".repeat(MAX_TEXT_CHARS));
        assert!(request("apply", json!({"edit": long.clone()}), Some("t1")).is_ok(), "limit counts characters");
        long["replacementText"] = json!("é".repeat(MAX_TEXT_CHARS + 1));
        assert!(request("apply", json!({"edit": long}), Some("t1")).is_err());
        let mut zero_end = edit();
        zero_end["utf16End"] = json!(0);
        assert!(request("apply", json!({"edit": zero_end}), Some("t1")).is_err());
    }

    #[test]
    fn history_save_and_close_payloads() {
        assert!(matches!(
            request("history", json!({"action": "undo"}), None),
            Ok(Request::History { action: HistoryAction::Undo, pending_draft: false })
        ));
        assert!(request("history", json!({"action": "sideways"}), None).is_err());
        assert!(matches!(request("save", json!({}), None), Ok(Request::Save { draft: None, .. })));
        assert!(matches!(request("save", json!({"draft": null}), None), Ok(Request::Save { draft: None, .. })));
        assert!(request("save", json!({"draft": edit()}), None).is_err(), "a draft needs a target");
        assert!(matches!(request("save", json!({"draft": edit()}), Some("t1")), Ok(Request::Save { draft: Some(_), .. })));
        assert!(matches!(
            request("close", json!({"pendingDraft": true, "decision": "discard"}), None),
            Ok(Request::Close { pending_draft: true, decision: CloseDecision::Discard })
        ));
        assert!(matches!(request("close", json!({}), None), Ok(Request::Close { decision: CloseDecision::None, .. })));
        assert!(request("close", json!({"decision": "maybe"}), None).is_err());
    }

    #[test]
    fn replies_and_duplicates_have_the_old_shape() {
        let first = reply("r", "s", "rejected", 2, json!({"state": 1}), Some("REJECTED_LAYOUT"), Some("x"));
        assert_eq!(first["schemaVersion"], REPLY_SCHEMA);
        assert_eq!(first["guardReason"], "REJECTED_LAYOUT");
        let plain = accepted_read_reply("r", "s", 0, json!({}));
        assert!(plain.get("guardReason").is_none() && plain.get("error").is_none());
        let again = duplicate(&first);
        assert_eq!(again["status"], "duplicate");
        assert_eq!(again["result"]["originalStatus"], "rejected");
        assert_eq!(again["result"]["originalResult"]["state"], 1);
        assert_eq!(again["acceptedRevision"], 2);
        assert!(safe_error("REJECTED_TYPE3").contains("Type 3"));
        assert!(safe_error("whatever").contains("unsupported"));
    }

    #[test]
    fn opaque_ids() {
        assert!(is_opaque_id("a-B_9"));
        assert!(!is_opaque_id(""));
        assert!(!is_opaque_id("a b"));
        assert!(!is_opaque_id("é"));
    }
}
