"""The eager single-walk listing: what it shows, what it hides, what it counts."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from core import folder_scan
from core.folder_scan import MAX_DEPTH, MAX_ENTRIES, scan_folder

WINDOWS = sys.platform == "win32"


def pdf(path: Path, body: bytes = b"%PDF-1.7\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


def names(node) -> list[str]:
    return [child.name for child in node.folders]


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    """Reports/{Q1,Q2}, plus a non-PDF and a PDF-less folder."""
    root = tmp_path / "Reports"
    pdf(root / "summary.pdf")
    pdf(root / "Q1" / "report-jan.pdf")
    pdf(root / "Q1" / "report-feb.pdf")
    pdf(root / "Q1" / "report-mar.pdf")
    pdf(root / "Q2" / "summary.pdf")
    (root / "Q1" / "notes.txt").write_text("not a pdf", encoding="utf-8")
    (root / "Empty" / "deeper").mkdir(parents=True)
    (root / "Empty" / "deeper" / "readme.md").write_text("x", encoding="utf-8")
    return root


def test_lists_folders_with_subtree_counts(tree: Path):
    result = scan_folder(tree)
    assert result.pdf_count == 5
    assert names(result.root) == ["Q1", "Q2"]

    q1 = next(child for child in result.root.folders if child.name == "Q1")
    # The count covers the subtree, not just the folder itself.
    assert q1.pdf_count == 3
    assert q1.files == ["report-feb.pdf", "report-jan.pdf", "report-mar.pdf"]


def test_counts_include_subfolders_at_every_depth(tree: Path):
    pdf(tree / "Q1" / "nested" / "deep.pdf")
    result = scan_folder(tree)
    q1 = next(child for child in result.root.folders if child.name == "Q1")
    assert q1.pdf_count == 4
    assert result.pdf_count == 6
    assert names(q1) == ["nested"]


def test_only_pdfs_are_listed(tree: Path):
    result = scan_folder(tree)
    assert "notes.txt" not in result.root.files
    q1 = next(child for child in result.root.folders if child.name == "Q1")
    assert q1.files == ["report-feb.pdf", "report-jan.pdf", "report-mar.pdf"]


def test_folders_without_any_pdf_are_hidden(tree: Path):
    result = scan_folder(tree)
    assert "Empty" not in names(result.root)


def test_folders_come_before_files_and_both_are_natural(tree: Path):
    pdf(tree / "report10.pdf")
    pdf(tree / "report2.pdf")
    result = scan_folder(tree)
    # Folders first, then files, each in natural order.
    assert names(result.root) == ["Q1", "Q2"]
    assert result.root.files == ["report2.pdf", "report10.pdf", "summary.pdf"]


def test_listing_never_opens_a_document(tmp_path: Path):
    root = tmp_path / "Broken"
    pdf(root / "damaged.pdf", body=b"this is not a PDF at all")
    pdf(root / "fine.pdf")
    result = scan_folder(root)
    # A damaged file is still listed, which proves listing did not open it.
    assert result.pdf_count == 2
    assert result.skipped == 0


def test_an_empty_root_is_still_returned(tmp_path: Path):
    root = tmp_path / "Nothing"
    root.mkdir()
    result = scan_folder(root)
    assert result.root.name == "Nothing"
    assert result.pdf_count == 0
    assert result.skipped == 0
    assert result.bounded is False


def test_case_insensitive_pdf_extension_is_listed(tmp_path: Path):
    root = tmp_path / "Mixed"
    pdf(root / "UPPER.PDF")
    result = scan_folder(root)
    assert result.root.files == ["UPPER.PDF"]


def test_a_reparse_point_is_not_followed(tmp_path: Path):
    """A junction pointing at an ancestor must not send the walk in a circle."""
    root = tmp_path / "Loop"
    pdf(root / "inside.pdf")
    if not WINDOWS:
        try:
            os.symlink(root, root / "back")
        except (OSError, NotImplementedError):
            pytest.skip("cannot create a link in this environment")
    else:
        created = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(root / "back"), str(root)],
            capture_output=True, text=True,
        )
        if created.returncode != 0:
            pytest.skip(f"could not create a junction: {created.stdout or created.stderr}")

    result = scan_folder(root)  # must terminate
    assert result.pdf_count == 1
    assert names(result.root) == []


def test_unreadable_folders_are_skipped_and_counted(tmp_path: Path, monkeypatch):
    root = tmp_path / "Guarded"
    pdf(root / "ok.pdf")
    pdf(root / "locked" / "hidden.pdf")

    real_scandir = os.scandir

    def guarded(path):
        if str(path).endswith("locked"):
            raise PermissionError("denied")
        return real_scandir(path)

    monkeypatch.setattr(folder_scan.os, "scandir", guarded)
    result = scan_folder(root)

    assert result.pdf_count == 1
    assert result.skipped == 1
    assert names(result.root) == []


def test_depth_cap_bounds_the_walk_and_is_reported(tmp_path: Path, monkeypatch):
    root = tmp_path / "Deep"
    deep = root
    for level in range(MAX_DEPTH + 6):
        deep = deep / f"level{level}"
    pdf(deep / "bottom.pdf")
    pdf(root / "top.pdf")

    monkeypatch.setattr(folder_scan, "MAX_DEPTH", 4)
    result = scan_folder(root)

    assert result.depth_capped is True
    assert result.bounded is True
    # What was reachable is still listed rather than the whole walk failing.
    assert result.pdf_count >= 1
    assert result.root.files == ["top.pdf"]


def test_entry_cap_bounds_the_walk_and_is_reported(tmp_path: Path, monkeypatch):
    root = tmp_path / "Many"
    for index in range(12):
        pdf(root / f"file{index}.pdf")

    monkeypatch.setattr(folder_scan, "MAX_ENTRIES", 5)
    result = scan_folder(root)

    assert result.entry_capped is True
    assert result.bounded is True
    assert len(result.root.files) <= 5


def test_caps_are_not_reported_on_an_ordinary_tree(tree: Path):
    result = scan_folder(tree)
    assert result.depth_capped is False
    assert result.entry_capped is False
    assert MAX_ENTRIES > 5 and MAX_DEPTH > 4
