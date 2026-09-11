from dataclasses import replace

import pytest

from features.edit_content.transaction_state import (
    Checkpoint, EditMetadata, ENGINE_SHA256, MAX_CHECKPOINT_BYTES,
    Publication, REQUIRED_CHECKS, SessionState, TransitionRejected,
    VERIFIER_POLICY, prepare_transition,
)


def initial():
    return SessionState.initial("session", Checkpoint("source", 0, None, None, "0" * 64, "0" * 64, 500, (2, 3)))


def edit(state, request_id="edit1", operation="apply", artifact_hash="1" * 64):
    metadata = EditMetadata(request_id, operation, 0, (0,), 0, 4, "word", "text", 1, 0, 0,
                            state.current.accepted_artifact_hash, ENGINE_SHA256, "154.0.8035", "0.9.4",
                            VERIFIER_POLICY, tuple(sorted(REQUIRED_CHECKS)))
    return Checkpoint(f"checkpoint_{request_id}", state.revision + 1, state.revision,
                      state.current.checkpoint_id, state.source.source_hash, artifact_hash, 600,
                      state.current.object_census, metadata)


def apply(state, request_id="edit1", **kwargs):
    checkpoint = edit(state, request_id, **kwargs)
    return prepare_transition(state, request_id=request_id, expected_revision=state.revision,
                              operation="apply", pending_draft=True, checkpoint=checkpoint)


def test_prepared_is_not_accepted_and_failed_save_does_not_change_state():
    state = initial()
    prepared = apply(state)
    assert state.revision == 0 and len(state.checkpoints) == 1
    assert state.known_outcome("edit1") is None
    assert not state.dirty(pending_draft=False)
    assert prepared.next_state.dirty(pending_draft=False)
    assert prepared.outcome.clear_draft
    committed = prepared.next_state  # This test models the external atomic commit.
    with pytest.raises(TransitionRejected):
        prepare_transition(committed, request_id="save1", expected_revision=1, operation="save",
                           publication=Publication("out", "9" * 64, 600))
    assert committed.saved_hash == state.saved_hash
    assert committed.publications == ()


def test_save_with_draft_is_joint_and_unchanged_save_reuses_checkpoint():
    state = initial()
    checkpoint = edit(state, operation="save-with-draft")
    publication = Publication("out1", checkpoint.accepted_artifact_hash, checkpoint.byte_size)
    prepared = prepare_transition(state, request_id="edit1", expected_revision=0,
                                  operation="save-with-draft", pending_draft=True,
                                  checkpoint=checkpoint, publication=publication)
    assert state.publications == () and state.revision == 0
    committed = prepared.next_state
    assert committed.revision == 1 and not committed.dirty(pending_draft=False)
    saved = prepare_transition(committed, request_id="save2", expected_revision=1, operation="save",
                               publication=replace(publication, output_id="out2")).next_state
    assert saved.current is committed.current
    assert saved.checkpoints == committed.checkpoints and saved.revision == 1
    assert len(saved.publications) == 2
    assert not saved.outcomes[-1].clear_draft


def test_undo_redo_revisions_dirty_and_pending_draft_are_independent():
    state = apply(initial()).next_state
    saved = prepare_transition(state, request_id="save", expected_revision=1, operation="save",
                               publication=Publication("out", state.current.accepted_artifact_hash, 600)).next_state
    for operation in ("undo", "redo", "save"):
        with pytest.raises(TransitionRejected):
            prepare_transition(saved, request_id="pending", expected_revision=1, operation=operation, pending_draft=True)
    undone = prepare_transition(saved, request_id="undo", expected_revision=1, operation="undo").next_state
    assert undone.current.accepted_revision == 0 and undone.revision == 2
    assert undone.dirty(pending_draft=False)
    assert undone.publications == saved.publications
    redone = prepare_transition(undone, request_id="redo", expected_revision=2, operation="redo").next_state
    assert redone.current.accepted_revision == 1 and redone.revision == 3
    assert not redone.dirty(pending_draft=False)
    assert redone.dirty(pending_draft=True)
    with pytest.raises(TransitionRejected):
        prepare_transition(redone, request_id="stale", expected_revision=1, operation="undo")


def test_redo_truncation_and_budget_eviction_exist_only_in_prepared_state():
    state = initial()
    for index in range(1, 10):
        state = apply(state, f"edit{index}", artifact_hash=f"{index:064x}").next_state
    assert len(state.checkpoints) == 8 and state.checkpoints[0] == state.source
    assert state.checkpoints[1].edit.request_id == "edit3"
    undone = prepare_transition(state, request_id="undo", expected_revision=state.revision, operation="undo").next_state
    prepared = apply(undone, "branch", artifact_hash="a" * 64)
    assert undone.checkpoints[-1].edit.request_id == "edit9"
    assert prepared.next_state.checkpoints[-1].edit.request_id == "branch"
    assert prepared.evicted_checkpoint_ids == ("checkpoint_edit9",)
    assert prepared.next_state.source == state.source


def test_invalid_evidence_oversize_census_and_duplicates_never_prepare():
    state = initial()
    checkpoint = edit(state)
    invalid = [replace(checkpoint, byte_size=MAX_CHECKPOINT_BYTES + 1),
               replace(checkpoint, object_census=(2, 4)),
               replace(checkpoint, edit=replace(checkpoint.edit, checks=())),
               replace(checkpoint, edit=replace(checkpoint.edit, engine_sha256="b" * 64)),
               replace(checkpoint, edit=replace(checkpoint.edit, baseline_hash="b" * 64))]
    for value in invalid:
        with pytest.raises(TransitionRejected):
            prepare_transition(state, request_id="edit1", expected_revision=0, operation="apply",
                               pending_draft=True, checkpoint=value)
        assert state.current == state.source
    committed = apply(state).next_state
    assert committed.known_outcome("edit1").revision == 1
    with pytest.raises(TransitionRejected, match="without replay"):
        apply(committed)
