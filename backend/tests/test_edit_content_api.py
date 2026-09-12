from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import pytest
from httpx import ASGITransport, AsyncClient

from features.edit_content.coordinator import ContentCoordinatorError
from features.edit_content.session_service import accepted_read_reply, outcome_reply
from features.edit_content.transaction_state import Outcome
from main import app
from routers import edit_content


@dataclass
class FakeCoordinator:
    session_id: str
    revision: int = 0
    dirty: bool = False
    cursor: int = 0
    history_size: int = 1
    output_id: str | None = None
    closed: bool = False

    def state(self, *, pending_draft: bool = False) -> dict[str, Any]:
        return {
            "sessionId": self.session_id,
            "acceptedRevision": self.revision,
            "checkpointId": f"checkpoint-{self.cursor}",
            "dirty": pending_draft or self.dirty,
            "canUndo": self.cursor > 0,
            "canRedo": self.cursor + 1 < self.history_size,
            "savedHash": "a" * 64,
            "lastOutputId": self.output_id,
        }

    def inspect(self, **kwargs):
        expected = kwargs.get("expected_revision", self.revision)
        if expected != self.revision:
            raise ContentCoordinatorError("stale", "REJECTED_STALE_REVISION")
        payload = kwargs.get("payload") or {}
        result: dict[str, Any]
        if payload.get("operation") == "hitTest":
            result = {"hitTest": {"outcome": "selected", "targetId": f"target-{self.revision}"}}
        elif payload.get("operation") == "validateTextRange":
            result = {
                "unicodeRange": {"scalarStart": 0, "scalarEnd": 4},
                "exactObjectTextMatched": True,
            }
        else:
            result = {"discovery": discovery(self.revision)}
        return {"status": "accepted", "acceptedRevision": self.revision, "result": result}

    def render(self, **kwargs):
        if kwargs["expected_revision"] != self.revision:
            raise ContentCoordinatorError("stale", "REJECTED_STALE_REVISION")
        return {
            "status": "accepted",
            "acceptedRevision": self.revision,
            "result": {
                "pageIndex": kwargs["page_index"],
                "widthPx": kwargs["width_px"],
                "heightPx": kwargs["height_px"],
                "mimeType": "image/jpeg",
                "dataBase64": "/9j/2Q==",
                "sha256": "b" * 64,
            },
        }

    def apply(self, **kwargs):
        if kwargs["expected_revision"] != self.revision:
            raise ContentCoordinatorError("stale", "REJECTED_STALE_REVISION")
        if kwargs["edit"]["replacementText"] == "unsafe":
            raise ContentCoordinatorError("rejected", "REJECTED_UNSUPPORTED_GLYPH")
        self.revision += 1
        self.cursor += 1
        self.history_size = self.cursor + 1
        self.dirty = not kwargs.get("save", False)
        if kwargs.get("save"):
            self.output_id = f"output-{self.session_id}-{self.revision}"
        return Outcome(kwargs["request_id"], self.revision, f"checkpoint-{self.cursor}", self.output_id, True)

    def save(self, **kwargs):
        if kwargs["expected_revision"] != self.revision:
            raise ContentCoordinatorError("stale", "REJECTED_STALE_REVISION")
        self.output_id = f"output-{self.session_id}-{self.revision}"
        self.dirty = False
        return Outcome(kwargs["request_id"], self.revision, f"checkpoint-{self.cursor}", self.output_id, False)

    def undo(self, **kwargs):
        if kwargs.get("pending_draft"):
            raise ContentCoordinatorError("rejected", "apply or explicitly discard the draft first")
        if self.cursor == 0:
            raise ContentCoordinatorError("rejected", "history boundary")
        self.cursor -= 1
        self.revision += 1
        self.dirty = True
        return Outcome(kwargs["request_id"], self.revision, f"checkpoint-{self.cursor}", None, False)

    def redo(self, **kwargs):
        if self.cursor + 1 >= self.history_size:
            raise ContentCoordinatorError("rejected", "history boundary")
        self.cursor += 1
        self.revision += 1
        self.dirty = True
        return Outcome(kwargs["request_id"], self.revision, f"checkpoint-{self.cursor}", None, False)

    def output_bytes(self, output_id: str) -> bytes:
        if output_id != self.output_id:
            raise ValueError("not published")
        return b"%PDF-1.4\nverified\n%%EOF"

    def close(self):
        self.closed = True


