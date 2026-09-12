"""Strict HTTP surface for the independent Edit Content V1 feature."""

from __future__ import annotations

import hmac
import os
from pathlib import Path
import re
from typing import Any, Literal
import uuid

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from config import settings
from features.edit_content.coordinator import ContentCoordinatorError
from features.edit_content.session_service import (
    ContentSessionRegistry,
    ContentSessionUnavailable,
    accepted_read_reply,
    outcome_reply,
)


router = APIRouter(prefix="/edit-content", tags=["edit-content"])
MAX_SOURCE_BYTES = 16 * 1024 * 1024
_OPAQUE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_registry = ContentSessionRegistry()


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class CommandEnvelope(StrictModel):
    schemaVersion: Literal["edit-content-request/v1"]
    requestId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    sessionId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    command: Literal["inspect", "render", "apply", "history", "save", "close"]
    expectedAcceptedRevision: int = Field(ge=0)
    targetId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$")
    payload: dict[str, Any]


class HitPoint(StrictModel):
    x: float
    y: float


class ViewportSize(StrictModel):
    x: float = Field(gt=0)
    y: float = Field(gt=0)


class CropBox(StrictModel):
    left: float
    bottom: float
    right: float
    top: float


class ViewportTransform(StrictModel):
    cropBox: CropBox
    rotation: Literal["0", "90", "180", "270"]
    zoom: float = Field(gt=0)
    devicePixelRatio: float = Field(gt=0)
    scrollCss: HitPoint
    viewportOriginCss: HitPoint
    viewportSizeCss: ViewportSize


class HitTestPayload(StrictModel):
    operation: Literal["hitTest"]
    pageIndex: int = Field(ge=0, le=255)
    coordinateSpace: Literal["viewportCss"]
    point: HitPoint
    viewportTransform: ViewportTransform


class ValidateRangePayload(StrictModel):
    operation: Literal["validateTextRange"]
    utf16Start: int = Field(ge=0)
    utf16End: int = Field(ge=0)
    expectedText: str = Field(max_length=131072)


class RenderPayload(StrictModel):
    pageIndex: int = Field(ge=0, le=255)
    widthPx: int = Field(ge=1, le=4096)
    heightPx: int = Field(ge=1, le=4096)


class EditPayload(StrictModel):
    expectedText: str = Field(max_length=131072)
    expectedOldText: str = Field(min_length=1, max_length=131072)
    replacementText: str = Field(max_length=131072)
    utf16Start: int = Field(ge=0)
    utf16End: int = Field(ge=1)


class ApplyPayload(StrictModel):
    edit: EditPayload


class HistoryPayload(StrictModel):
    action: Literal["undo", "redo"]
    pendingDraft: bool = False


class SavePayload(StrictModel):
    draft: EditPayload | None = None


class ClosePayload(StrictModel):
    pendingDraft: bool = False
    decision: Literal["discard", "none"] = "none"


def get_content_registry() -> ContentSessionRegistry:
    return _registry


@router.post("/shutdown")
def shutdown(request: Request):
    lifecycle_token = os.environ.get("PDF_MANAGER_DESKTOP_LIFECYCLE_TOKEN")
    supplied_token = request.headers.get("X-PDF-Manager-Lifecycle", "")
    if not lifecycle_token or not hmac.compare_digest(supplied_token, lifecycle_token):
        raise HTTPException(status_code=404, detail="Endpoint not found.")
    return {"closedSessions": _registry.close_all()}


def _validate_envelope(session_id: str, envelope: CommandEnvelope, command: str) -> None:
    if envelope.sessionId != session_id or envelope.command != command:
        raise HTTPException(status_code=422, detail="Request command or session does not match this endpoint.")


def _payload(model: type[StrictModel], value: dict[str, Any]) -> StrictModel:
    try:
        return model.model_validate(value)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc


async def _save_bounded_upload(upload: UploadFile) -> Path:
    filename = upload.filename or "document.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="Edit Content accepts PDF files only.")
    directory = settings.TEMP_DIR / "edit-content"
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"{uuid.uuid4().hex}.pdf"
    total = 0
    try:
        with destination.open("xb") as output:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_SOURCE_BYTES:
                    raise HTTPException(status_code=413, detail="PDF exceeds the 16 MiB Edit Content limit.")
                output.write(chunk)
        if total == 0:
            raise HTTPException(status_code=422, detail="PDF file is empty.")
        return destination
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


