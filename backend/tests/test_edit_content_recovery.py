"""Checked restart recovery; synthetic store bytes are not PDF acceptance proof."""

import hashlib
import os

import pytest

from features.edit_content.commit_store import ContentCommitStore, UnknownOutcome
from features.edit_content.session_service import ContentSessionRegistry, ContentSessionUnavailable
from features.edit_content.transaction_state import Checkpoint, SessionState

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows store locking")
SESSION = "a" * 32


@pytest.fixture
def saved(tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"synthetic checkpoint")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    state = SessionState.initial(SESSION, Checkpoint("source", 0, None, None, digest, digest,
                                                   source.stat().st_size, (1,)))
    store = ContentCommitStore.create(tmp_path / SESSION, state, source)
    output = store.transact(request_id="save", expected_revision=0, operation="save")
    store.close()
    return tmp_path, source, output


def test_download_survives_shutdown_without_worker_or_session_admission(saved):
    root, source, output = saved
    registry = ContentSessionRegistry(storage_root=root,
        config_factory=lambda: pytest.fail("downloads must not start a worker"))
    registry.close_all()
    assert registry.output_bytes(SESSION, output.output_id) == source.read_bytes()
    assert registry._sessions == {}


def test_recovery_ignores_uncommitted_candidates_and_preserves_saved_identity(saved):
    root, source, output = saved
    candidate = root / SESSION / "staging" / "uncommitted.pdf"
    candidate.write_bytes(b"unverified bytes")
    store = ContentCommitStore.recover(root / SESSION, SESSION)
    try:
        assert store.state().revision == 0
        assert store.state().last_output_id == output.output_id
        assert store.checkpoint_path().read_bytes() == source.read_bytes()
        assert store.state().known_outcome("save") == output
        assert candidate.read_bytes() == b"unverified bytes"
        with pytest.raises(UnknownOutcome):
            ContentCommitStore.recover(root / SESSION, SESSION)
    finally:
        store.close()


@pytest.mark.parametrize("damage", ["record", "checkpoint", "output", "wrong-session"])
def test_corrupt_recovery_fails_closed_and_retains_evidence(saved, damage):
    root, source, output = saved
    directory = root / SESSION
    if damage == "record":
        path = directory / "record.json"
        path.write_bytes(b"{}")
    elif damage == "wrong-session":
        with pytest.raises(UnknownOutcome):
            ContentCommitStore.recover(directory, "b" * 32)
        return
    else:
        path = directory / ("checkpoints/source.pdf" if damage == "checkpoint" else f"outputs/{output.output_id}.pdf")
        path.chmod(0o600)
        path.write_bytes(b"tampered")
    expected = path.read_bytes()
    with pytest.raises(UnknownOutcome):
        ContentCommitStore.recover(directory, SESSION)
    assert path.read_bytes() == expected
    assert source.read_bytes() == b"synthetic checkpoint"


def test_rehydration_preserves_worker_session_and_limits_admission(saved, monkeypatch):
    root, source, output = saved
    started = []

    class Worker:
        is_running = False

        def __init__(self, config):
            pass

        def start(self, path, *, session_id, accepted_revision):
            started.append((path.read_bytes(), session_id, accepted_revision))
            self.is_running = True

        def open(self):
            return {"status": "accepted", "acceptedRevision": 0}

        def close(self):
            self.is_running = False

        terminate = close

    monkeypatch.setattr("features.edit_content.coordinator.ContentWorkerAdapter", Worker)
    registry = ContentSessionRegistry(storage_root=root, config_factory=lambda: object())
    restored = registry.get(SESSION)
    try:
        assert restored.state()["lastOutputId"] == output.output_id
        assert started == [(source.read_bytes(), SESSION, 0)]
        assert registry.get(SESSION) is restored
        assert len(started) == 1
    finally:
        registry.close(SESSION)
    with pytest.raises(ContentSessionUnavailable):
        registry.get(SESSION)
    assert registry.output_bytes(SESSION, output.output_id) == source.read_bytes()


@pytest.mark.parametrize("session_id", ["../outside", "..", "A" * 32, "x", "a" * 33])
def test_recovery_rejects_non_server_ids_before_worker_start(tmp_path, session_id):
    registry = ContentSessionRegistry(storage_root=tmp_path,
        config_factory=lambda: pytest.fail("invalid recovery started a worker"))
    with pytest.raises(ContentSessionUnavailable):
        registry.get(session_id)


def test_recovery_respects_live_session_limit(saved):
    root, _, _ = saved
    registry = ContentSessionRegistry(storage_root=root,
        config_factory=lambda: pytest.fail("over-limit recovery started a worker"))
    registry._sessions.update(first=object(), second=object())
    with pytest.raises(ContentSessionUnavailable):
        registry.get(SESSION)


def test_unverifiable_recovery_is_unknown_not_a_proven_missing_session(saved):
    root, _, _ = saved
    record = root / SESSION / "record.json"
    record.write_bytes(b"{}")
    registry = ContentSessionRegistry(storage_root=root, config_factory=lambda: object())
    reply = registry.run(SESSION, "retry", lambda *_: pytest.fail("unverified recovery mutated state"))
    assert reply["status"] == "unknown"
    assert "guardReason" not in reply and reply["result"] == {}
    assert registry._sessions == {} and record.read_bytes() == b"{}"
