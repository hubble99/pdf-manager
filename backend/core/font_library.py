"""App-level font library for Edit Canvas.

Stores user-uploaded .ttf/.otf fonts inside the app data directory (no OS
installation) and resolves them with the highest priority when rewriting
native text or stamping overlay text.
"""

import json
import logging
import re
import struct
from pathlib import Path

import fitz

from config import settings

logger = logging.getLogger(__name__)

_FONT_DIR_NAME = "fonts"
_INDEX_FILENAME = "fonts.json"
_MAX_FONT_SIZE_BYTES = 20 * 1024 * 1024

_MAGIC_SIGNATURES = (
    b"\x00\x01\x00\x00",  # TrueType
    b"true",              # Apple TrueType
    b"ttcf",              # TrueType collection
    b"OTTO",              # OpenType with CFF
)

_SAFE_STEM = re.compile(r"[^A-Za-z0-9_-]+")
_VALID_EXTENSIONS = {".ttf", ".otf"}
_STYLE_SUFFIX = re.compile(
    r"(?:[\s_-]+(?:regular|roman|normal|thin|extra\s*light|light|medium|"
    r"semi\s*bold|demi\s*bold|bold|extra\s*bold|black|italic|oblique))+$",
    re.IGNORECASE,
)
_OPTICAL_SIZE_SUFFIX = re.compile(r"[\s_-]+\d+(?:\.\d+)?pt$", re.IGNORECASE)
_BOLD_STYLE = re.compile(r"\b(?:semi\s*bold|demi\s*bold|bold|extra\s*bold|black)\b", re.IGNORECASE)
_ITALIC_STYLE = re.compile(r"\b(?:italic|oblique)\b", re.IGNORECASE)

_WEIGHT_NAME_VALUES = (
    ("extralight", 200),
    ("ultralight", 200),
    ("semibold", 600),
    ("demibold", 600),
    ("extrabold", 800),
    ("ultrabold", 800),
    ("thin", 100),
    ("light", 300),
    ("medium", 500),
    ("bold", 700),
    ("black", 900),
    ("heavy", 900),
)


def _font_dir() -> Path:
    directory = settings.APP_DATA_DIR / _FONT_DIR_NAME
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _index_path() -> Path:
    return _font_dir() / _INDEX_FILENAME


def _read_index() -> dict:
    path = _index_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        logger.warning("Font library index unreadable; starting a new index.")
        return {}


def _write_index(index: dict) -> None:
    _index_path().write_text(json.dumps(index, indent=2), encoding="utf-8")