@router.post("/sessions")
async def open_session(
    file: UploadFile = File(...),
    schema_version: Literal["edit-content-request/v1"] = Form(..., alias="schemaVersion"),
    request_id: str = Form(..., alias="requestId"),
    command: Literal["open"] = Form(...),
):
    del schema_version, command
    if _OPAQUE_ID.fullmatch(request_id) is None:
        raise HTTPException(status_code=422, detail="Invalid request identity.")
    source = await _save_bounded_upload(file)
    try:
        coordinator, inspected = get_content_registry().open(source)
        state = coordinator.state()
        discovery = inspected.get("result", {}).get("discovery", {})
        return accepted_read_reply(
            request_id, state["sessionId"], state["acceptedRevision"],
            {"state": state, "discovery": discovery},
        )
    except ContentCoordinatorError as exc:
        raise HTTPException(status_code=503, detail="Edit Content engine is unavailable.") from exc
    except (OSError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail="Edit Content engine is unavailable.") from exc
    finally:
        source.unlink(missing_ok=True)


@router.post("/sessions/{session_id}/objects")
def objects(session_id: str, envelope: CommandEnvelope):
    _validate_envelope(session_id, envelope, "inspect")
    operation = envelope.payload.get("operation")
    if operation == "hitTest":
        payload = _payload(HitTestPayload, envelope.payload).model_dump()
    elif operation == "validateTextRange":
        payload = _payload(ValidateRangePayload, envelope.payload).model_dump()
        if envelope.targetId is None:
            raise HTTPException(status_code=422, detail="Range validation requires targetId.")
    elif envelope.payload:
        raise HTTPException(status_code=422, detail="Unsupported object operation.")
    else:
        payload = None

    def operation_call(coordinator, _cancelled):
        reply = coordinator.inspect(
            request_id=envelope.requestId,
            expected_revision=envelope.expectedAcceptedRevision,
            target_id=envelope.targetId,
            payload=payload,
        )
        result = reply.get("result", {})
        public_result = {key: result[key] for key in ("discovery", "hitTest", "unicodeRange", "exactObjectTextMatched") if key in result}
        return accepted_read_reply(envelope.requestId, session_id, reply["acceptedRevision"], public_result)

    return get_content_registry().run(session_id, envelope.requestId, operation_call)


@router.post("/sessions/{session_id}/render")
def render(session_id: str, envelope: CommandEnvelope):
    _validate_envelope(session_id, envelope, "render")
    payload = _payload(RenderPayload, envelope.payload)

    def operation_call(coordinator, _cancelled):
        reply = coordinator.render(
            request_id=envelope.requestId,
            expected_revision=envelope.expectedAcceptedRevision,
            page_index=payload.pageIndex,
            width_px=payload.widthPx,
            height_px=payload.heightPx,
        )
        return accepted_read_reply(envelope.requestId, session_id, reply["acceptedRevision"], reply["result"])

    return get_content_registry().run(session_id, envelope.requestId, operation_call)


@router.post("/sessions/{session_id}/apply")
def apply(session_id: str, envelope: CommandEnvelope):
    _validate_envelope(session_id, envelope, "apply")
    if envelope.targetId is None:
        raise HTTPException(status_code=422, detail="Apply requires targetId.")
    payload = _payload(ApplyPayload, envelope.payload)

    def operation_call(coordinator, cancelled):
        outcome = coordinator.apply(
            request_id=envelope.requestId,
            expected_revision=envelope.expectedAcceptedRevision,
            target_id=envelope.targetId,
            edit=payload.edit.model_dump(),
            cancelled=cancelled,
        )
        return outcome_reply(outcome, coordinator.state())

    return get_content_registry().run(session_id, envelope.requestId, operation_call)