def discovery(revision: int) -> dict[str, Any]:
    return {
        "schemaVersion": "edit-content-inspection/v1",
        "readOnly": True,
        "pages": [{
            "pageIndex": 0, "widthPt": 612, "heightPt": 792,
            "cropBox": {"left": 0, "bottom": 0, "right": 612, "top": 792}, "rotation": 0,
        }],
        "textObjects": [{
            "targetId": f"target-{revision}", "pageIndex": 0,
            "nativeObjectIdentity": "native-1", "text": "word", "unicodeScalarLength": 4,
            "bounds": {"left": 72, "bottom": 700, "right": 110, "top": 714},
            "rotatedQuad": {"points": [{"x": 72, "y": 700}, {"x": 110, "y": 700}, {"x": 110, "y": 714}, {"x": 72, "y": 714}]},
            "font": {"name": "Helvetica", "family": "Helvetica", "weight": "Normal", "embedded": True},
            "fontSizePt": 12, "fillColor": {"red": 0, "green": 0, "blue": 0, "alpha": 255},
            "strokeColor": {"red": 0, "green": 0, "blue": 0, "alpha": 255},
            "matrix": {"a": 1, "b": 0, "c": 0, "d": 1, "e": 72, "f": 700},
            "rotation": 0, "renderMode": "Fill", "sourceScope": {"kind": "page", "objectPath": [0]},
            "editable": True, "viewOnlyReason": None,
        }],
        "viewOnlyObjects": [],
    }


class FakeRegistry:
    def __init__(self):
        self.sessions: dict[str, FakeCoordinator] = {}
        self.outcomes: dict[tuple[str, str], dict[str, Any]] = {}

    def open(self, source: Path):
        assert source.read_bytes().startswith(b"%PDF")
        session_id = f"session{len(self.sessions) + 1}"
        coordinator = FakeCoordinator(session_id)
        self.sessions[session_id] = coordinator
        return coordinator, coordinator.inspect()

    def get(self, session_id: str):
        coordinator = self.sessions.get(session_id)
        if coordinator is None:
            from features.edit_content.session_service import ContentSessionUnavailable
            raise ContentSessionUnavailable("REJECTED_SESSION_NOT_FOUND")
        return coordinator

    def run(self, session_id: str, request_id: str, operation: Callable):
        key = (session_id, request_id)
        if key in self.outcomes:
            previous = self.outcomes[key]
            return {**previous, "status": "duplicate", "result": {"originalStatus": previous["status"], "originalResult": previous["result"]}}
        coordinator = self.get(session_id)
        try:
            reply = operation(coordinator, lambda: False)
        except ContentCoordinatorError as exc:
            reply = {
                "schemaVersion": "edit-content-reply/v1", "requestId": request_id,
                "sessionId": session_id, "status": exc.status, "acceptedRevision": coordinator.revision,
                "guardReason": exc.reason, "error": "safe failure", "result": {"state": coordinator.state()},
            }
        self.outcomes[key] = reply
        return reply

    def cancel(self, session_id: str, request_id: str):
        self.get(session_id)
        return False

    def close(self, session_id: str):
        coordinator = self.sessions.pop(session_id)
        coordinator.close()

    def close_all(self):
        session_ids = tuple(self.sessions)
        for session_id in session_ids:
            self.close(session_id)
        return len(session_ids)


def envelope(session_id: str, request_id: str, command: str, revision: int, payload=None, target_id=None):
    value = {
        "schemaVersion": "edit-content-request/v1", "requestId": request_id,
        "sessionId": session_id, "command": command,
        "expectedAcceptedRevision": revision, "payload": payload or {},
    }
    if target_id is not None:
        value["targetId"] = target_id
    return value


@pytest.fixture
def registry(monkeypatch):
    value = FakeRegistry()
    monkeypatch.setattr(edit_content, "_registry", value)
    return value


def test_failed_initial_inspection_closes_worker_without_registering_session(monkeypatch, tmp_path):
    from features.edit_content import session_service

    class FailedCoordinator:
        closed = False

        def inspect(self):
            raise ContentCoordinatorError("rejected", "REJECTED_UNSUPPORTED_STRUCTURE")

        def close(self):
            self.closed = True

    failed = FailedCoordinator()
    monkeypatch.setattr(
        session_service.ContentSessionCoordinator,
        "create",
        lambda *_args, **_kwargs: failed,
    )
    registry = session_service.ContentSessionRegistry(
        config_factory=lambda: object(),
        storage_root=tmp_path / "sessions",
    )

    with pytest.raises(ContentCoordinatorError):
        registry.open(tmp_path / "source.pdf")

    assert failed.closed is True
    assert registry._sessions == {}


