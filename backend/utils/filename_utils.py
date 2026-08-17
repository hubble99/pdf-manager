"""Pure filename sanitizing helpers with no web-framework dependency."""

import re


def sanitize_filename(name: str, extension: str = "pdf") -> str:
    """Return a filesystem-safe filename with the requested extension."""
    ext_lower = extension.lower().lstrip(".")

    if name.lower().endswith(f".{ext_lower}"):
        name = name[: -(len(ext_lower) + 1)]

    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = re.sub(r"\s+", "_", name)
    name = re.sub(r"_+", "_", name)
    name = name.strip("._- ") or "output"

    return f"{name}.{ext_lower}"


def sanitize_stem(name: str) -> str:
    """Return a filesystem-safe filename stem without an extension."""
    name = re.sub(r"\.[a-zA-Z0-9]{2,5}$", "", name)
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = re.sub(r"\s+", "_", name)
    name = re.sub(r"_+", "_", name)
    return name.strip("._- ") or "output"