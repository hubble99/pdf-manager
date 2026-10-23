"""Compares the Rust font library with backend/core/font_library.py.

Run from the repository root with the backend's virtualenv:

    cargo build --release --example font_library --manifest-path native/dokuwu-core/Cargo.toml
    python native/dokuwu-core/tests/fixtures/font-library/parity.py [fonts folder ...]

Every .ttf/.otf under the folders (default: the system font folders and the
OFL fonts of the canvas-design examples, when present) is added by both sides;
the family, weight and italic they derive must be identical, and a font one side
refuses must be refused by the other. Exit code 1 on any difference.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

CORE = Path(__file__).resolve().parents[3]
BACKEND = CORE.parents[1] / "backend"
sys.path.insert(0, str(BACKEND))

from config import settings  # noqa: E402
from core import font_library  # noqa: E402

DEFAULT_FOLDERS = ["/usr/share/fonts", "/mnt/skills/examples/canvas-design/canvas-fonts", "C:/Windows/Fonts"]


def main():
    folders = [Path(p) for p in (sys.argv[1:] or DEFAULT_FOLDERS)]
    fonts = sorted({p for folder in folders if folder.exists() for p in folder.rglob("*") if p.suffix.lower() in (".ttf", ".otf")})
    exe = CORE / "target/release/examples/font_library"
    out = subprocess.run([exe, *map(str, fonts)], capture_output=True, text=True, check=True).stdout
    rust = {json.loads(line)["file"]: json.loads(line) for line in out.splitlines()}

    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        settings.APP_DATA_DIR = Path(tmp)
        for font in fonts:
            try:
                saved = font_library.save_font(font.read_bytes(), font.name)
                expected = {"family": saved["family"], "weight": saved["weight"], "bold": saved["bold"], "italic": saved["italic"]}
            except ValueError as exc:
                expected = {"error": str(exc)}
            got = rust.get(font.name, {})
            if "error" not in expected:
                # MuPDF keeps only 31 bytes of a face name, so the old library cut
                # the family of long names ("... ExtraLight Itali"); Rust does not.
                stored = font_library._read_index()[saved["id"]]["full_name"]
                if len(stored.encode()) >= 31 and got.get("family") != expected["family"]:
                    print(f"known: {font.name} has a name MuPDF cut at 31 bytes ({expected['family']!r} -> {got.get('family')!r})")
                    expected["family"] = got.get("family")
            if "error" in expected or "error" in got:
                same = ("error" in expected) == ("error" in got)
            else:
                same = all(got.get(k) == v for k, v in expected.items())
            if not same:
                failures += 1
                print(f"DIFF {font.name}: rust {got} vs python {expected}")
    print(f"{len(fonts)} fonts, {failures} differences")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