@pytest.mark.asyncio
async def test_strict_session_object_render_apply_history_save_close_surface(registry):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        opened = await client.post(
            "/api/v1/edit-content/sessions",
            data={"schemaVersion": "edit-content-request/v1", "requestId": "open1", "command": "open"},
            files={"file": ("source.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")},
        )
        assert opened.status_code == 200
        session_id = opened.json()["sessionId"]
        assert opened.json()["result"]["discovery"]["textObjects"][0]["targetId"] == "target-0"

        inspected = await client.post(
            f"/api/v1/edit-content/sessions/{session_id}/objects",
            json=envelope(session_id, "inspect1", "inspect", 0),
        )
        rendered = await client.post(
            f"/api/v1/edit-content/sessions/{session_id}/render",
            json=envelope(session_id, "render1", "render", 0, {"pageIndex": 0, "widthPx": 800, "heightPx": 1000}),
        )
        assert inspected.json()["status"] == "accepted"
        assert rendered.json()["result"]["mimeType"] == "image/jpeg"

        edit = {"expectedText": "word", "expectedOldText": "word", "replacementText": "work", "utf16Start": 0, "utf16End": 4}
        applied = await client.post(
            f"/api/v1/edit-content/sessions/{session_id}/apply",
            json=envelope(session_id, "apply1", "apply", 0, {"edit": edit}, "target-0"),
        )
        assert applied.json()["acceptedRevision"] == 1
        assert applied.json()["result"]["state"]["canUndo"] is True

        saved = await client.post(
            f"/api/v1/edit-content/sessions/{session_id}/save",
            json=envelope(session_id, "save1", "save", 1),
        )
        output_id = saved.json()["result"]["outputId"]
        downloaded = await client.get(f"/api/v1/edit-content/sessions/{session_id}/outputs/{output_id}")
        assert downloaded.content.startswith(b"%PDF")

        undone = await client.post(
            f"/api/v1/edit-content/sessions/{session_id}/history",
            json=envelope(session_id, "undo1", "history", 1, {"action": "undo", "pendingDraft": False}),
        )
        assert undone.json()["acceptedRevision"] == 2
        closed = await client.post(
            f"/api/v1/edit-content/sessions/{session_id}/close",
            json=envelope(session_id, "close1", "close", 2, {"pendingDraft": False, "decision": "discard"}),
        )
        assert closed.json()["result"]["closed"] is True


@pytest.mark.asyncio
async def test_desktop_shutdown_requires_lifecycle_token_and_closes_content_only(registry, monkeypatch):
    import os

    monkeypatch.setenv("PDF_MANAGER_DESKTOP_LIFECYCLE_TOKEN", "shutdown-test-token")
    coordinator = FakeCoordinator("session-shutdown")
    registry.sessions[coordinator.session_id] = coordinator
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        denied = await client.post("/api/v1/edit-content/shutdown")
        closed = await client.post(
            "/api/v1/edit-content/shutdown",
            headers={"X-PDF-Manager-Lifecycle": os.environ["PDF_MANAGER_DESKTOP_LIFECYCLE_TOKEN"]},
        )

    assert denied.status_code == 404
    assert closed.status_code == 200
    assert closed.json() == {"closedSessions": 1}
    assert coordinator.closed is True


@pytest.mark.asyncio
async def test_stale_invalid_and_retired_requests_never_reach_mutation(registry):
    coordinator = FakeCoordinator("session1")
    registry.sessions["session1"] = coordinator
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        stale = await client.post(
            "/api/v1/edit-content/sessions/session1/apply",
            json=envelope("session1", "stale1", "apply", 9, {"edit": {"expectedText": "word", "expectedOldText": "word", "replacementText": "work", "utf16Start": 0, "utf16End": 4}}, "target-0"),
        )
        invalid = await client.post(
            "/api/v1/edit-content/sessions/session1/apply",
            json={**envelope("session1", "invalid1", "apply", 0, {}, "target-0"), "unexpected": True},
        )
        missing_close = await client.post(
            "/api/v1/edit-content/sessions/missing/close",
            json=envelope("missing", "close-missing", "close", 0, {"pendingDraft": False, "decision": "none"}),
        )
        retired = await client.post("/api/v1/edit-pdf/apply", json={})
        assert stale.json()["status"] == "stale"
        assert invalid.status_code == 422
        assert missing_close.status_code == 404
        assert retired.status_code == 404
        assert coordinator.revision == 0


@pytest.mark.asyncio
async def test_two_content_sessions_and_canvas_surface_remain_independent(registry):
    first = FakeCoordinator("session1")
    second = FakeCoordinator("session2")
    registry.sessions.update(session1=first, session2=second)
    edit = {"expectedText": "word", "expectedOldText": "word", "replacementText": "work", "utf16Start": 0, "utf16End": 4}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/v1/edit-content/sessions/session1/apply",
            json=envelope("session1", "apply1", "apply", 0, {"edit": edit}, "target-0"),
        )
        canvas = await client.post("/api/v1/edit-canvas/save")
        assert response.json()["status"] == "accepted"
        assert first.revision == 1
        assert second.revision == 0
        assert canvas.status_code == 422
