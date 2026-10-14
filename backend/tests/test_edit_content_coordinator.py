import hashlib
import json
from pathlib import Path

import pytest
from features.edit_content.engine_identity import load_engine_identity

from features.edit_content.commit_store import ContentCommitStore, UnknownOutcome
from features.edit_content.coordinator import ContentCoordinatorError, ContentSessionCoordinator
from features.edit_content.process_adapter import (
    ContentPreparationRejected, ContentWorkerError, PreparedArtifactLease,
)
from features.edit_content.transaction_state import (
    Checkpoint, REQUIRED_CHECKS, SessionState, VERIFIER_POLICY,
)

ENGINE_SHA256 = load_engine_identity().library_sha256


def digest(data):
    return hashlib.sha256(data).hexdigest()


class FakeVerifiedWorker:
    def __init__(self, root):
        self.root = root
        self.is_running = True
        self.revision = 0
        self.preparations = 0
        self.restarts = []
        self.failure = None
        self.tamper = False
        self.restart_failure = False

    def prepare_apply(self, **request):
        self.preparations += 1
        if self.failure:
            raise ContentPreparationRejected(self.failure)
        content = f"accepted-{request['request_id']}".encode()
        path = self.root / f"candidate-{self.preparations}.pdf"
        path.write_bytes(content)
        candidate_hash = digest(content)
        old = request["edit"]["expectedText"]
        replacement = request["edit"]["replacementText"]
        result_text = replacement
        response = {
            "schemaVersion": "edit-content-preparation/v1", "requestId": request["request_id"],
            "sessionId": "session", "status": "prepared", "acceptedRevision": request["expected_revision"],
            "result": {
                "acceptedCheckpointId": request["accepted_checkpoint_id"],
                "baselineHash": request["accepted_artifact_hash"], "candidateToken": "candidate-1-1",
                "candidateHash": candidate_hash, "candidateBytes": len(content),
                "editExpectation": {"target": {"pageIndex": 0, "objectPath": [0], "text": old},
                    "scalarStart": 0, "scalarEnd": len(old), "resultingText": result_text,
                    "objectCountDelta": -1 if not result_text else 0},
                "engineIdentity": {"build": "154.0.8035", "sha256": ENGINE_SHA256, "wrapper": "0.9.4"},
                "verifierIdentity": {"policy": VERIFIER_POLICY},
                "verificationResults": {"baselineHash": request["accepted_artifact_hash"],
                    "candidateHash": candidate_hash, "objectCensus": [0 if not result_text else 1],
                    "oldOccurrencesBefore": 1, "oldOccurrencesAfter": 0,
                    "checks": sorted(REQUIRED_CHECKS)},
            },
        }
        if self.tamper:
            path.write_bytes(b"changed after verification")
        return PreparedArtifactLease(path, response)

    def inspect(self):
        return {"status": "accepted", "acceptedRevision": self.revision,
                "result": {"discovery": {"textObjects": [{"targetId": f"target-{self.revision}"}]}}}

    def restart(self, source, *, accepted_revision=None):
        if self.restart_failure:
            self.is_running = False
            raise ContentWorkerError("restart failed")
        self.revision = accepted_revision
        self.is_running = True
        self.restarts.append((Path(source).read_bytes(), accepted_revision))
        return {"status": "accepted", "acceptedRevision": accepted_revision}

    def start(self, source, *, session_id, accepted_revision):
        self.revision = accepted_revision
        self.is_running = True

    def open(self):
        return {"status": "accepted", "acceptedRevision": self.revision}

    def terminate(self):
        self.is_running = False

    def close(self):
        self.is_running = False
        return {"status": "accepted"}


@pytest.fixture
def coordinator(tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"source bytes")
    source_hash = digest(source.read_bytes())
    checkpoint = Checkpoint("source", 0, None, None, source_hash, source_hash,
                            source.stat().st_size, (1,))
    store = ContentCommitStore.create(tmp_path / "store", SessionState.initial("session", checkpoint), source)
    value = ContentSessionCoordinator(FakeVerifiedWorker(tmp_path), store)
    yield value
    value.close()