def normalize_family(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def _sfnt_weight_class(data: bytes | None) -> int | None:
    """Read OS/2.usWeightClass from a TTF/OTF without another dependency."""
    if not data or len(data) < 12:
        return None
    font_offset = 0
    if data[:4] == b"ttcf":
        if len(data) < 16:
            return None
        collection_count = struct.unpack_from(">I", data, 8)[0]
        if collection_count < 1:
            return None
        font_offset = struct.unpack_from(">I", data, 12)[0]
    if font_offset + 12 > len(data):
        return None
    table_count = struct.unpack_from(">H", data, font_offset + 4)[0]
    records_offset = font_offset + 12
    for index in range(table_count):
        record_offset = records_offset + index * 16
        if record_offset + 16 > len(data):
            return None
        tag, _, table_offset, table_length = struct.unpack_from(">4sIII", data, record_offset)
        if tag != b"OS/2" or table_length < 6 or table_offset + 6 > len(data):
            continue
        weight = struct.unpack_from(">H", data, table_offset + 4)[0]
        return weight if 1 <= weight <= 1000 else None
    return None


def _named_weight_value(full_name: str) -> int | None:
    compact = re.sub(r"[^a-z]", "", (full_name or "").lower())
    for token, value in _WEIGHT_NAME_VALUES:
        if token in compact:
            return value
    return None


def _weight_from_name(full_name: str, flags: dict | None = None) -> int:
    named_weight = _named_weight_value(full_name)
    if named_weight is not None:
        return named_weight
    return 700 if bool((flags or {}).get("bold")) else 400


def font_identity(
    full_name: str,
    flags: dict | None = None,
    data: bytes | None = None,
) -> tuple[str, int, bool]:
    """Split a font face name into its selectable family and style.

    PyMuPDF exposes face names such as ``Roboto Regular`` and
    ``Inter 18pt Bold Italic``. The editor, however, selects the shared family
    (``Roboto`` / ``Inter``) and sends bold/italic separately. Keeping those
    pieces separate makes browser preview and PDF export resolve the same face.
    """
    name = re.sub(r"\s+", " ", (full_name or "").replace("_", " ")).strip()
    font_flags = flags or {}
    weight = _named_weight_value(name) or _sfnt_weight_class(data) or _weight_from_name(name, font_flags)
    italic = bool(font_flags.get("italic")) or bool(_ITALIC_STYLE.search(name))
    family = _STYLE_SUFFIX.sub("", name).strip(" -_")
    family = _OPTICAL_SIZE_SUFFIX.sub("", family).strip(" -_")
    return family or name or "Custom Font", weight, italic


def _entry_identity(entry: dict) -> tuple[str, int, bool]:
    if "weight" in entry and "italic" in entry:
        named_weight = _named_weight_value(str(entry.get("full_name", "")))
        return (
            str(entry.get("family", "")),
            named_weight or max(1, min(1000, int(entry.get("weight", 400)))),
            bool(entry.get("italic")),
        )
    if "bold" in entry and "italic" in entry:
        return (
            str(entry.get("family", "")),
            700 if bool(entry.get("bold")) else 400,
            bool(entry.get("italic")),
        )
    return font_identity(str(entry.get("family", "")))


def validate_font_bytes(data: bytes) -> str | None:
    """Return an error message for invalid font payloads, or None if valid."""
    if not data:
        return "Font file is empty."
    if len(data) > _MAX_FONT_SIZE_BYTES:
        return "Font file exceeds the 20 MB limit."
    if not any(data.startswith(magic) for magic in _MAGIC_SIGNATURES):
        return "File is not a valid TTF/OTF font."
    try:
        probe = fitz.Font(fontbuffer=data)
    except Exception as exc:  # PyMuPDF rejects malformed tables lazily
        return f"Font could not be parsed: {exc}"
    if not getattr(probe, "name", ""):
        return "Font has no readable family name."
    return None


def list_fonts() -> list[dict]:
    index = _read_index()
    entries = []
    for font_id in sorted(index):
        entry = index[font_id]
        family, weight, italic = _entry_identity(entry)
        entries.append({
            "id": font_id,
            "family": family,
            "filename": entry.get("filename", ""),
            "weight": weight,
            "bold": weight >= 700,
            "italic": italic,
        })
    return entries


def save_font(data: bytes, original_filename: str) -> dict:
    error = validate_font_bytes(data)
    if error:
        raise ValueError(error)

    stem = Path(original_filename or "font").stem
    safe_stem = _SAFE_STEM.sub("-", stem).strip("-") or "custom-font"
    extension = Path(original_filename or "").suffix.lower()
    if extension not in _VALID_EXTENSIONS:
        extension = ".otf" if data[:4] == b"OTTO" else ".ttf"

    font_id = safe_stem
    filename = f"{safe_stem}{extension}"
    counter = 2
    while (_font_dir() / filename).exists() or font_id in _read_index():
        font_id = f"{safe_stem}-{counter}"
        filename = f"{safe_stem}-{counter}{extension}"
        counter += 1

    target = _font_dir() / filename
    target.write_bytes(data)

    try:
        probe = fitz.Font(fontfile=str(target))
        full_name = probe.name or Path(stem).name
        family, weight, italic = font_identity(full_name, getattr(probe, "flags", None), data)
    except Exception:
        full_name = Path(stem).name
        family, weight, italic = font_identity(full_name, data=data)

    index = _read_index()
    index[font_id] = {
        "family": family,
        "full_name": full_name,
        "filename": filename,
        "weight": weight,
        "bold": weight >= 700,
        "italic": italic,
    }
    _write_index(index)
    return {
        "id": font_id,
        "family": family,
        "filename": filename,
        "weight": weight,
        "bold": weight >= 700,
        "italic": italic,
    }


def delete_font(font_id: str) -> bool:
    index = _read_index()
    entry = index.pop(font_id, None)
    if entry is None:
        return False
    path = _font_dir() / entry.get("filename", "")
    try:
        if path.exists() and path.parent == _font_dir():
            path.unlink()
    except OSError as exc:
        logger.warning("Could not remove font file %s: %s", path, exc)
    _write_index(index)
    return True


def resolve_font_file(
    family: str,
    bold: bool = False,
    italic: bool = False,
    weight: int | None = None,
) -> Path | None:
    """Return the nearest face in the requested family and style."""
    requested_family, _, _ = font_identity(family)
    base = normalize_family(requested_family)
    if not base:
        return None
    requested_weight = max(1, min(1000, int(weight if weight is not None else (700 if bold else 400))))

    index = _read_index()
    matches: list[tuple[dict, int, bool, Path]] = []
    for entry in index.values():
        entry_family, entry_weight, entry_italic = _entry_identity(entry)
        if normalize_family(entry_family) == base:
            path = _font_dir() / entry.get("filename", "")
            if path.exists():
                matches.append((entry, entry_weight, entry_italic, path))

    if not matches:
        return None

    def rank(match: tuple[dict, int, bool, Path]) -> tuple[int, int, int]:
        _, entry_weight, entry_italic, _ = match
        tie_break = -entry_weight if requested_weight >= 500 else entry_weight
        return (0 if entry_italic == bool(italic) else 1, abs(entry_weight - requested_weight), tie_break)

    return min(matches, key=rank)[3]


def load_font_buffer(font_id: str) -> bytes | None:
    """Return raw font bytes for frontend preview registration."""
    entry = _read_index().get(font_id)
    if not entry:
        return None
    path = _font_dir() / entry.get("filename", "")
    if not path.exists() or path.parent != _font_dir():
        return None
    return path.read_bytes()
