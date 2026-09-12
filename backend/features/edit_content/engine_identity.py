"""Pinned PDFium identity shared by the backend and native worker build."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import platform
import re


@dataclass(frozen=True)
class EngineIdentity:
    build: str
    wrapper: str
    target: str
    library_file: str
    library_sha256: str


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
    resource_dir = os.environ.get("PDF_MANAGER_EDIT_CONTENT_RESOURCE_DIR")
    if resource_dir:
        return Path(resource_dir) / "pdfium-artifacts.json"
    project_root = Path(__file__).resolve().parents[3]
    return project_root / "native" / "edit-content-engine" / "pdfium-artifacts.json"


def load_engine_identity() -> EngineIdentity:
    try:
        manifest = json.loads(_manifest_path().read_text(encoding="utf-8"))
        if manifest.get("schema") != "edit-content-pdfium-artifacts/v1":
            raise ValueError
        target = _target_name()
        pin = manifest["targets"][target]
        build = manifest["buildIdentity"]
        wrapper = manifest["wrapperVersion"]
        library_file = pin["libraryFile"]
        library_sha256 = pin["librarySha256"]
        if (build != "154.0.8035.0" or wrapper != "0.9.4"
                or not isinstance(library_file, str) or not library_file
                or re.fullmatch(r"[0-9a-f]{64}", library_sha256) is None):
            raise ValueError
        return EngineIdentity(build, wrapper, target, library_file, library_sha256)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RuntimeError("Pinned Edit Content PDFium identity is unavailable or invalid") from exc