def edit(replacement="text"):
    return {"expectedText": "word", "expectedOldText": "word", "replacementText": replacement,
            "utf16Start": 0, "utf16End": 4}


def test_apply_save_history_and_fresh_revision_identities(coordinator):
    applied = coordinator.apply(request_id="apply1", expected_revision=0, target_id="target-0", edit=edit())
    assert applied.revision == 1 and applied.output_id is None
    assert coordinator.state() == {"sessionId": "session", "acceptedRevision": 1,
        "checkpointId": applied.checkpoint_id, "dirty": True, "canUndo": True, "canRedo": False,
        "savedHash": digest(b"source bytes"), "lastOutputId": None}
    assert coordinator.inspect()["result"]["discovery"]["textObjects"][0]["targetId"] == "target-1"
    count = coordinator.adapter.preparations
    saved = coordinator.save(request_id="save1", expected_revision=1)
    assert saved.revision == 1 and coordinator.adapter.preparations == count
    assert coordinator.output_bytes(saved.output_id) == b"accepted-apply1"
    assert not coordinator.state()["dirty"]
    undone = coordinator.undo(request_id="undo1", expected_revision=1)
    assert undone.revision == 2 and coordinator.state()["dirty"]
    assert coordinator.output_bytes(saved.output_id) == b"accepted-apply1"
    redone = coordinator.redo(request_id="redo1", expected_revision=2)
    assert redone.revision == 3 and not coordinator.state()["dirty"]
    assert coordinator.inspect()["result"]["discovery"]["textObjects"][0]["targetId"] == "target-3"


def test_joint_save_with_draft_and_empty_object_removal(coordinator):
    outcome = coordinator.apply(request_id="joint", expected_revision=0, target_id="target-0",
                                edit=edit(""), save=True)
    state = coordinator.store.state()
    assert outcome.revision == 1 and outcome.output_id is not None
    assert state.current.object_census == (0,) and state.current.edit.object_delta == -1
    assert state.saved_hash == state.current.accepted_artifact_hash
    assert coordinator.output_bytes(outcome.output_id) == b"accepted-joint"


def test_rejection_changed_bytes_stale_and_pending_draft_preserve_state(coordinator):
    before = coordinator.store.state()
    coordinator.adapter.failure = "REJECTED_UNSUPPORTED_GLYPH"
    with pytest.raises(ContentCoordinatorError) as rejected:
        coordinator.apply(request_id="bad", expected_revision=0, target_id="target-0", edit=edit())
    assert rejected.value.status == "rejected" and coordinator.store.state() == before
    coordinator.adapter.failure = None
    coordinator.adapter.tamper = True
    with pytest.raises(ContentCoordinatorError):
        coordinator.apply(request_id="changed", expected_revision=0, target_id="target-0", edit=edit())
    assert coordinator.store.state() == before
    with pytest.raises(ContentCoordinatorError):
        coordinator.apply(request_id="stale", expected_revision=9, target_id="target-0", edit=edit())
    assert coordinator.store.state() == before
    with pytest.raises(ContentCoordinatorError):
        coordinator.undo(request_id="draft", expected_revision=0, pending_draft=True)
    assert coordinator.store.state() == before


def test_duplicate_committed_request_never_reinvokes_worker(coordinator):
    first = coordinator.apply(request_id="same", expected_revision=0, target_id="target-0", edit=edit())
    count = coordinator.adapter.preparations
    second = coordinator.apply(request_id="same", expected_revision=0, target_id="expired", edit=edit())
    assert second == first and coordinator.adapter.preparations == count
    assert len(coordinator.store.state().checkpoints) == 2


def test_tampered_commit_record_blocks_all_mutation_without_replay(coordinator):
    (coordinator.store.root / "record.json").write_bytes(b"tampered")
    with pytest.raises(UnknownOutcome):
        coordinator.store.state()
    before = coordinator.adapter.preparations
    with pytest.raises(ContentCoordinatorError) as unknown:
        coordinator.apply(request_id="blocked", expected_revision=0, target_id="target-0", edit=edit())
    assert unknown.value.status == "unknown" and coordinator.adapter.preparations == before
    assert (coordinator.store.root / "record.json").read_bytes() == b"tampered"


