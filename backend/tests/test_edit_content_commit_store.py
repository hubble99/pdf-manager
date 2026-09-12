"""Actual Windows file/record boundaries, with synthetic bytes (not PDF proof)."""

from dataclasses import replace
import hashlib
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest
from features.edit_content.engine_identity import load_engine_identity

from features.edit_content.commit_store import ContentCommitStore, UnknownOutcome, _move
from features.edit_content.transaction_state import (
    Checkpoint, EditMetadata, REQUIRED_CHECKS, SessionState,
    TransitionRejected, VERIFIER_POLICY,
)

ENGINE_SHA256 = load_engine_identity().library_sha256

pytestmark = pytest.mark.skipif(os.name != "nt", reason="must exercise the actual Windows commit primitive")


def source_state(path):
    data = b"synthetic source checkpoint"
    path.write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    checkpoint = Checkpoint("source", 0, None, None, digest, digest, len(data), (1,))
    return SessionState.initial("session", checkpoint)


def prepared(path, request_id="edit", operation="apply"):
    path.write_bytes(b"synthetic verified candidate")

    def worker(state, accepted):
        assert hashlib.sha256(accepted.read_bytes()).hexdigest() == state.current.accepted_artifact_hash
        edit = EditMetadata(request_id, operation, 0, (0,), 0, 4, "word", "text", 1, 0, 0,
                            state.current.accepted_artifact_hash, ENGINE_SHA256, "154.0.8035", "0.9.4",
                            VERIFIER_POLICY, tuple(sorted(REQUIRED_CHECKS)))
        return Checkpoint("checkpoint_" + request_id, state.revision + 1, state.revision,
                          state.current.checkpoint_id, state.source.source_hash,
                          hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_size, (1,), edit), path
    return worker


@pytest.fixture
def store(tmp_path):
    state = source_state(tmp_path / "source.pdf")
    result = ContentCommitStore.create(tmp_path / "owned", state, tmp_path / "source.pdf")
    yield result
    result.close()


def test_joint_save_unchanged_save_history_and_published_output_survival(store, tmp_path):
    worker = prepared(tmp_path / "candidate.pdf", operation="save-with-draft")
    outcome = store.transact(request_id="edit", expected_revision=0, operation="save-with-draft",
                             pending_draft=True, prepare=worker)
    assert outcome.revision == 1
    assert store.output_bytes(outcome.output_id) == (tmp_path / "candidate.pdf").read_bytes()
    saved = store.state()
    second = store.transact(request_id="save", expected_revision=1, operation="save")
    assert second.revision == 1 and second.output_id != outcome.output_id
    assert store.state().checkpoints == saved.checkpoints
    store.transact(request_id="undo", expected_revision=1, operation="undo")
    assert store.state().revision == 2 and store.state().current == store.state().source
    assert store.output_bytes(outcome.output_id) == (tmp_path / "candidate.pdf").read_bytes()
    root, source_hash = store.root, store.source_hash
    store.close()
    reopened = ContentCommitStore(root, "session", source_hash)
    try:
        assert reopened.state().revision == 2
        assert reopened.output_bytes(second.output_id) == (tmp_path / "candidate.pdf").read_bytes()
    finally:
        reopened.close()


@pytest.mark.parametrize("boundary", ["before-worker", "after-worker", "before-reservation-flush", "before-file-flush",
                                     "before-artifact-install", "after-files-prepared", "before-record-flush",
                                     "before-record-switch"])
def test_every_precommit_fault_retains_checkpoint_history_and_saved_output(store, tmp_path, boundary):
    published = store.transact(request_id="save", expected_revision=0, operation="save")
    old = store.state()
    old_bytes = (store.root / "record.json").read_bytes()
    def fail(name):
        if name == boundary:
            raise OSError("injected storage/worker failure")
    store._boundary = fail
    with pytest.raises((OSError, TransitionRejected)):
        store.transact(request_id="edit", expected_revision=0, operation="save-with-draft", pending_draft=True,
                       prepare=prepared(tmp_path / "candidate.pdf", operation="save-with-draft"))
    assert store.state() == old
    assert (store.root / "record.json").read_bytes() == old_bytes
    assert store.output_bytes(published.output_id) == (tmp_path / "source.pdf").read_bytes()
    assert not (store.root / "checkpoints" / "checkpoint_edit.pdf").exists()
    assert not any((store.root / "staging").iterdir())


@pytest.mark.parametrize("boundary", ["after-record-switch", "before-reply"])
def test_postcommit_failure_reports_recorded_success_without_replay(store, tmp_path, boundary):
    def fail(name):
        if name == boundary:
            raise OSError("reply delivery failed")
    store._boundary = fail
    worker = prepared(tmp_path / "candidate.pdf")
    outcome = store.transact(request_id="edit", expected_revision=0, operation="apply", pending_draft=True, prepare=worker)
    assert outcome.revision == 1 and store.state().revision == 1
    assert not any((store.root / "staging").iterdir())
    def must_not_run(*args):
        pytest.fail("duplicate mutation was replayed")
    assert store.transact(request_id="edit", expected_revision=0, operation="apply", pending_draft=True,
                          prepare=must_not_run) == outcome
    assert len(store.state().checkpoints) == 2


