"""Pure preparation contracts for the Content coordinator's single commit.

No function in this module accepts a worker reply as a committed outcome or
performs I/O. A PreparedTransition becomes visible only after the coordinator
has verified/installed its files and atomically switched the commit record.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import re

from features.edit_content.engine_identity import load_engine_identity


MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024
MAX_HISTORY_BYTES = 128 * 1024 * 1024
MAX_HISTORY_ENTRIES = 8
VERIFIER_POLICY = "edit-content-acceptance/v2"
_ENGINE_IDENTITY = load_engine_identity()
ENGINE_SHA256 = _ENGINE_IDENTITY.library_sha256
ENGINE_BUILD = _ENGINE_IDENTITY.build.removesuffix(".0")
ENGINE_WRAPPER = _ENGINE_IDENTITY.wrapper
REQUIRED_CHECKS = frozenset({
    "target", "occurrences", "unique-correspondence", "font-identity",
    "geometry-style", "census", "resources", "layout",
})


class TransitionRejected(ValueError):
    """Safe known pre-commit failure; the caller retains its state and draft."""


def _hash(value: str) -> None:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise TransitionRejected("invalid artifact identity")


def _id(value: str) -> None:
    if not isinstance(value, str) or re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", value) is None:
        raise TransitionRejected("invalid opaque identity")


@dataclass(frozen=True)
class EditMetadata:
    request_id: str
    operation: str
    page_index: int
    source_scope: tuple[int, ...]
    scalar_start: int
    scalar_end: int
    before_text: str
    after_text: str
    occurrence_before: int
    occurrence_after: int
    object_delta: int
    baseline_hash: str
    engine_sha256: str
    engine_build: str
    wrapper: str
    verifier_policy: str
    checks: tuple[str, ...]

    def validate(self) -> None:
        _id(self.request_id)
        _hash(self.baseline_hash)
        if self.operation not in {"apply", "save-with-draft"}:
            raise TransitionRejected("invalid edit operation")
        if not 0 <= self.page_index < 256 or len(self.source_scope) != 1 or self.source_scope[0] < 0:
            raise TransitionRejected("invalid target scope")
        if not 0 <= self.scalar_start < self.scalar_end <= len(self.before_text):
            raise TransitionRejected("invalid scalar selection")
        prefix, suffix = self.before_text[:self.scalar_start], self.before_text[self.scalar_end:]
        if len(self.after_text) < len(prefix) + len(suffix) or not self.after_text.startswith(prefix) or not self.after_text.endswith(suffix):
            raise TransitionRejected("invalid target expectation")
        if min(self.occurrence_before, self.occurrence_after) < 0 or self.object_delta != (-1 if not self.after_text else 0):
            raise TransitionRejected("invalid planned counts")
        if (self.engine_sha256 != ENGINE_SHA256 or self.engine_build != ENGINE_BUILD
                or self.wrapper != ENGINE_WRAPPER or self.verifier_policy != VERIFIER_POLICY
                or set(self.checks) != REQUIRED_CHECKS or len(self.checks) != len(REQUIRED_CHECKS)):
            raise TransitionRejected("missing verification identity")


@dataclass(frozen=True)
class Checkpoint:
    checkpoint_id: str
    accepted_revision: int
    parent_accepted_revision: int | None
    parent_checkpoint_id: str | None
    source_hash: str
    accepted_artifact_hash: str
    byte_size: int
    object_census: tuple[int, ...]
    edit: EditMetadata | None = None

    def validate(self) -> None:
        _id(self.checkpoint_id)
        _hash(self.source_hash)
        _hash(self.accepted_artifact_hash)
        if not 0 < self.byte_size <= MAX_CHECKPOINT_BYTES:
            raise TransitionRejected("checkpoint exceeds the byte limit")
        if not 0 < len(self.object_census) <= 256 or any(count < 0 for count in self.object_census):
            raise TransitionRejected("invalid object census")
        if self.edit is None:
            if (self.accepted_revision != 0 or self.parent_accepted_revision is not None
                    or self.parent_checkpoint_id is not None or self.accepted_artifact_hash != self.source_hash):
                raise TransitionRejected("invalid source checkpoint")
        else:
            self.edit.validate()
            _id(self.parent_checkpoint_id)
            if self.parent_accepted_revision is None or self.accepted_revision != self.parent_accepted_revision + 1:
                raise TransitionRejected("invalid checkpoint creation revision")


@dataclass(frozen=True)
class Publication:
    output_id: str
    artifact_hash: str
    byte_size: int

    def validate(self) -> None:
        _id(self.output_id)
        _hash(self.artifact_hash)
        if not 0 < self.byte_size <= MAX_CHECKPOINT_BYTES:
            raise TransitionRejected("output exceeds the byte limit")


@dataclass(frozen=True)
class Outcome:
    request_id: str
    revision: int
    checkpoint_id: str
    output_id: str | None
    clear_draft: bool


@dataclass(frozen=True)
class SessionState:
    session_id: str
    source: Checkpoint
    revision: int
    checkpoints: tuple[Checkpoint, ...]
    cursor: int
    saved_hash: str
    last_output_id: str | None = None
    publications: tuple[Publication, ...] = ()
    outcomes: tuple[Outcome, ...] = ()

    @classmethod
    def initial(cls, session_id: str, source: Checkpoint) -> SessionState:
        state = cls(session_id, source, 0, (source,), 0, source.source_hash)
        state.validate()
        return state

    @property
    def current(self) -> Checkpoint:
        return self.checkpoints[self.cursor]

    def dirty(self, *, pending_draft: bool) -> bool:
        return pending_draft or self.current.accepted_artifact_hash != self.saved_hash

    def known_outcome(self, request_id: str) -> Outcome | None:
        return next((outcome for outcome in self.outcomes if outcome.request_id == request_id), None)

    def validate(self) -> None:
        _id(self.session_id)
        self.source.validate()
        _hash(self.saved_hash)
        if self.source.edit is not None or not 0 <= self.cursor < len(self.checkpoints) <= MAX_HISTORY_ENTRIES:
            raise TransitionRejected("invalid history state")
        if self.revision < 0 or sum(item.byte_size for item in self.checkpoints) > MAX_HISTORY_BYTES:
            raise TransitionRejected("history exceeds its budget")
        identities = set()
        for checkpoint in self.checkpoints:
            checkpoint.validate()
            if (checkpoint.source_hash != self.source.source_hash or checkpoint.checkpoint_id in identities
                    or checkpoint.accepted_revision > self.revision):
                raise TransitionRejected("invalid checkpoint identity")
            identities.add(checkpoint.checkpoint_id)
            if checkpoint.checkpoint_id == self.source.checkpoint_id and checkpoint != self.source:
                raise TransitionRejected("source checkpoint changed")
        publications = {}
        for publication in self.publications:
            publication.validate()
            if publication.output_id in publications:
                raise TransitionRejected("duplicate publication identity")
            publications[publication.output_id] = publication
        if self.last_output_id is None:
            if self.saved_hash != self.source.source_hash:
                raise TransitionRejected("invalid saved marker")
        elif self.last_output_id not in publications or publications[self.last_output_id].artifact_hash != self.saved_hash:
            raise TransitionRejected("invalid saved publication")
        if len({outcome.request_id for outcome in self.outcomes}) != len(self.outcomes):
            raise TransitionRejected("duplicate request outcome")


@dataclass(frozen=True)
class PreparedTransition:
    expected_revision: int
    baseline_hash: str
    next_state: SessionState
    outcome: Outcome
    evicted_checkpoint_ids: tuple[str, ...] = ()


def prepare_transition(
    state: SessionState, *, request_id: str, expected_revision: int, operation: str,
    pending_draft: bool = False, checkpoint: Checkpoint | None = None,
    publication: Publication | None = None,
) -> PreparedTransition:
    """Plan references only. No eviction, draft clearing, or accepted reply yet."""
    state.validate()
    _id(request_id)
    if state.known_outcome(request_id) is not None:
        raise TransitionRejected("return the recorded outcome without replay")
    if expected_revision != state.revision:
        raise TransitionRejected("stale accepted revision")
    history = list(state.checkpoints)
    cursor, revision = state.cursor, state.revision
    evicted: list[str] = []
    editing = operation in {"apply", "save-with-draft"}
    publishing = operation in {"save", "save-with-draft"}
    if operation not in {"apply", "save-with-draft", "save", "undo", "redo"}:
        raise TransitionRejected("unknown operation")
    if editing != (checkpoint is not None) or publishing != (publication is not None):
        raise TransitionRejected("incomplete preparation")
    if pending_draft != editing:
        raise TransitionRejected("apply or explicitly discard the draft first")
    if editing:
        checkpoint.validate()
        if (checkpoint.edit is None or checkpoint.edit.request_id != request_id
                or checkpoint.edit.operation != operation or checkpoint.source_hash != state.source.source_hash
                or checkpoint.parent_checkpoint_id != state.current.checkpoint_id
                or checkpoint.parent_accepted_revision != revision or checkpoint.accepted_revision != revision + 1
                or checkpoint.edit.baseline_hash != state.current.accepted_artifact_hash
                or checkpoint.checkpoint_id in {item.checkpoint_id for item in history}):
            raise TransitionRejected("candidate is not bound to the current checkpoint")
        expected_census = list(state.current.object_census)
        if checkpoint.edit.page_index >= len(expected_census):
            raise TransitionRejected("target page is absent")
        expected_census[checkpoint.edit.page_index] += checkpoint.edit.object_delta
        if tuple(expected_census) != checkpoint.object_census:
            raise TransitionRejected("candidate census differs from the planned target delta")
        evicted.extend(item.checkpoint_id for item in history[cursor + 1:])
        history = history[:cursor + 1] + [checkpoint]
        revision += 1
        while len(history) > MAX_HISTORY_ENTRIES or sum(item.byte_size for item in history) > MAX_HISTORY_BYTES:
            eligible = next((index for index, item in enumerate(history[:-1]) if item.checkpoint_id != state.source.checkpoint_id), None)
            if eligible is None:
                raise TransitionRejected("insufficient history budget")
            evicted.append(history.pop(eligible).checkpoint_id)
        cursor = len(history) - 1
    elif operation in {"undo", "redo"}:
        cursor += -1 if operation == "undo" else 1
        if not 0 <= cursor < len(history):
            raise TransitionRejected("history boundary")
        revision += 1
    saved_hash, last_output_id = state.saved_hash, state.last_output_id
    publications = state.publications
    if publishing:
        publication.validate()
        if (publication.artifact_hash != history[cursor].accepted_artifact_hash
                or publication.byte_size != history[cursor].byte_size
                or publication.output_id in {item.output_id for item in publications}):
            raise TransitionRejected("publication does not identify exact accepted bytes")
        publications += (publication,)
        saved_hash, last_output_id = publication.artifact_hash, publication.output_id
    outcome = Outcome(request_id, revision, history[cursor].checkpoint_id, last_output_id if publishing else None, editing)
    prepared = replace(state, revision=revision, checkpoints=tuple(history), cursor=cursor,
                       saved_hash=saved_hash, last_output_id=last_output_id, publications=publications,
                       outcomes=state.outcomes + (outcome,))
    prepared.validate()
    return PreparedTransition(state.revision, state.current.accepted_artifact_hash, prepared, outcome,
                              tuple(item for item in evicted if item != state.source.checkpoint_id))
