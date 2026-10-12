"""Eager, single-walk listing of a folder's PDFs for the Merge workspace.

The whole subtree is read in one pass rather than per folder expansion, and only
names are read: browsing never opens a document, so a damaged or encrypted PDF
cannot break the tree. Symbolic links, Windows junctions, and other reparse
points are not followed, and a depth cap plus a visited-entry cap bound the walk
so a pathological tree cannot hang the request. Anything that cannot be read is
skipped and counted rather than silently dropped.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from core.path_safety import is_reparse_point
from utils.natural_sort import natural_key

PDF_SUFFIX = ".pdf"

# Generous backstops, not functional limits: deep enough for any real document
# tree, shallow enough that a loop cannot run away if one is ever reached.
MAX_DEPTH = 32
MAX_ENTRIES = 20000


@dataclass
class FolderNode:
    name: str
    relative_path: str
    pdf_count: int
    folders: list["FolderNode"] = field(default_factory=list)
    files: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "relative_path": self.relative_path,
            "pdf_count": self.pdf_count,
            "folders": [child.to_dict() for child in self.folders],
            "files": list(self.files),
        }


@dataclass
class ScanResult:
    root: FolderNode
    pdf_count: int
    skipped: int
    depth_capped: bool
    entry_capped: bool

    @property
    def bounded(self) -> bool:
        return self.depth_capped or self.entry_capped

    def to_dict(self) -> dict:
        return {
            "root": self.root.to_dict(),
            "pdf_count": self.pdf_count,
            "skipped": self.skipped,
            "depth_capped": self.depth_capped,
            "entry_capped": self.entry_capped,
        }


@dataclass
class _WalkState:
    visited: int = 0
    skipped: int = 0
    depth_capped: bool = False
    entry_capped: bool = False


def _scan_directory(
    path: Path,
    name: str,
    relative: str,
    depth: int,
    state: _WalkState,
) -> FolderNode | None:
    """Return the node for ``path``, or ``None`` when it holds no PDF at all."""
    if depth > MAX_DEPTH:
        state.depth_capped = True
        return None

    try:
        with os.scandir(path) as iterator:
            entries = list(iterator)
    except OSError:
        state.skipped += 1
        return None

    folders: list[FolderNode] = []
    files: list[str] = []

    for entry in entries:
        if state.visited >= MAX_ENTRIES:
            state.entry_capped = True
            break
        state.visited += 1

        try:
            # Never descend through a link, junction, or other reparse point.
            if is_reparse_point(entry.path):
                continue
            if entry.is_dir(follow_symlinks=False):
                child_relative = f"{relative}/{entry.name}" if relative else entry.name
                child = _scan_directory(Path(entry.path), entry.name, child_relative, depth + 1, state)
                if child is not None:
                    folders.append(child)
            elif entry.is_file(follow_symlinks=False) and entry.name.casefold().endswith(PDF_SUFFIX):
                files.append(entry.name)
        except OSError:
            state.skipped += 1

    folders.sort(key=lambda child: natural_key(child.name))
    files.sort(key=natural_key)

    # A folder with no PDF anywhere below it is not worth showing.
    if not folders and not files:
        return None

    pdf_count = len(files) + sum(child.pdf_count for child in folders)
    return FolderNode(
        name=name,
        relative_path=relative,
        pdf_count=pdf_count,
        folders=folders,
        files=files,
    )


def scan_folder(root: str | Path) -> ScanResult:
    """List ``root`` and every folder below it that contains a PDF."""
    root_path = Path(root)
    state = _WalkState()
    node = _scan_directory(root_path, root_path.name, "", 0, state)

    if node is None:
        # The root is always shown, even when it holds no PDF, so the interface
        # can say so instead of appearing to have failed.
        node = FolderNode(name=root_path.name, relative_path="", pdf_count=0)

    return ScanResult(
        root=node,
        pdf_count=node.pdf_count,
        skipped=state.skipped,
        depth_capped=state.depth_capped,
        entry_capped=state.entry_capped,
    )