def test_worker_crash_during_preparation_is_proven_precommit_and_restartable(coordinator):
    before = coordinator.store.state()
    original = coordinator.adapter.prepare_apply

    def crash(**_request):
        coordinator.adapter.is_running = False
        raise ContentWorkerError("Content worker is unavailable")

    coordinator.adapter.prepare_apply = crash
    with pytest.raises(ContentCoordinatorError) as rejected:
        coordinator.apply(request_id="crash", expected_revision=0,
                          target_id="target-0", edit=edit())
    assert rejected.value.status == "rejected"
    assert coordinator.store.state() == before
    coordinator.adapter.prepare_apply = original
    accepted = coordinator.apply(request_id="after-crash", expected_revision=0,
                                 target_id="target-0", edit=edit())
    assert accepted.revision == 1


def test_restart_failure_after_commit_does_not_roll_back_or_replay(coordinator):
    coordinator.adapter.restart_failure = True
    committed = coordinator.apply(request_id="committed", expected_revision=0,
                                  target_id="target-0", edit=edit())
    assert committed.revision == 1
    assert coordinator.store.state().known_outcome("committed") == committed
    assert not coordinator.adapter.is_running
    preparations = coordinator.adapter.preparations

    coordinator.adapter.restart_failure = False
    duplicate = coordinator.apply(request_id="committed", expected_revision=0,
                                  target_id="stale-target", edit=edit())
    assert duplicate == committed
    assert coordinator.adapter.preparations == preparations


def test_stale_selection_after_undo_cannot_prepare(coordinator):
    coordinator.apply(request_id="apply", expected_revision=0,
                      target_id="target-0", edit=edit())
    coordinator.undo(request_id="undo", expected_revision=1)
    preparations = coordinator.adapter.preparations
    with pytest.raises(ContentCoordinatorError, match="stale"):
        coordinator.apply(request_id="stale-selection", expected_revision=1,
                          target_id="target-1", edit=edit())
    assert coordinator.adapter.preparations == preparations
    assert coordinator.store.state().revision == 2


def test_clean_rejection_keeps_the_worker_but_a_dead_or_unknown_one_is_restarted(coordinator):
    adapter = coordinator.adapter
    adapter.failure = "REJECTED_UNSUPPORTED_GLYPH"
    with pytest.raises(ContentCoordinatorError) as rejected:
        coordinator.apply(request_id="clean", expected_revision=0, target_id="target-0", edit=edit())
    assert rejected.value.status == "rejected"
    # The candidate lived on a private copy; the worker's accepted document is unchanged.
    assert adapter.restarts == [] and adapter.is_running is True

    def rejected_then_died(**_request):
        adapter.is_running = False
        raise ContentPreparationRejected("REJECTED_COLLATERAL_INTEGRITY")

    adapter.prepare_apply = rejected_then_died
    with pytest.raises(ContentCoordinatorError):
        coordinator.apply(request_id="died", expected_revision=0, target_id="target-0", edit=edit())
    assert len(adapter.restarts) == 1

    def unknown(**_request):
        raise ContentPreparationRejected("worker outcome unknown", unknown=True)

    adapter.prepare_apply = unknown
    with pytest.raises(ContentCoordinatorError) as unknown_outcome:
        coordinator.apply(request_id="unknown", expected_revision=0, target_id="target-0", edit=edit())
    assert unknown_outcome.value.status == "unknown"
    assert len(adapter.restarts) == 2


