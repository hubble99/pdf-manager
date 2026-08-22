"""Pure filename sanitizing helpers with no web-framework dependency."""

import re

_INVALID_FILENAME_CHARS = r'[<>:"/\\|?*\x00-\x1f]'
_WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


def sanitize_filename(name: str, extension: str = "pdf") -> str:
    """Return a filesystem-safe filename while preserving valid spaces."""
    ext_lower = extension.lower().lstrip(".")
    name = str(name or "")

    if name.lower().endswith(f".{ext_lower}"):
        name = name[: -(len(ext_lower) + 1)]

    name = re.sub(r"\s+", " ", name).strip(". ")
    name = re.sub(_INVALID_FILENAME_CHARS, "_", name)
    name = re.sub(r"_+", "_", name)
    name = name.strip("-") or "output"

    if name.split(".", 1)[0].upper() in _WINDOWS_RESERVED_NAMES:
        name = f"_{name}"

    return f"{name}.{ext_lower}"


def sanitize_stem(name: str) -> str:
    """Return a filesystem-safe filename stem while preserving valid spaces."""
    name = str(name or "")
    name = re.sub(r"\.[a-zA-Z0-9]{2,5}$", "", name)
    name = re.sub(r"\s+", " ", name).strip(". ")
    name = re.sub(_INVALID_FILENAME_CHARS, "_", name)
    name = re.sub(r"_+", "_", name)
    name = name.strip("-") or "output"
    return f"_{name}" if name.split(".", 1)[0].upper() in _WINDOWS_RESERVED_NAMES else name
