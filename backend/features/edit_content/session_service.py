"""Feature-owned lifecycle and public orchestration for Edit Content sessions."""

from __future__ import annotations

import os
from pathlib import Path
import shlex
import sys
import threading
from typing import Any, Callable
import uuid

from config import settings
from features.edit_content.coordinator import ContentCoordinatorError, ContentSessionCoordinator
from features.edit_content.engine_identity import load_engine_identity
from features.edit_content.process_adapter import ContentWorkerError, WorkerLaunchConfig
from features.edit_content.transaction_state import Outcome, TransitionRejected


MAX_ACTIVE_SESSIONS = 2


class ContentSessionUnavailable(RuntimeError):
    """A requested Content session is absent or cannot safely continue."""


def default_worker_config() -> WorkerLaunchConfig:
    project_root = Path(__file__).resolve().parents[3]
    worker_default = project_root / "native" / "edit-content-engine" / "target" / "debug" / "edit-content-engine.exe"
    library_default = project_root / "native" / "edit-content-engine" / "pdfium.dll"
    resource_dir = os.environ.get("PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR")
    if resource_dir:
        resource_root = Path(resource_dir)
        identity = load_engine_identity()
        worker_default = resource_root / ("edit-content-engine.exe" if os.name == "nt" else "edit-content-engine")
        library_default = resource_root / identity.library_file
    worker_value = os.environ.get("PDF_MANAGER_EDIT_CONTENT_WORKER")
    library_value = os.environ.get("PDF_MANAGER_PDFIUM_LIBRARY", str(library_default))
    worker_command = (
        tuple(shlex.split(worker_value, posix=os.name != "nt"))
        if worker_value
        else (str(worker_default),)
    )
    return WorkerLaunchConfig.create(
        worker_command=worker_command,
        pdfium_library=Path(library_value),
        workspace_root=settings.APP_DATA_DIR / "edit-content-worker",
        inspector_command=(
            (sys.executable, "--edit-content-inspector")
            if getattr(sys, "frozen", False)
            else (sys.executable, "-m", "features.edit_content.resource_inspector_cli")
        ),
        parent_process_id=os.getpid() if resource_dir else None,
    )


class ContentSessionRegistry:
    """Owns independent live coordinators and request outcomes for the API layer."""

    def __init__(
        self,
        *,
        config_factory: Callable[[], WorkerLaunchConfig] = default_worker_config,
        storage_root: Path | None = None,
    ):
        self._config_factory = config_factory
        self._storage_root = Path(storage_root or settings.APP_DATA_DIR / "edit-content-sessions")
        self._sessions: dict[str, ContentSessionCoordinator] = {}
        self._outcomes: dict[str, dict[str, dict[str, Any]]] = {}
        self._in_flight: dict[tuple[str, str], threading.Event] = {}
        self._lock = threading.RLock()
        self._idle = threading.Condition(self._lock)
        self._shutting_down = False

    def open(self, source: Path) -> tuple[ContentSessionCoordinator, dict[str, Any]]:
        with self._lock:
            if self._shutting_down:
                raise ContentCoordinatorError("rejected", "Edit Content is shutting down")
            if len(self._sessions) >= MAX_ACTIVE_SESSIONS:
                raise ContentCoordinatorError("rejected", "Content session limit reached")
            session_id = uuid.uuid4().hex
            coordinator = ContentSessionCoordinator.create(
                self._config_factory(), self._storage_root, source, session_id=session_id
            )
            try:
                inspected = coordinator.inspect()
            except BaseException:
                coordinator.close()
                raise
            self._sessions[session_id] = coordinator
            self._outcomes[session_id] = {}
        return coordinator, inspected

    def get(self, session_id: str) -> ContentSessionCoordinator:
        with self._lock:
            if self._shutting_down:
                raise ContentSessionUnavailable("REJECTED_SESSION_NOT_FOUND")
            coordinator = self._sessions.get(session_id)
        if coordinator is None:
            raise ContentSessionUnavailable("REJECTED_SESSION_NOT_FOUND")
        return coordinator

    def run(
        self,
        session_id: str,
        request_id: str,
        operation: Callable[[ContentSessionCoordinator, Callable[[], bool]], dict[str, Any]],
    ) -> dict[str, Any]:
        try:
            coordinator = self.get(session_id)
        except ContentSessionUnavailable as exc:
            return _reply(
                request_id, session_id, "rejected", 0, {},
                guard_reason=str(exc), error="Content session was not found.",
            )
        key = (session_id, request_id)
        with self._lock:
            previous = self._outcomes[session_id].get(request_id)
            if previous is not None:
                return _duplicate(previous)
            if key in self._in_flight:
                return _reply(
                    request_id, session_id, "unknown", coordinator.state()["acceptedRevision"],
                    {}, error="The request outcome is still being established.",
                )
            cancelled = threading.Event()
            self._in_flight[key] = cancelled
        try:
            reply = operation(coordinator, cancelled.is_set)
        except ContentCoordinatorError as exc:
            try:
                state = coordinator.state()
            except Exception:
                state = None
            status = exc.status if exc.status in {"rejected", "stale", "unknown"} else "rejected"
            reply = _reply(
                request_id, session_id, status, state["acceptedRevision"] if state else 0,
                {"state": state} if state else {},
                guard_reason=exc.reason if status != "unknown" else None,
                error=_safe_error(exc.reason),
            )
        except (ContentWorkerError, TransitionRejected, OSError):
            try:
                state = coordinator.state()
            except Exception:
                state = None
            reply = _reply(
                request_id, session_id, "rejected", state["acceptedRevision"] if state else 0,
                {"state": state} if state else {},
                guard_reason="REJECTED_UNSUPPORTED_STRUCTURE",
                error="Edit Content could not complete this request safely.",
            )
        finally:
            with self._idle:
                self._outcomes[session_id][request_id] = reply
                self._in_flight.pop(key, None)
                self._idle.notify_all()
        return reply

    def cancel(self, session_id: str, request_id: str) -> bool:
        self.get(session_id)
        with self._lock:
            event = self._in_flight.get((session_id, request_id))
            if event is None:
                return False
            event.set()
            return True

    def close(self, session_id: str) -> None:
        with self._lock:
            coordinator = self._sessions.pop(session_id, None)
            if coordinator is None:
                raise ContentSessionUnavailable("REJECTED_SESSION_NOT_FOUND")
            self._outcomes.pop(session_id, None)
            for key, event in list(self._in_flight.items()):
                if key[0] == session_id:
                    event.set()
                    self._in_flight.pop(key, None)
        coordinator.close()

    def close_all(self) -> int:
        """Cancel active requests and close workers without deleting committed stores."""
        with self._idle:
            self._shutting_down = True
            cancellation_events = tuple(self._in_flight.values())
        for event in cancellation_events:
            event.set()
        with self._idle:
            if not self._idle.wait_for(lambda: not self._in_flight, timeout=12.0):
                raise RuntimeError("active Edit Content requests did not stop before shutdown")
            session_ids = tuple(self._sessions)
        closed = 0
        errors: list[BaseException] = []
        for session_id in session_ids:
            try:
                self.close(session_id)
                closed += 1
            except ContentSessionUnavailable:
                continue
            except BaseException as exc:
                errors.append(exc)
        if errors:
            raise RuntimeError("one or more Edit Content workers did not close cleanly") from errors[0]
        return closed