def test_preflight_is_a_read_only_dry_run_that_reports_ineligible_edits(coordinator):
    calls = []

    def inspect_request(**request):
        calls.append(request)
        eligible = request["payload"]["replacementText"] != "q"
        return {
            "status": "accepted" if eligible else "rejected", "acceptedRevision": 0,
            "result": {"preflight": {
                "eligible": eligible, "guardReasons": [] if eligible else ["REJECTED_UNSUPPORTED_GLYPH"],
                "primaryGuardReason": None if eligible else "REJECTED_UNSUPPORTED_GLYPH",
                "detailCodes": [] if eligible else ["MISSING_GLYPH"], "unsupportedCodePoints": [] if eligible else [113],
            }},
        }

    coordinator.adapter.inspect_request = inspect_request
    before = coordinator.store.state()
    good = coordinator.preflight(request_id="p1", expected_revision=0, target_id="target-0", edit=edit("e"))
    bad = coordinator.preflight(request_id="p2", expected_revision=0, target_id="target-0", edit=edit("q"))
    assert good["eligible"] is True and bad["eligible"] is False and bad["detailCodes"] == ["MISSING_GLYPH"]
    assert calls[0]["payload"]["operation"] == "preflight" and calls[0]["target_id"] == "target-0"
    assert coordinator.store.state() == before and coordinator.adapter.preparations == 0
    with pytest.raises(ContentCoordinatorError) as stale:
        coordinator.preflight(request_id="p3", expected_revision=5, target_id="target-0", edit=edit())
    assert stale.value.status == "stale"


class FlakyOpenAdapter:
    """Worker whose first open times out; used to prove the one safe retry."""

    instances = []
    open_failures = 1
    inspect_status = "accepted"

    def __init__(self, _config):
        self.index = len(FlakyOpenAdapter.instances)
        FlakyOpenAdapter.instances.append(self)
        self.terminated = False
        self.source = None

    def start(self, source, *, session_id, accepted_revision):
        self.source = Path(source)
        return session_id

    def open(self):
        if self.index < FlakyOpenAdapter.open_failures:
            raise ContentWorkerError("Content worker command timed out", code="OPEN_TIMEOUT")
        data = self.source.read_bytes()
        return {"status": "accepted", "acceptedRevision": 0,
                "result": {"sourceSha256": digest(data), "sourceBytes": len(data)}}

    def inspect(self):
        return {"status": FlakyOpenAdapter.inspect_status, "acceptedRevision": 0,
                "result": {"discovery": {"pages": [{"pageIndex": 0}], "textObjects": [{"pageIndex": 0}], "viewOnlyObjects": []}}}

    def restart(self, source, *, accepted_revision=None):
        return {"status": "accepted", "acceptedRevision": accepted_revision}

    def terminate(self):
        self.terminated = True

    def close(self):
        return {"status": "accepted"}


@pytest.fixture
def flaky(monkeypatch):
    from features.edit_content import coordinator as module
    FlakyOpenAdapter.instances = []
    FlakyOpenAdapter.open_failures = 1
    FlakyOpenAdapter.inspect_status = "accepted"
    monkeypatch.setattr(module, "ContentWorkerAdapter", FlakyOpenAdapter)
    return FlakyOpenAdapter


def test_open_retries_once_after_a_worker_timeout(flaky, tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.4 source")
    created = ContentSessionCoordinator.create(object(), tmp_path / "store", source, session_id="session")
    try:
        assert len(flaky.instances) == 2 and flaky.instances[0].terminated is True
    finally:
        created.close()


def test_open_gives_up_after_the_retry_and_keeps_the_specific_code(flaky, tmp_path):
    flaky.open_failures = 5
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.4 source")
    with pytest.raises(ContentWorkerError) as failed:
        ContentSessionCoordinator.create(object(), tmp_path / "store", source, session_id="session")
    assert failed.value.code == "OPEN_TIMEOUT" and len(flaky.instances) == 2


def test_rejected_document_is_diagnosed_and_never_retried(flaky, tmp_path):
    from pypdf import PdfWriter

    flaky.open_failures = 0
    flaky.inspect_status = "rejected"
    writer = PdfWriter()
    writer.add_blank_page(100, 100)
    writer.encrypt("", owner_password="owner", algorithm="RC4-128")
    source = tmp_path / "locked.pdf"
    with source.open("wb") as handle:
        writer.write(handle)
    with pytest.raises(ContentCoordinatorError) as rejected:
        ContentSessionCoordinator.create(object(), tmp_path / "store", source, session_id="session")
    assert rejected.value.status == "rejected" and rejected.value.reason == "PDF_ENCRYPTED"
    assert len(flaky.instances) == 1 and flaky.instances[0].terminated is True
