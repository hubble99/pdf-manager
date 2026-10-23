"""Compares the Rust editor renderer with PyMuPDF, the old /pdf-to-image routes.

Run from the repository root after building the example:

    cargo build --release --example pdf_render --manifest-path native/dokuwu-core/Cargo.toml
    python3 native/dokuwu-core/tests/fixtures/canvas-pages/parity.py [path/to/pdf_render]

Needs pymupdf, pillow and numpy plus the backend (for `core.render_color.safe_dpi`).
Every page of every PDF in the fixture folders is rendered at 200 dpi and at the
zoomed 300 and 500 dpi; the old route's dpi and pixel size must be identical, the
announced `--pages-meta` size must match the real render, and the mean absolute
pixel difference per channel (0 to 255) must stay under the limit.
Exit code 1 on any difference.
"""
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import fitz
import numpy as np
from PIL import Image

fitz.TOOLS.set_icc(True)

CORE = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(CORE.parents[1] / "backend"))
from core.render_color import safe_dpi  # noqa: E402

FOLDERS = [CORE / "tests/fixtures/pdf-compress", CORE / "tests/fixtures/pdf-to-word"]
SKIP = {"encrypted.pdf", "not-a-pdf.pdf"}
LIMIT = 2.0
MAX_PAGES = 4


def main():
    exe = Path(sys.argv[1]) if len(sys.argv) > 1 else CORE / "target/release/examples/pdf_render"
    failures = rows = 0
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
                for dpi in (200, 300, 500):
                    meta = json.loads(subprocess.run([exe, str(pdf), "--pages-meta", str(dpi)], capture_output=True, text=True, check=True).stdout)
                    for index in range(min(doc.page_count, MAX_PAGES)):
                        page = doc[index]
                        actual = safe_dpi(page, max(72, min(500, dpi)))
                        pix = page.get_pixmap(dpi=actual, alpha=False)
                        expected = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
                        out = Path(tmp) / "out.png"
                        run = subprocess.run([exe, str(pdf), str(out), str(index + 1), str(dpi), "editor"], capture_output=True, text=True)
                        if run.returncode != 0:
                            print(f"FAIL {pdf.name} p{index + 1} {dpi}: {run.stderr.strip()}")
                            failures += 1
                            continue
                        got = Image.open(out).convert("RGB")
                        rows += 1
                        announced = meta["pages"][index]
                        if got.size != expected.size or run.stdout.split()[2] != str(actual):
                            print(f"SIZE {pdf.name} p{index + 1} {dpi}: rust {got.size}@{run.stdout.split()[2]} vs pymupdf {expected.size}@{actual}")
                            failures += 1
                            continue
                        if (announced["width"], announced["height"], announced["dpi"]) != (got.size[0], got.size[1], actual):
                            print(f"META {pdf.name} p{index + 1} {dpi}: announced {announced}, rendered {got.size}")
                            failures += 1
                            continue
                        diff = float(np.abs(np.asarray(got, dtype=int) - np.asarray(expected, dtype=int)).mean())
                        flag = "" if diff <= LIMIT else "  <-- above limit"
                        if flag:
                            failures += 1
                        print(f"{pdf.name:24s} p{index + 1} {dpi:3d} {got.size[0]:5d}x{got.size[1]:<5d} diff {diff:6.3f}{flag}")
    print(f"{rows} renders compared, {failures} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
