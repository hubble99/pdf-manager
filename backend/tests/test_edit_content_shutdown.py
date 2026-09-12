from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from features.edit_content.coordinator import ContentCoordinatorError
from features.edit_content.session_service import ContentSessionRegistry, ContentSessionUnavailable


class ClosingCoordinator:
    def __init__(self):
        self.closed = False

    def state(self):
        return {"acceptedRevision": 0}

    def close(self):
        self.closed = True


def test_shutdown_cancels_inflight_request_before_closing_registry(tmp_path: Path):
    registry = ContentSessionRegistry(config_factory=lambda: object(), storage_root=tmp_path / "sessions")
    coordinator = ClosingCoordinator()
    registry._sessions["session-1"] = coordinator
    registry._outcomes["session-1"] = {}
    entered = threading.Event()
    result: dict[str, object] = {}

    def operation(_coordinator, cancelled):
        entered.set()
        deadline = time.monotonic() + 2
        while not cancelled() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert cancelled()
        return {"status": "cancelled"}

    request = threading.Thread(
        target=lambda: result.setdefault("reply", registry.run("session-1", "request-1", operation))
    )
    request.start()
    assert entered.wait(timeout=2)

    assert registry.close_all() == 1
    request.join(timeout=2)

    assert not request.is_alive()
    assert result["reply"]["status"] == "cancelled"
    assert coordinator.closed is True
    assert registry._sessions == {}
    with pytest.raises(ContentCoordinatorError, match="shutting down"):
        registry.open(tmp_path / "source.pdf")


def test_unexpected_exception_cannot_strand_shutdown(tmp_path):
    registry = ContentSessionRegistry(storage_root=tmp_path)
    registry._sessions["session"] = ClosingCoordinator()
    registry._outcomes["session"] = {}

    def broken(_coordinator, _cancelled):
        raise RuntimeError("deliberate operation failure")

    with pytest.raises(RuntimeError, match="deliberate operation failure"):
        registry.run("session", "request", broken)
    assert registry._in_flight == {}
    assert registry._outcomes["session"]["request"]["status"] == "unknown"
    assert registry.close_all() == 1


def test_close_drains_request_before_removing_session(tmp_path):
    registry = ContentSessionRegistry(storage_root=tmp_path)
    coordinator = ClosingCoordinator()
    registry._sessions["session"] = coordinator
    registry._outcomes["session"] = {}
    entered, cancelled_seen, finish = threading.Event(), threading.Event(), threading.Event()
    failures = []

    def operation(_coordinator, cancelled):
        entered.set()
        deadline = time.monotonic() + 3
        while not cancelled() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert cancelled()
        cancelled_seen.set()
        assert finish.wait(3)
        assert not coordinator.closed
        return {"status": "cancelled"}

    def capture(call):
        try:
            call()
        except BaseException as exc:
            failures.append(exc)

    request = threading.Thread(target=lambda: capture(lambda: registry.run("session", "request", operation)))
    closer = threading.Thread(target=lambda: capture(lambda: registry.close("session")))
    request.start()
    try:
        assert entered.wait(3)
        closer.start()
        assert cancelled_seen.wait(3)
        assert not coordinator.closed
        with pytest.raises(ContentSessionUnavailable):
            registry.get("session")
        assert registry.run("session", "late-request", lambda *_: pytest.fail("late admission"))["status"] == "rejected"
    finally:
        finish.set()
        request.join(3)
        if closer.ident is not None:
            closer.join(3)
    assert not failures
    assert not request.is_alive() and not closer.is_alive()
    assert coordinator.closed
    assert registry._sessions == registry._outcomes == registry._in_flight == {}


def test_failed_close_retains_ownership_for_shutdown_retry(tmp_path):
    registry = ContentSessionRegistry(storage_root=tmp_path)

    class FailsOnce(ClosingCoordinator):
        attempts = 0

        def close(self):
            self.attempts += 1
            if self.attempts == 1:
                raise OSError("temporary close failure")
            super().close()

    coordinator = FailsOnce()
    registry._sessions["session"] = coordinator
    registry._outcomes["session"] = {}
    with pytest.raises(OSError):
        registry.close("session")
    assert registry._sessions["session"] is coordinator
    with pytest.raises(ContentSessionUnavailable):
        registry.get("session")
    assert registry.close_all() == 1
    assert coordinator.closed