def outcome_reply(outcome: Outcome, state: dict[str, Any]) -> dict[str, Any]:
    return _reply(
        outcome.request_id,
        state["sessionId"],
        "accepted",
        outcome.revision,
        {"state": state, "outputId": outcome.output_id, "clearDraft": outcome.clear_draft},
    )


def accepted_read_reply(request_id: str, session_id: str, revision: int, result: dict[str, Any]) -> dict[str, Any]:
    return _reply(request_id, session_id, "accepted", revision, result)


def _duplicate(previous: dict[str, Any]) -> dict[str, Any]:
    duplicate = dict(previous)
    duplicate["status"] = "duplicate"
    duplicate["result"] = {
        "originalStatus": previous["status"],
        "originalResult": previous.get("result", {}),
    }
    return duplicate


def _reply(
    request_id: str,
    session_id: str,
    status: str,
    revision: int,
    result: dict[str, Any],
    *,
    guard_reason: str | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    reply: dict[str, Any] = {
        "schemaVersion": "edit-content-reply/v1",
        "requestId": request_id,
        "sessionId": session_id,
        "status": status,
        "acceptedRevision": revision,
        "result": result,
    }
    if guard_reason is not None:
        reply["guardReason"] = guard_reason
    if error is not None:
        reply["error"] = error
    return reply


def _safe_error(reason: str) -> str:
    explanations = {
        "REJECTED_STALE_REVISION": "The document changed. Refresh the page and select the text again.",
        "REJECTED_STALE_TARGET": "The selected text is no longer current. Select it again.",
        "REJECTED_SPLIT_TEXT_OBJECT": "This word spans multiple native text objects and cannot be edited safely.",
        "REJECTED_TYPE3": "Text using a Type 3 font is view-only in Edit Content V1.",
        "REJECTED_UNSUPPORTED_GLYPH": "The existing font cannot represent the replacement text.",
        "REJECTED_FONT_RESOURCE_COLLISION": "This page has colliding font resources and cannot be regenerated safely.",
        "REJECTED_LAYOUT": "The replacement would require unsupported layout changes.",
        "REJECTED_COLLATERAL_INTEGRITY": "The regenerated PDF did not preserve untouched content exactly enough.",
        "REJECTED_PERSISTENCE": "The replacement did not persist correctly after reopening the PDF.",
        "REJECTED_PUBLICATION": "The verified PDF could not be published safely.",
    }
    return explanations.get(reason, "This edit is unsupported or could not be verified safely.")
