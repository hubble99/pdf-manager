"""Windows private storage for Content's single authoritative commit record.

This internal component has no routes and never regenerates a PDF. Callers
must supply the worker's verified checkpoint metadata and closed candidate.
Candidate handoff is accepted only through the feature-owned coordinator.
"""

from __future__ import annotations

from dataclasses import asdict
import ctypes
import hashlib
import json
import os
from pathlib import Path
import threading
from typing import Callable
import uuid

from features.edit_content.transaction_state import (
    Checkpoint, EditMetadata, MAX_CHECKPOINT_BYTES, Outcome, PreparedTransition,
    Publication, SessionState, TransitionRejected, prepare_transition,
)


# Absolute parsing and transaction ceilings come from the frozen session
# working-set budget. The reservation is held and consumed as prepared files
# replace its bytes, so all transaction-critical allocation precedes commit.
MAX_RECORD_BYTES = 64 * 1024 * 1024
MAX_PREPARATION_BYTES = 64 * 1024 * 1024
STORE_SCHEMA = "edit-content-commit-record/v1"


class UnknownOutcome(RuntimeError):
    """Committed state cannot be proven. No mutation/replay is allowed."""


def _encoded(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def _file_hash(path: Path) -> str:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_CHECKPOINT_BYTES:
        raise TransitionRejected("artifact is unavailable")
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _move(source: Path, destination: Path, *, replace: bool) -> None:
    """Same-volume atomic Windows rename, with write-through and no copy fallback."""
    if os.name != "nt":
        raise OSError("Content commit storage requires the verified Windows primitive")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    move = kernel.MoveFileExW
    move.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
    move.restype = ctypes.c_int
    flags = 0x8 | (0x1 if replace else 0)  # WRITE_THROUGH; optionally REPLACE_EXISTING.
    if not move(str(source), str(destination), flags):
        raise ctypes.WinError(ctypes.get_last_error())


def _checkpoint(value: dict) -> Checkpoint:
    value = dict(value)
    if value.get("edit") is not None:
        edit = dict(value["edit"])
        edit["source_scope"] = tuple(edit["source_scope"])
        edit["checks"] = tuple(edit["checks"])
        value["edit"] = EditMetadata(**edit)
    value["object_census"] = tuple(value["object_census"])
    return Checkpoint(**value)


def _state(value: dict) -> SessionState:
    value = dict(value)
    value["source"] = _checkpoint(value["source"])
    value["checkpoints"] = tuple(_checkpoint(item) for item in value["checkpoints"])
    value["publications"] = tuple(Publication(**item) for item in value["publications"])
    value["outcomes"] = tuple(Outcome(**item) for item in value["outcomes"])
    result = SessionState(**value)
    result.validate()
    return result


class ContentCommitStore:
    """One process owns the store; all operations serialize under one lock.

    Published outputs remain referenced in the record and are never removed by
    history pruning or close. Unreferenced candidates are never promoted.
    """

    def __init__(self, root: Path, session_id: str, source_hash: str):
        self.root = Path(root).absolute()
        self.session_id = session_id
        self.source_hash = source_hash
        self._mutex = threading.RLock()
        self._blocked = False
        self._lock_file = None
        if os.name != "nt":
            raise OSError("Content commit storage has only been verified on Windows")
        if self.root.is_symlink() or not self.root.is_dir():
            raise UnknownOutcome("owned Content store is unavailable")
        if any(parent.is_symlink() for parent in self.root.parents):
            raise UnknownOutcome("Content store ownership is uncertain")
        self._acquire()

    def _acquire(self):
        import msvcrt
        try:
            lock = self.root / ".lock"
            if lock.is_symlink():
                raise OSError("invalid lock")
            self._lock_file = lock.open("a+b")
            if lock.stat().st_size == 0:
                self._lock_file.write(b"0")
                self._lock_file.flush()
            self._lock_file.seek(0)
            msvcrt.locking(self._lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            self.close()
            raise UnknownOutcome("Content store is already owned or unavailable") from exc

    @classmethod
    def create(cls, root: Path, state: SessionState, source: Path) -> ContentCommitStore:
        state.validate()
        if state.revision != 0 or state.current != state.source or state.publications or state.outcomes:
            raise TransitionRejected("initialization requires the source baseline")
        root = Path(root).absolute()
        root.mkdir(parents=False, exist_ok=False)
        store = cls(root, state.session_id, state.source.source_hash)
        try:
            for name in ("staging", "checkpoints", "outputs"):
                (root / name).mkdir()
            store._install(source, store._artifact("checkpoints", state.source.checkpoint_id),
                           state.source.accepted_artifact_hash, state.source.byte_size)
            path = store._prepare_record(state)
            _move(path, root / "record.json", replace=False)
            store._read_checked()
            return store
        except BaseException:
            # Retain uncertain initialization for diagnosis; never guess/promote.
            store.close()
            raise

    def _artifact(self, area: str, identity: str) -> Path:
        from features.edit_content.transaction_state import _id
        _id(identity)
        if area not in {"checkpoints", "outputs"}:
            raise TransitionRejected("invalid artifact area")
        directory = self.root / area
        path = directory / f"{identity}.pdf"
        if directory.is_symlink() or not directory.is_dir() or path.is_symlink():
            raise UnknownOutcome("artifact ownership is uncertain")
        return path

    def _staging(self) -> Path:
        directory = self.root / "staging"
        if directory.is_symlink() or not directory.is_dir():
            raise UnknownOutcome("staging ownership is uncertain")
        return directory / uuid.uuid4().hex

    def _boundary(self, name: str) -> None:
        """No production fault/bypass switch; tests may override this method."""

    def _install(self, source: Path, destination: Path, expected_hash: str, size: int) -> None:
        if size > MAX_CHECKPOINT_BYTES or _file_hash(source) != expected_hash or source.stat().st_size != size:
            raise TransitionRejected("prepared bytes changed")
        temporary = self._staging()
        try:
            with source.open("rb") as reader, temporary.open("xb") as writer:
                remaining = size
                while remaining:
                    chunk = reader.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise TransitionRejected("prepared bytes changed")
                    writer.write(chunk)
                    remaining -= len(chunk)
                if reader.read(1):
                    raise TransitionRejected("prepared bytes changed")
                writer.flush()
                self._boundary("before-file-flush")
                os.fsync(writer.fileno())
            if _file_hash(temporary) != expected_hash:
                raise TransitionRejected("prepared bytes changed")
            self._boundary("before-artifact-install")
            _move(temporary, destination, replace=False)
            destination.chmod(0o444)
        finally:
            if temporary.exists():
                temporary.unlink()

    def _prepare_record(self, state: SessionState) -> Path:
        payload = asdict(state)
        record = _encoded({"schema": STORE_SCHEMA, "state": payload,
                           "sha256": hashlib.sha256(_encoded(payload)).hexdigest()})
        if len(record) > MAX_RECORD_BYTES:
            raise TransitionRejected("commit record exceeds the bounded preparation budget")
        temporary = self._staging()
        try:
            with temporary.open("xb") as writer:
                writer.write(record)
                writer.flush()
                self._boundary("before-record-flush")
                os.fsync(writer.fileno())
            return temporary
        except BaseException:
            if temporary.exists():
                temporary.unlink()
            raise

    def _reserve(self, byte_count: int) -> Path:
        if not 0 < byte_count <= MAX_PREPARATION_BYTES:
            raise TransitionRejected("transaction exceeds the preparation budget")
        reservation = self._staging()
        try:
            block = bytes(1024 * 1024)
            with reservation.open("xb") as writer:
                remaining = byte_count
                while remaining:
                    chunk = block[: min(len(block), remaining)]
                    writer.write(chunk)
                    remaining -= len(chunk)
                writer.flush()
                self._boundary("before-reservation-flush")
                os.fsync(writer.fileno())
            return reservation
        except BaseException:
            if reservation.exists():
                reservation.unlink()
            raise TransitionRejected("insufficient preparation space") from None

    def _consume_reservation(self, reservation: Path, byte_count: int) -> None:
        """Release only the bytes that the next prepared artifact will use."""
        try:
            current = reservation.stat().st_size
            if byte_count < 0 or byte_count > current:
                raise OSError("invalid reservation consumption")
            with reservation.open("r+b") as held:
                held.truncate(current - byte_count)
                held.flush()
                os.fsync(held.fileno())
        except OSError:
            raise TransitionRejected("preparation space reservation was lost") from None

    def _read_checked(self) -> SessionState:
        try:
            record = self.root / "record.json"
            if record.is_symlink() or not record.is_file() or record.stat().st_size > MAX_RECORD_BYTES:
                raise ValueError
            payload = json.loads(record.read_bytes())
            if set(payload) != {"schema", "state", "sha256"} or payload["schema"] != STORE_SCHEMA:
                raise ValueError
            if hashlib.sha256(_encoded(payload["state"])).hexdigest() != payload["sha256"]:
                raise ValueError
            state = _state(payload["state"])
            if state.session_id != self.session_id or state.source.source_hash != self.source_hash:
                raise ValueError
            self._check_files(state)
            return state
        except Exception as exc:
            self._blocked = True
            raise UnknownOutcome("committed Content state cannot be verified") from exc

    def _check_files(self, state: SessionState) -> None:
        for checkpoint in (state.source, *state.checkpoints):
            path = self._artifact("checkpoints", checkpoint.checkpoint_id)
            if _file_hash(path) != checkpoint.accepted_artifact_hash or path.stat().st_size != checkpoint.byte_size:
                raise TransitionRejected("checkpoint bytes changed")
        for output in state.publications:
            path = self._artifact("outputs", output.output_id)
            if _file_hash(path) != output.artifact_hash or path.stat().st_size != output.byte_size:
                raise TransitionRejected("published bytes changed")

    def state(self) -> SessionState:
        with self._mutex:
            if self._lock_file is None or self._blocked:
                raise UnknownOutcome("Content store requires reconciliation")
            return self._read_checked()

    def reconcile(self) -> SessionState:
        with self._mutex:
            if self._lock_file is None:
                raise UnknownOutcome("Content store is closed")
            state = self._read_checked()
            self._blocked = False
            return state

    def checkpoint_path(self) -> Path:
        with self._mutex:
            state = self.state()
            return self._artifact("checkpoints", state.current.checkpoint_id)

    def output_bytes(self, output_id: str) -> bytes:
        with self._mutex:
            state = self.state()
            output = next((item for item in state.publications if item.output_id == output_id), None)
            if output is None:
                raise TransitionRejected("output is not published")
            content = self._artifact("outputs", output_id).read_bytes()
            if len(content) != output.byte_size or hashlib.sha256(content).hexdigest() != output.artifact_hash:
                self._blocked = True
                raise UnknownOutcome("published bytes changed")
            return content

    def transact(
        self, *, request_id: str, expected_revision: int, operation: str, pending_draft: bool = False,
        prepare: Callable[[SessionState, Path], tuple[Checkpoint, Path]] | None = None,
        cancelled: Callable[[], bool] = lambda: False,
    ) -> Outcome:
        """Serialize worker preparation through record publication, without retry.

        `prepare` is an internal verified-worker handoff, never request-supplied
        metadata. Exceptions before the switch retain the complete previous state.
        """
        with self._mutex:
            old = self.state()
            known = old.known_outcome(request_id)
            if known is not None:
                return known
            if expected_revision != old.revision:
                raise TransitionRejected("stale accepted revision")
            if cancelled():
                raise TransitionRejected("cancelled before commit")
            record = None
            reservation = None
            installed: list[Path] = []
            switched = False
            try:
                checkpoint, candidate = None, self._artifact("checkpoints", old.current.checkpoint_id)
                if operation in {"apply", "save-with-draft"}:
                    if prepare is None:
                        raise TransitionRejected("verified worker preparation is required")
                    self._boundary("before-worker")
                    checkpoint, candidate = prepare(old, candidate)
                    self._boundary("after-worker")
                elif prepare is not None:
                    raise TransitionRejected("unchanged save/history must not invoke the worker")
                publication = None
                if operation in {"save", "save-with-draft"}:
                    content = checkpoint or old.current
                    publication = Publication(uuid.uuid4().hex, content.accepted_artifact_hash, content.byte_size)
                transition = prepare_transition(old, request_id=request_id, expected_revision=expected_revision,
                                                operation=operation, pending_draft=pending_draft,
                                                checkpoint=checkpoint, publication=publication)
                record_size = len(_encoded({"schema": STORE_SCHEMA, "state": asdict(transition.next_state),
                    "sha256": "0" * 64}))
                install_bytes = (checkpoint.byte_size if checkpoint is not None else 0) + (
                    publication.byte_size if publication is not None else 0)
                reservation = self._reserve(max(1, record_size + install_bytes))
                if checkpoint is not None:
                    self._consume_reservation(reservation, checkpoint.byte_size)
                    destination = self._artifact("checkpoints", checkpoint.checkpoint_id)
                    self._install(candidate, destination, checkpoint.accepted_artifact_hash, checkpoint.byte_size)
                    installed.append(destination)
                    candidate = destination
                if publication is not None:
                    self._consume_reservation(reservation, publication.byte_size)
                    destination = self._artifact("outputs", publication.output_id)
                    self._install(candidate, destination, publication.artifact_hash, publication.byte_size)
                    installed.append(destination)
                self._boundary("after-files-prepared")
                self._consume_reservation(reservation, record_size)
                record = self._prepare_record(transition.next_state)
                # Last checks belong before the one commit point.
                if self._read_checked() != old or cancelled():
                    raise TransitionRejected("cancelled or stale before commit")
                self._check_files(transition.next_state)
                self._boundary("before-record-switch")
                if cancelled():
                    raise TransitionRejected("cancelled before commit")
                _move(record, self.root / "record.json", replace=True)
                switched = True
                self._boundary("after-record-switch")
                # No transaction-critical work remains after this point.
                self._prune(transition)
                self._boundary("before-reply")
                return transition.outcome
            except Exception:
                # The move could succeed before an error/reply loss was observed.
                current = self._read_checked()
                committed = current.known_outcome(request_id)
                if committed is not None:
                    return committed
                if switched or current != old:
                    self._blocked = True
                    raise UnknownOutcome("commit outcome requires reconciliation") from None
                for path in installed:
                    self._remove_owned_unreferenced(path)
                raise
            finally:
                if reservation is not None and reservation.exists():
                    try:
                        reservation.unlink()
                    except OSError:
                        pass
                if record is not None and record.exists() and not self._blocked:
                    try:
                        record.unlink()
                    except OSError:
                        pass  # Cleanup failure cannot overturn committed state.

    def _remove_owned_unreferenced(self, path: Path) -> None:
        # Called only for this transaction's newly installed files. No scan,
        # history guessing, or directory-recursive removal is permitted.
        try:
            if path.parent not in {self.root / "checkpoints", self.root / "outputs"} or path.is_symlink():
                return
            path.chmod(0o600)
            path.unlink()
        except OSError:
            pass  # Private orphan; never promoted or allowed to undo a commit.

    def _prune(self, transition: PreparedTransition) -> None:
        for identity in transition.evicted_checkpoint_ids:
            self._remove_owned_unreferenced(self._artifact("checkpoints", identity))

    def close(self) -> None:
        if self._lock_file is not None:
            self._lock_file.close()
            self._lock_file = None
