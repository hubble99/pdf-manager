"""Path containment for the Merge folder workspace.

Folder mode is the only place the backend reads a path the caller supplied, so
this module is the trust boundary. Two rules keep it sound:

* A requested path is always interpreted as *inside the registered root*. Input
  that is absolute, drive-relative, or UNC-shaped is refused **before** it is
  combined with the root, because joining an absolute path would otherwise
  replace the root entirely.
* Containment is decided on fully resolved paths compared on boundary
  separators, never on a string prefix. That defeats parent references,
  symbolic links, Windows junctions, sibling directories whose names merely
  begin like the root, and differing spellings of the same file such as letter
  case or an 8.3 short name.
"""
from __future__ import annotations

import ntpath
import os
import stat
from pathlib import Path

PDF_SUFFIX = ".pdf"
_REPARSE_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)


class PathSafetyError(Exception):
    """Raised when a path is not a readable PDF inside the registered root."""


def looks_like_foreign_path(value: str) -> bool:
    """True when the caller sent something other than a path inside the root.

    Rejects absolute paths, UNC and device forms, and drive-relative paths such
    as ``C:notes.pdf``.
    """
    if not value or not value.strip():
        return True
    if ntpath.isabs(value):
        return True
    drive, _ = ntpath.splitdrive(value)
    return bool(drive)


def is_reparse_point(path: str | Path) -> bool:
    """True for a symbolic link, a Windows junction, or another reparse point.

    Python 3.11 has no ``os.path.isjunction``, so the Windows reparse attribute
    is read directly; that covers junctions as well as symlinks, which is what
    listing needs in order not to walk into a loop.
    """
    try:
        info = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    return bool(getattr(info, "st_file_attributes", 0) & _REPARSE_ATTRIBUTE)


def is_within(root: str, path: str) -> bool:
    """Boundary-aware containment test for two already-resolved paths."""
    root_key = os.path.normcase(root.rstrip("\\/") or root)
    path_key = os.path.normcase(path)
    if path_key == root_key:
        return True
    return path_key.startswith(root_key + os.sep)


def resolve_within_root(root: str | Path, relative: str) -> Path:
    """Resolve ``relative`` inside ``root`` or raise :class:`PathSafetyError`.

    Only PDF files are accepted, and the result is fully resolved so that a link
    leaving the root is refused rather than followed.
    """
    if looks_like_foreign_path(relative):
        raise PathSafetyError("Use a file inside the chosen folder.")
    if not relative.casefold().endswith(PDF_SUFFIX):
        raise PathSafetyError("Only PDF files can be merged.")

    resolved_root = os.path.realpath(str(root))
    resolved = os.path.realpath(os.path.join(resolved_root, relative))
    if not is_within(resolved_root, resolved):
        raise PathSafetyError("That file is outside the chosen folder.")
    return Path(resolved)
