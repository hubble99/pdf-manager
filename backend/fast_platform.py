"""Keep ``platform.system()`` from launching ``cmd.exe /c ver`` in the packaged app.

On Windows, ``platform.uname()`` can fall back to running ``ver`` through a
shell. Bundled libraries (fontTools reads ``platform.system()`` at import time)
trigger it in every packaged process, including each inspector launch. When
frozen on Windows we pre-fill the interpreter's own uname cache from values the
process already has, so every later ``platform.*`` call is answered from memory.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Callable


def windows_uname(
    platform_module: Any,
    *,
    windows_version: Callable[[], Any],
    environ: Any,
    banner: str,
) -> Any:
    version = windows_version()
    build = int(getattr(version, "build", 0))
    release = "11" if build >= 22000 else "10"
    banner = banner.lower()
    machine = "ARM64" if "arm64" in banner else "AMD64" if "amd64" in banner else str(
        environ.get("PROCESSOR_ARCHITECTURE", "")
    )
    return platform_module.uname_result(
        "Windows",
        str(environ.get("COMPUTERNAME", "")),
        release,
        f"{version.major}.{version.minor}.{build}",
        machine,
    )


def install() -> bool:
    """Seed the uname cache; returns False (and changes nothing) when not applicable."""
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return False
    try:
        import platform

        if getattr(platform, "_uname_cache", None) is not None:
            return True
        platform._uname_cache = windows_uname(
            platform,
            windows_version=sys.getwindowsversion,
            environ=os.environ,
            banner=sys.version,
        )
        return True
    except Exception:  # noqa: BLE001 - purely an optimisation; platform still works normally.
        return False