@router.post("/sessions/{session_id}/history")
def history(session_id: str, envelope: CommandEnvelope):
    _validate_envelope(session_id, envelope, "history")
    payload = _payload(HistoryPayload, envelope.payload)

    def operation_call(coordinator, cancelled):
        method = coordinator.undo if payload.action == "undo" else coordinator.redo
        outcome = method(
            request_id=envelope.requestId,
            expected_revision=envelope.expectedAcceptedRevision,
            pending_draft=payload.pendingDraft,
            cancelled=cancelled,
        )
        return outcome_reply(outcome, coordinator.state())

    return get_content_registry().run(session_id, envelope.requestId, operation_call)


@router.post("/sessions/{session_id}/save")
def save(session_id: str, envelope: CommandEnvelope):
    _validate_envelope(session_id, envelope, "save")
    payload = _payload(SavePayload, envelope.payload)
    if payload.draft is not None and envelope.targetId is None:
        raise HTTPException(status_code=422, detail="Save with a draft requires targetId.")

    def operation_call(coordinator, cancelled):
        if payload.draft is None:
            outcome = coordinator.save(
                request_id=envelope.requestId,
                expected_revision=envelope.expectedAcceptedRevision,
                cancelled=cancelled,
            )
        else:
            outcome = coordinator.apply(
                request_id=envelope.requestId,
                expected_revision=envelope.expectedAcceptedRevision,
                target_id=envelope.targetId or "",
                edit=payload.draft.model_dump(),
                save=True,
                cancelled=cancelled,
            )
        return outcome_reply(outcome, coordinator.state())

    return get_content_registry().run(session_id, envelope.requestId, operation_call)


@router.post("/sessions/{session_id}/close")
def close(session_id: str, envelope: CommandEnvelope):
    _validate_envelope(session_id, envelope, "close")
    payload = _payload(ClosePayload, envelope.payload)
    registry = get_content_registry()
    try:
        coordinator = registry.get(session_id)
    except ContentSessionUnavailable as exc:
        raise HTTPException(status_code=404, detail="Content session was not found.") from exc
    state = coordinator.state(pending_draft=payload.pendingDraft)
    if envelope.expectedAcceptedRevision != state["acceptedRevision"]:
        return {
            "schemaVersion": "edit-content-reply/v1", "requestId": envelope.requestId,
            "sessionId": session_id, "status": "stale", "acceptedRevision": state["acceptedRevision"],
            "guardReason": "REJECTED_STALE_REVISION", "error": "The document changed before close.",
            "result": {"state": state},
        }
    if (payload.pendingDraft or state["dirty"]) and payload.decision != "discard":
        return {
            "schemaVersion": "edit-content-reply/v1", "requestId": envelope.requestId,
            "sessionId": session_id, "status": "rejected", "acceptedRevision": state["acceptedRevision"],
            "guardReason": "REJECTED_UNSUPPORTED_STRUCTURE", "error": "Save or explicitly discard changes before closing.",
            "result": {"state": state},
        }
    registry.close(session_id)
    return accepted_read_reply(envelope.requestId, session_id, state["acceptedRevision"], {"closed": True})


@router.post("/sessions/{session_id}/requests/{request_id}/cancel")
def cancel(session_id: str, request_id: str):
    if _OPAQUE_ID.fullmatch(request_id) is None:
        raise HTTPException(status_code=422, detail="Invalid request identity.")
    try:
        accepted = get_content_registry().cancel(session_id, request_id)
    except ContentSessionUnavailable as exc:
        raise HTTPException(status_code=404, detail="Content session was not found.") from exc
    return {"status": "accepted" if accepted else "not-running", "requestId": request_id}


@router.get("/sessions/{session_id}/outputs/{output_id}")
def output(session_id: str, output_id: str):
    if _OPAQUE_ID.fullmatch(output_id) is None:
        raise HTTPException(status_code=404, detail="Published output was not found.")
    try:
        content = get_content_registry().get(session_id).output_bytes(output_id)
    except (ContentSessionUnavailable, TransitionRejected, ValueError) as exc:
        raise HTTPException(status_code=404, detail="Published output was not found.") from exc
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="edit-content-{output_id[:8]}.pdf"',
            "X-Content-Length": str(len(content)),
        },
    )
