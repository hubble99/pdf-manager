"""Containment is the trust boundary for folder mode, so it is tested hard.

Covered: a legitimate nested file, parent references, symbolic links, Windows
junctions, UNC-shaped and drive-relative input, absolute input, a sibling whose
name merely begins like the root, case differences, and 8.3 short names, plus the
non-PDF rule.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from core.path_safety import (
    PathSafetyError,
    is_reparse_point,
    is_within,
    looks_like_foreign_path,
    resolve_within_root,
)

WINDOWS = sys.platform == "win32"


@pytest.fixture
def root(tmp_path: Path) -> Path:
    base = tmp_path / "Root Folder"
    (base / "sub").mkdir(parents=True)
    (base / "sub" / "doc.pdf").write_bytes(b"%PDF-1.7\n")
    (base / "top.pdf").write_bytes(b"%PDF-1.7\n")
    return base


# ── basic acceptance ─────────────────────────────────────────────────────────

def test_a_nested_file_is_accepted(root: Path):
    resolved = resolve_within_root(root, "sub/doc.pdf")
    assert resolved.name == "doc.pdf"
    assert resolved.exists()


def test_the_root_itself_counts_as_within(root: Path):
    assert is_within(str(root), str(root)) is True


def test_a_top_level_file_is_accepted(root: Path):
    assert resolve_within_root(root, "top.pdf").name == "top.pdf"


def test_a_non_pdf_is_refused(root: Path):
    (root / "notes.txt").write_text("hello", encoding="utf-8")
    with pytest.raises(PathSafetyError, match="Only PDF"):
        resolve_within_root(root, "notes.txt")


# ── escapes ──────────────────────────────────────────────────────────────────

def test_parent_reference_escape_is_refused(root: Path):
    outside = root.parent / "outside.pdf"
    outside.write_bytes(b"%PDF-1.7\n")
    for attempt in ("../outside.pdf", "sub/../../outside.pdf", "./../outside.pdf"):
        with pytest.raises(PathSafetyError):
            resolve_within_root(root, attempt)


def test_sibling_whose_name_begins_like_the_root_is_refused(tmp_path: Path):
    """The classic prefix bug: containment is boundaries, not a string prefix."""
    base = tmp_path / "Root"
    evil = tmp_path / "Root-evil"
    base.mkdir()
    evil.mkdir()
    (evil / "secret.pdf").write_bytes(b"%PDF-1.7\n")

    assert is_within(str(base), str(evil / "secret.pdf")) is False
    with pytest.raises(PathSafetyError):
        resolve_within_root(base, "../Root-evil/secret.pdf")


def test_a_symlink_escaping_the_root_is_refused(root: Path, tmp_path: Path):
    outside = tmp_path / "outside.pdf"
    outside.write_bytes(b"%PDF-1.7\n")
    link = root / "escape.pdf"
    try:
        os.symlink(outside, link)
    except (OSError, NotImplementedError):
        pytest.skip("creating a symbolic link is not permitted in this environment")

    with pytest.raises(PathSafetyError):
        resolve_within_root(root, "escape.pdf")


@pytest.mark.skipif(not WINDOWS, reason="junctions are a Windows construct")
def test_a_junction_escaping_the_root_is_refused(root: Path, tmp_path: Path):
    outside_dir = tmp_path / "elsewhere"
    outside_dir.mkdir()
    (outside_dir / "secret.pdf").write_bytes(b"%PDF-1.7\n")

    link = root / "junction"
    created = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(outside_dir)],
        capture_output=True, text=True,
    )
    if created.returncode != 0 or not link.exists():
        pytest.skip(f"could not create a junction: {created.stdout or created.stderr}")

    # A junction is a reparse point, so listing must not treat it as a folder.
    assert is_reparse_point(link) is True
    with pytest.raises(PathSafetyError):
        resolve_within_root(root, "junction/secret.pdf")


# ── input shapes that must never reach the join ──────────────────────────────

@pytest.mark.parametrize("value", [
    "/etc/passwd.pdf",
    "C:/Windows/System32/drivers/etc/hosts.pdf",
    "C:\\Windows\\win.ini.pdf",
    "\\\\server\\share\\secret.pdf",
    "\\\\?\\C:\\Windows\\secret.pdf",
    "C:notes.pdf",
    "",
    "   ",
])
def test_foreign_path_shapes_are_recognised(value: str):
    assert looks_like_foreign_path(value) is True


@pytest.mark.parametrize("value", ["note.pdf", "sub/note.pdf", "sub\\note.pdf", "./note.pdf"])
def test_inside_shapes_are_not_treated_as_foreign(value: str):
    assert looks_like_foreign_path(value) is False


@pytest.mark.parametrize("value", [
    "C:\\Windows\\win.ini.pdf",
    "\\\\server\\share\\secret.pdf",
    "C:notes.pdf",
])
def test_foreign_shapes_are_refused_before_joining(root: Path, value: str):
    """An absolute path would replace the root if it were simply joined."""
    with pytest.raises(PathSafetyError, match="inside the chosen folder"):
        resolve_within_root(root, value)


# ── alternative spellings of the same file ───────────────────────────────────

@pytest.mark.skipif(not WINDOWS, reason="case-insensitive paths are a Windows behaviour")
def test_case_differences_reach_the_same_file(root: Path):
    lower = resolve_within_root(root, "sub/doc.pdf")
    upper = resolve_within_root(root, "SUB/DOC.PDF")
    assert os.path.normcase(str(lower)) == os.path.normcase(str(upper))


def test_short_name_spelling_resolves_to_the_same_file(root: Path, tmp_path: Path):
    """An 8.3 short name must not be treated as a different location."""
    short = _short_path(root)
    if short is None:
        pytest.skip("8.3 short names are not available on this volume")

    via_long = resolve_within_root(root, "sub/doc.pdf")
    via_short_root = resolve_within_root(short, "sub/doc.pdf")
    assert os.path.normcase(str(via_short_root)) == os.path.normcase(str(via_long))


def _short_path(path: Path) -> str | None:
    """Return the 8.3 form of ``path``, or None when it is unavailable.

    Asked of the Win32 API rather than through a shell, so no quoting is
    involved. A volume with 8.3 name generation disabled simply echoes the long
    name back, which the caller treats as "not available".
    """
    if not WINDOWS:
        return None
    import ctypes

    buffer = ctypes.create_unicode_buffer(1024)
    length = ctypes.windll.kernel32.GetShortPathNameW(str(path), buffer, 1024)
    value = buffer.value if length else ""
    if not value or os.path.normcase(value) == os.path.normcase(str(path)):
        return None
    return value
