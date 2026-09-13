"""Internal phase-5 coordinator. No HTTP routes are registered here."""

from __future__ import annotations

from dataclasses import asdict
import hashlib
from pathlib import Path
import threading
from typing import Any, Callable
import uuid

from features.edit_content.commit_store import ContentCommitStore, UnknownOutcome
from features.edit_content.engine_identity import load_engine_identity
from features.edit_content.process_adapter import (
    ContentPreparationRejected, ContentWorkerAdapter, ContentWorkerError, PreparedArtifactLease,
    WorkerLaunchConfig,
)
from features.edit_content.transaction_state import (
    Checkpoint, EditMetadata, Outcome, REQUIRED_CHECKS, SessionState,
    TransitionRejected, VERIFIER_POLICY,
)


class ContentCoordinatorError(RuntimeError):
    def __init__(self, status: str, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


class ContentSessionCoordinator:
    """Sole authority for accepted Content revision/history/publication state."""

    def __init__(self, adapter: ContentWorkerAdapter, store: ContentCommitStore):
        self.adapter = adapter
        self.store = store
        self._lock = threading.RLock()

    @classmethod
    def create(
        cls, config: WorkerLaunchConfig, storage_parent: Path, source: Path,
        *, session_id: str | None = None,
    ) -> ContentSessionCoordinator:
        adapter = ContentWorkerAdapter(config)
        active_session = adapter.start(source, session_id=session_id, accepted_revision=0)
        store = None
        try:
            opened = adapter.open()
            inspected = adapter.inspect()
            if opened.get("status") != "accepted" or inspected.get("status") != "accepted":
                raise ContentCoordinatorError("rejected", "REJECTED_UNSUPPORTED_STRUCTURE")
            result = opened.get("result", {})
            digest = result.get("sourceSha256")
            size = result.get("sourceBytes")
            census = _object_census(inspected)
            if digest != _file_hash(source) or not isinstance(size, int) or size != source.stat().st_size:
                raise ContentCoordinatorError("unknown", "source identity could not be established")
            checkpoint = Checkpoint("source", 0, None, None, digest, digest, size, census)
            storage_parent = Path(storage_parent)
            storage_parent.mkdir(parents=True, exist_ok=True)
            store = ContentCommitStore.create(storage_parent / active_session, SessionState.initial(active_session, checkpoint), source)
            coordinator = cls(adapter, store)
            coordinator._restart_current()
            return coordinator
        except BaseException:
            adapter.terminate()
            if store is not None:
                store.close()
            raise

    @classmethod
    def reopen(
        cls, config: WorkerLaunchConfig, store_root: Path, *, session_id: str, source_hash: str | None = None,
    ) -> ContentSessionCoordinator:
        store = (ContentCommitStore.recover(store_root, session_id) if source_hash is None
                 else ContentCommitStore(store_root, session_id, source_hash))
        adapter = ContentWorkerAdapter(config)
        coordinator = cls(adapter, store)
        try:
            # A new adapter has no prior session identity to carry into restart.
            coordinator._ensure_worker()
            return coordinator
        except BaseException:
            adapter.terminate()
            store.close()
            raise

    def inspect(
        self,
        *,
        request_id: str | None = None,
        expected_revision: int | None = None,
        target_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            self._ensure_worker()
            state = self.store.state()
            revision = state.revision if expected_revision is None else expected_revision
            if revision != state.revision:
                raise ContentCoordinatorError("stale", "REJECTED_STALE_REVISION")
            if request_id is None and expected_revision is None and target_id is None and payload is None:
                reply = self.adapter.inspect()
            else:
                reply = self.adapter.inspect_request(
                    request_id=request_id,
                    expected_revision=revision,
                    target_id=target_id,
                    payload=payload,
                )
            return self._checked_read_reply(reply, state.revision)

    def render(
        self,
        *,
        request_id: str,
        expected_revision: int,
        page_index: int,
        width_px: int,
        height_px: int,
    ) -> dict[str, Any]:
        with self._lock:
            self._ensure_worker()
            state = self.store.state()
            if expected_revision != state.revision:
                raise ContentCoordinatorError("stale", "REJECTED_STALE_REVISION")
            reply = self.adapter.render(
                request_id=request_id,
                expected_revision=expected_revision,
                page_index=page_index,
                width_px=width_px,
                height_px=height_px,
            )
            return self._checked_read_reply(reply, state.revision)

    def apply(
        self, *, request_id: str, expected_revision: int, target_id: str,
        edit: dict[str, Any], save: bool = False, cancelled: Callable[[], bool] = lambda: False,
    ) -> Outcome:
        operation = "save-with-draft" if save else "apply"
        with self._lock:
            try:
                self._ensure_worker()
            except UnknownOutcome as exc:
                self.adapter.terminate()
                raise ContentCoordinatorError("unknown", str(exc)) from exc
            def prepare(state: SessionState, accepted_path: Path):
                lease = self.adapter.prepare_apply(
                    request_id=request_id, expected_revision=expected_revision, target_id=target_id,
                    accepted_checkpoint_id=state.current.checkpoint_id,
                    accepted_artifact_hash=state.current.accepted_artifact_hash, edit=edit,
                )
                return self._checkpoint_from_preparation(state, operation, lease)
            try:
                outcome = self.store.transact(
                    request_id=request_id, expected_revision=expected_revision, operation=operation,
                    pending_draft=True, prepare=prepare, cancelled=cancelled,
                )
            except ContentPreparationRejected as exc:
                self._restore_after_failure()
                raise ContentCoordinatorError("unknown" if exc.unknown else "rejected", exc.reason) from exc
            except ContentWorkerError as exc:
                # The coordinator is the sole commit authority. If preparation
                # did not return, this request cannot have crossed its commit.
                self._restore_after_failure()
                raise ContentCoordinatorError("rejected", str(exc)) from exc
            except (TransitionRejected, OSError) as exc:
                self._restore_after_failure()
                raise ContentCoordinatorError("rejected", str(exc)) from exc
            except UnknownOutcome as exc:
                self.adapter.terminate()
                raise ContentCoordinatorError("unknown", str(exc)) from exc
            self._restart_after_commit()
            return outcome

    def save(
        self, *, request_id: str, expected_revision: int,
        cancelled: Callable[[], bool] = lambda: False,
    ) -> Outcome:
        return self._history_or_save(request_id, expected_revision, "save", cancelled)

    def undo(
        self, *, request_id: str, expected_revision: int, pending_draft: bool = False,
        cancelled: Callable[[], bool] = lambda: False,
    ) -> Outcome:
        if pending_draft:
            raise ContentCoordinatorError("rejected", "apply or explicitly discard the draft first")
        return self._history_or_save(request_id, expected_revision, "undo", cancelled)

    def redo(
        self, *, request_id: str, expected_revision: int, pending_draft: bool = False,
        cancelled: Callable[[], bool] = lambda: False,
    ) -> Outcome:
        if pending_draft:
            raise ContentCoordinatorError("rejected", "apply or explicitly discard the draft first")
        return self._history_or_save(request_id, expected_revision, "redo", cancelled)

    def _history_or_save(
        self, request_id: str, revision: int, operation: str, cancelled: Callable[[], bool],
    ) -> Outcome:
        with self._lock:
            try:
                self._ensure_worker()
            except UnknownOutcome as exc:
                self.adapter.terminate()
                raise ContentCoordinatorError("unknown", str(exc)) from exc
            try:
                outcome = self.store.transact(request_id=request_id, expected_revision=revision,
                                              operation=operation, cancelled=cancelled)
            except (TransitionRejected, OSError) as exc:
                raise ContentCoordinatorError("rejected", str(exc)) from exc
            except UnknownOutcome as exc:
                self.adapter.terminate()
                raise ContentCoordinatorError("unknown", str(exc)) from exc
            if operation != "save":
                self._restart_after_commit()
            return outcome

    def state(self, *, pending_draft: bool = False) -> dict[str, Any]:
        with self._lock:
            state = self.store.state()
            return {"sessionId": state.session_id, "acceptedRevision": state.revision,
                    "checkpointId": state.current.checkpoint_id, "dirty": state.dirty(pending_draft=pending_draft),
                    "canUndo": state.cursor > 0, "canRedo": state.cursor + 1 < len(state.checkpoints),
                    "savedHash": state.saved_hash, "lastOutputId": state.last_output_id}

    def output_bytes(self, output_id: str) -> bytes:
        return self.store.output_bytes(output_id)

    def close(self) -> None:
        with self._lock:
            try:
                self.adapter.close()
            finally:
                self.store.close()

    def _checkpoint_from_preparation(
        self, state: SessionState, operation: str, lease: PreparedArtifactLease,
    ) -> tuple[Checkpoint, Path]:
        response = lease.response
        result = response.get("result")
        if (response.get("status") != "prepared" or response.get("acceptedRevision") != state.revision
                or not isinstance(result, dict) or result.get("acceptedCheckpointId") != state.current.checkpoint_id):
            raise TransitionRejected("invalid preparation binding")
        expectation = result.get("editExpectation")
        verification = result.get("verificationResults")
        engine = result.get("engineIdentity")
        verifier = result.get("verifierIdentity")
        if not all(isinstance(value, dict) for value in (expectation, verification, engine, verifier)):
            raise TransitionRejected("incomplete preparation evidence")
        target = expectation.get("target")
        checks = verification.get("checks")
        if (not isinstance(target, dict) or not isinstance(checks, list)
                or set(checks) != REQUIRED_CHECKS or len(checks) != len(REQUIRED_CHECKS)
                or result.get("baselineHash") != state.current.accepted_artifact_hash
                or verification.get("baselineHash") != state.current.accepted_artifact_hash
                or result.get("candidateHash") != verification.get("candidateHash")
                or engine != load_engine_identity().verification_identity()
                or verifier != {"policy": VERIFIER_POLICY}):
            raise TransitionRejected("preparation verification identity is invalid")
        metadata = EditMetadata(
            response["requestId"], operation, target.get("pageIndex"), tuple(target.get("objectPath", ())),
            expectation.get("scalarStart"), expectation.get("scalarEnd"), target.get("text"),
            expectation.get("resultingText"), verification.get("oldOccurrencesBefore"),
            verification.get("oldOccurrencesAfter"), expectation.get("objectCountDelta"),
            result["baselineHash"], engine["sha256"], engine["build"], engine["wrapper"],
            verifier["policy"], tuple(checks),
        )
        checkpoint = Checkpoint(
            "checkpoint_" + uuid.uuid4().hex, state.revision + 1, state.revision,
            state.current.checkpoint_id, state.source.source_hash, result.get("candidateHash"),
            result.get("candidateBytes"), tuple(verification.get("objectCensus", ())), metadata,
        )
        checkpoint.validate()
        if _file_hash(lease.path) != checkpoint.accepted_artifact_hash or lease.path.stat().st_size != checkpoint.byte_size:
            raise TransitionRejected("prepared candidate bytes changed")
        return checkpoint, lease.path

    def _ensure_worker(self) -> None:
        state = self.store.state()
        if not self.adapter.is_running:
            self.adapter.start(self.store.checkpoint_path(), session_id=state.session_id,
                               accepted_revision=state.revision)
            opened = self.adapter.open()
            if opened.get("status") != "accepted" or opened.get("acceptedRevision") != state.revision:
                self.adapter.terminate()
                raise ContentCoordinatorError("unknown", "committed checkpoint could not be reopened")

    def _restart_current(self) -> None:
        state = self.store.state()
        reply = self.adapter.restart(self.store.checkpoint_path(), accepted_revision=state.revision)
        if reply.get("status") != "accepted" or reply.get("acceptedRevision") != state.revision:
            self.adapter.terminate()
            raise ContentCoordinatorError("unknown", "committed checkpoint could not be reopened")

    def _restart_after_commit(self) -> None:
        try:
            self._restart_current()
        except Exception:
            # Commit already happened. A later call retries from committed bytes.
            self.adapter.terminate()

    def _restore_after_failure(self) -> None:
        try:
            self._restart_current()
        except Exception:
            self.adapter.terminate()

    @staticmethod
    def _checked_read_reply(reply: dict[str, Any], revision: int) -> dict[str, Any]:
        status = reply.get("status")
        if reply.get("acceptedRevision") != revision:
            raise ContentCoordinatorError("unknown", "Content worker revision could not be established")
        if status != "accepted":
            reason = str(reply.get("guardReason") or "REJECTED_UNSUPPORTED_STRUCTURE")
            safe_status = "stale" if status == "stale" else "rejected"
            raise ContentCoordinatorError(safe_status, reason)
        return reply


def _file_hash(path: Path) -> str:
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _object_census(inspected: dict[str, Any]) -> tuple[int, ...]:
    result = inspected.get("result", {})
    discovery = result.get("discovery", {})
    pages = discovery.get("pages")
    text = discovery.get("textObjects")
    opaque = discovery.get("viewOnlyObjects")
    if not isinstance(pages, list) or not isinstance(text, list) or not isinstance(opaque, list):
        raise ContentCoordinatorError("rejected", "REJECTED_UNSUPPORTED_STRUCTURE")
    counts = [0] * len(pages)
    for item in (*text, *opaque):
        index = item.get("pageIndex") if isinstance(item, dict) else None
        if not isinstance(index, int) or not 0 <= index < len(counts):
            raise ContentCoordinatorError("rejected", "REJECTED_UNSUPPORTED_STRUCTURE")
        counts[index] += 1
    return tuple(counts)
