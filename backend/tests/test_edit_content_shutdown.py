from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from features.edit_content.coordinator import ContentCoordinatorError
from features.edit_content.session_service import ContentSessionRegistry


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
