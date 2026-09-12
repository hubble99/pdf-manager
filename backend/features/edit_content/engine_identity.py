"""Pinned PDFium identity shared by the backend and native worker build."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import platform
import re
import sys


@dataclass(frozen=True)
class EngineIdentity:
    build: str
    wrapper: str
    target: str
    library_file: str
    library_sha256: str

    def verification_identity(self) -> dict[str, str]:
        return {"build": self.build.removesuffix(".0"), "wrapper": self.wrapper,
                "sha256": self.library_sha256}


def _target_name() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if machine in {"amd64", "x86_64", "x64"}:
        arch = "x86_64"
    else:
        raise RuntimeError("Edit Content has no pinned PDFium artifact for this architecture")
    if system == "windows":
        return f"windows-{arch}"
    if system == "linux":
        return f"linux-{arch}"
    raise RuntimeError("Edit Content has no pinned PDFium artifact for this operating system")


def _manifest_path() -> Path:
    # The expected pin belongs to the backend build, never to runtime overrides.
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "edit-content" / "pdfium-artifacts.json"
    project_root = Path(__file__).resolve().parents[3]
    return project_root / "native" / "edit-content-engine" / "pdfium-artifacts.json"


def load_engine_identity() -> EngineIdentity:
    return _read_identity(_manifest_path())


def validate_runtime_identity(resource_root: Path, expected: EngineIdentity) -> None:
    if _read_identity(resource_root / "pdfium-artifacts.json") != expected:
        raise RuntimeError("Packaged Edit Content identity does not match the backend build")


def _read_identity(path: Path) -> EngineIdentity:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("schema") != "edit-content-pdfium-artifacts/v1":
            raise ValueError
        target = _target_name()
        pin = manifest["targets"][target]
        build = manifest["buildIdentity"]
        wrapper = manifest["wrapperVersion"]
        library_file = pin["libraryFile"]
        library_sha256 = pin["librarySha256"]
        if (build != "154.0.8035.0" or wrapper != "0.9.4"
                or library_file != ("pdfium.dll" if target.startswith("windows-") else "libpdfium.so")
                or not isinstance(library_sha256, str)
                or re.fullmatch(r"[0-9a-f]{64}", library_sha256) is None):
            raise ValueError
        return EngineIdentity(build, wrapper, target, library_file, library_sha256)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RuntimeError("Pinned Edit Content PDFium identity is unavailable or invalid") from exc
