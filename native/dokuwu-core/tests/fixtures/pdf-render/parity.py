"""Compares the Rust page renderer with PyMuPDF, the old preview route.

Run from the repository root after building the example:

    cargo build --release --example pdf_render --manifest-path native/dokuwu-core/Cargo.toml
    python3 native/dokuwu-core/tests/fixtures/pdf-render/parity.py [path/to/pdf_render]

Needs pymupdf, pillow and numpy. For every PDF in the fixture folders it renders
page 1 at 72, 150 and 300 dpi with each quality hint, using the same size rules
as backend/core/pdf_preview.py, and prints the size match and the mean absolute
pixel difference per channel (0 to 255). Exit code 1 when a size differs or a
difference is above the limit.
"""
import io
import subprocess
import sys
import tempfile
from pathlib import Path

import fitz
import numpy as np
from PIL import Image

fitz.TOOLS.set_icc(True)

CORE = Path(__file__).resolve().parents[3]
FOLDERS = [CORE / "tests/fixtures/pdf-compress", CORE / "tests/fixtures/pdf-to-word"]
SKIP = {"encrypted.pdf", "not-a-pdf.pdf"}
LIMIT = 2.0
MAX_DIM = {"low": 1024, "auto": 2048, "high": 4096}


def old_preview_dpi(page, dpi, hint):
    """backend/core/pdf_preview.py, size rules only."""
    limit = MAX_DIM[hint]
    w = page.rect.width * (dpi / 72)
    h = page.rect.height * (dpi / 72)
    scale = 1.0
    if w > limit or h > limit:
        scale = min(limit / w, limit / h)
    return max(36, int(dpi * scale))


def main():
    exe = Path(sys.argv[1]) if len(sys.argv) > 1 else CORE / "target/release/examples/pdf_render"
    failures = 0
    rows = 0
    with tempfile.TemporaryDirectory() as tmp:
        for folder in FOLDERS:
            for pdf in sorted(folder.glob("*.pdf")):
                if pdf.name in SKIP:
                    continue
                try:
                    doc = fitz.open(pdf)
                except Exception:
                    continue
                if doc.is_encrypted or doc.page_count < 1:
                    continue
                page = doc[0]
                for dpi in (72, 150, 300):
                    for hint in ("low", "auto", "high"):
                        actual = old_preview_dpi(page, dpi, hint)
                        expected = Image.open(io.BytesIO(page.get_pixmap(dpi=actual).tobytes("png"))).convert("RGB")
                        out = Path(tmp) / "out.png"
                        run = subprocess.run([exe, str(pdf), str(out), "1", str(dpi), hint], capture_output=True, text=True)
                        if run.returncode != 0:
                            print(f"FAIL {pdf.name} {dpi} {hint}: {run.stderr.strip()}")
                            failures += 1
                            continue
                        got = Image.open(out).convert("RGB")
                        rows += 1
                        if got.size != expected.size:
                            print(f"SIZE {pdf.name} {dpi}/{hint}: rust {got.size} vs pymupdf {expected.size}")
                            failures += 1
                            continue
                        diff = float(np.abs(np.asarray(got, dtype=int) - np.asarray(expected, dtype=int)).mean())
                        flag = "" if diff <= LIMIT else "  <-- above limit"
                        if flag:
                            failures += 1
                        print(f"{pdf.name:24s} {dpi:3d} {hint:5s} {got.size[0]:5d}x{got.size[1]:<5d} diff {diff:6.3f}{flag}")
    print(f"{rows} renders compared, {failures} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