def test_cancellation_collision_and_tampering_fail_closed(store, tmp_path):
    old = store.state()
    cancelled = False
    def cancel(name):
        nonlocal cancelled
        if name == "before-record-switch":
            cancelled = True
    store._boundary = cancel
    with pytest.raises(TransitionRejected):
        store.transact(request_id="edit", expected_revision=0, operation="apply", pending_draft=True,
                       prepare=prepared(tmp_path / "candidate.pdf"), cancelled=lambda: cancelled)
    assert store.state() == old
    first, second = tmp_path / "first", tmp_path / "second"
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    with pytest.raises(OSError):
        _move(first, second, replace=False)
    assert first.read_bytes() == b"first" and second.read_bytes() == b"second"
    (store.root / "record.json").write_bytes(b"corrupt record")
    with pytest.raises(UnknownOutcome):
        store.state()
    with pytest.raises(UnknownOutcome):
        store.transact(request_id="later", expected_revision=0, operation="save")
    assert (store.root / "record.json").read_bytes() == b"corrupt record"


def test_preparation_reservation_is_held_and_consumed_exactly(store):
    reservation = store._reserve(4097)
    try:
        assert reservation.stat().st_size == 4097
        store._consume_reservation(reservation, 4096)
        assert reservation.stat().st_size == 1
        store._consume_reservation(reservation, 1)
        assert reservation.stat().st_size == 0
        with pytest.raises(TransitionRejected, match="reservation was lost"):
            store._consume_reservation(reservation, 1)
    finally:
        reservation.unlink(missing_ok=True)


def test_insufficient_preparation_space_rejects_without_eviction(store, tmp_path, monkeypatch):
    old = store.state()
    old_record = (store.root / "record.json").read_bytes()
    monkeypatch.setattr("features.edit_content.commit_store.MAX_PREPARATION_BYTES", 1)
    with pytest.raises(TransitionRejected, match="preparation budget"):
        store.transact(request_id="too-large", expected_revision=0, operation="apply",
                       pending_draft=True,
                       prepare=prepared(tmp_path / "candidate.pdf", request_id="too-large"))
    assert store.state() == old
    assert (store.root / "record.json").read_bytes() == old_record
    assert not (store.root / "checkpoints" / "checkpoint_too-large.pdf").exists()


def test_output_identity_collision_preserves_existing_bytes_and_state(store, monkeypatch):
    existing = store.root / "outputs" / "collision.pdf"
    existing.write_bytes(b"existing private output")
    old = store.state()
    identities = iter(("collision", "reservation", "temporary"))
    monkeypatch.setattr("features.edit_content.commit_store.uuid.uuid4",
                        lambda: SimpleNamespace(hex=next(identities)))
    with pytest.raises(OSError):
        store.transact(request_id="save-collision", expected_revision=0, operation="save")
    assert existing.read_bytes() == b"existing private output"
    assert store.state() == old


def test_unreferenced_orphans_are_never_promoted_on_reopen(store):
    orphan_checkpoint = store.root / "checkpoints" / "orphan.pdf"
    orphan_output = store.root / "outputs" / "orphan.pdf"
    orphan_staging = store.root / "staging" / "orphan"
    for path in (orphan_checkpoint, orphan_output, orphan_staging):
        path.write_bytes(b"uncommitted orphan")
    root, session_id, source_hash = store.root, store.session_id, store.source_hash
    expected = store.state()
    store.close()
    reopened = ContentCommitStore(root, session_id, source_hash)
    try:
        assert reopened.state() == expected
        with pytest.raises(TransitionRejected, match="not published"):
            reopened.output_bytes("orphan")
        assert (root / "checkpoints" / "source.pdf").exists()
    finally:
        reopened.close()


def test_second_coordinator_cannot_own_the_same_store(store):
    with pytest.raises(UnknownOutcome):
        ContentCommitStore(store.root, store.session_id, store.source_hash)


@pytest.mark.parametrize("boundary,expected_revision", [("before-record-switch", 0), ("after-record-switch", 1)])
def test_actual_process_termination_restarts_only_from_the_commit_record(tmp_path, boundary, expected_revision):
    state = source_state(tmp_path / "source.pdf")
    store = ContentCommitStore.create(tmp_path / "owned", state, tmp_path / "source.pdf")
    store.close()
    script = """
import os, sys
from pathlib import Path
from features.edit_content.commit_store import ContentCommitStore
from test_edit_content_commit_store import prepared
root, source_hash, boundary, candidate = sys.argv[1:]
store = ContentCommitStore(Path(root), 'session', source_hash)
def terminate(name):
    if name == boundary:
        os._exit(73)
store._boundary = terminate
store.transact(request_id='edit', expected_revision=0, operation='apply', pending_draft=True, prepare=prepared(Path(candidate)))
raise SystemExit(74)
"""
    backend = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join((str(backend), str(backend / "tests")))
    child = subprocess.run([sys.executable, "-c", script, str(store.root), state.source.source_hash,
                            boundary, str(tmp_path / "candidate.pdf")], env=env, capture_output=True, timeout=30)
    assert child.returncode == 73, child.stderr.decode(errors="replace")
    reopened = ContentCommitStore(store.root, "session", state.source.source_hash)
    try:
        recovered = reopened.state()
        assert recovered.revision == expected_revision
        assert (recovered.known_outcome("edit") is not None) == (expected_revision == 1)
        assert (tmp_path / "source.pdf").read_bytes() == b"synthetic source checkpoint"
    finally:
        reopened.close()
