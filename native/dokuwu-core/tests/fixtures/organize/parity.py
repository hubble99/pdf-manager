"""Compares Rust Organize with the old Python implementation.

Run from the repository root with the backend's virtualenv:

    cargo build --release --example organize --manifest-path native/dokuwu-core/Cargo.toml
    python native/dokuwu-core/tests/fixtures/organize/parity.py [path/to/organize]

Thumbnails: page 1 and 2 of every fixture PDF at widths 48, 150 and 400 are
rendered by both sides (backend/core/organize_thumbnails.py) and compared.
Assembling: for every fixture PDF and a few pictures, a list that mirrors,
turns and repeats pages is built by both sides (backend/core/organize_assembly.py)
and the pages are rendered at 72 dpi and compared. Prints the size match and
the mean absolute pixel difference per channel (0 to 255). Exit code 1 when a
size or page count differs or a difference is above the limit.
"""
import base64
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import fitz
import numpy as np
from PIL import Image

CORE = Path(__file__).resolve().parents[3]
BACKEND = CORE.parents[1] / "backend"
sys.path.insert(0, str(BACKEND))

from core import organize_assembly, organize_thumbnails  # noqa: E402
from config import settings  # noqa: E402

fitz.TOOLS.set_icc(True)

FOLDERS = [CORE / "tests/fixtures/pdf-compress", CORE / "tests/fixtures/pdf-to-word"]
SKIP = {"encrypted.pdf", "not-a-pdf.pdf"}
LIMIT = 2.0
failures = 0


def report(label, size_a, size_b, diff=None):
    global failures
    if size_a != size_b:
        print(f"SIZE {label}: rust {size_a} vs python {size_b}")
        failures += 1
        return
    flag = ""
    if diff is not None and diff > LIMIT:
        flag = "  <-- above limit"
        failures += 1
    shown = "" if diff is None else f" diff {diff:6.3f}"
    print(f"{label:46s} {size_a[0]:5d}x{size_a[1]:<5d}{shown}{flag}")


def mean_diff(a, b):
    return float(np.abs(np.asarray(a, dtype=int) - np.asarray(b, dtype=int)).mean())


def make_special_pdfs(folder):
    """Pages with an off-centre crop box, an origin-shifted media box and rotation."""
    doc = fitz.open()
    for n in range(4):
        page = doc.new_page(width=400, height=300)
        page.draw_rect(fitz.Rect(30, 30, 90 + n * 20, 70), color=None, fill=(0.2 * n, 0.4, 0.8))
        page.draw_rect(fitz.Rect(300, 200, 330, 240), color=None, fill=(0.9, 0.2, 0.1))
        page.insert_text((40, 120), f"Page {n + 1} sample text", fontsize=18)
    doc[1].set_cropbox(fitz.Rect(50, 40, 350, 260))
    doc[2].set_rotation(90)
    doc[3].set_cropbox(fitz.Rect(100, 50, 380, 280))
    doc[3].set_rotation(270)
    path = folder / "special.pdf"
    doc.save(path)
    return path


def make_pictures(folder):
    paths = []
    rgba = Image.new("RGBA", (120, 80), (0, 0, 0, 0))
    for x in range(120):
        for y in range(80):
            rgba.putpixel((x, y), (x * 2, y * 3, 120, 255 if x > 30 else 90))
    paths.append(folder / "gradient.png")
    rgba.save(paths[-1])
    # Soft shapes like a photo; a pattern that changes colour every pixel only
    # measures how the two JPEG encoders round it.
    photo = Image.new("RGB", (200, 100))
    for x in range(200):
        for y in range(100):
            photo.putpixel((x, y), (int(127 + 120 * np.sin(x / 23)), int(127 + 120 * np.cos(y / 17)), (x + y) % 256))
    paths.append(folder / "photo.jpg")
    photo.save(paths[-1], quality=90)
    return paths


def python_thumbs(path, start, count, width, kind="pdf"):
    batch = organize_thumbnails.render_batch(path, kind, start, count, width)
    return [
        (p["page"], Image.open(io.BytesIO(base64.b64decode(p["data"]))).convert("RGB")) for p in batch["pages"]
    ]


def check_thumbs(exe, pdf, tmp, kind="pdf"):
    if kind == "pdf":
        with fitz.open(pdf) as doc:
            if doc.is_encrypted or doc.page_count < 1:
                return
    for width in (48, 150, 400):
        out = tmp / "thumbs"
        out.mkdir(exist_ok=True)
        run = subprocess.run([exe, "thumbs", str(pdf), "1", "2", str(width), str(out)], capture_output=True, text=True)
        if run.returncode != 0:
            print(f"FAIL thumbs {pdf.name} {width}: {run.stderr.strip()}")
            global failures
            failures += 1
            continue
        for page, expected in python_thumbs(pdf, 1, 2, width, kind):
            got = Image.open(out / f"page_{page}.png").convert("RGB")
            diff = mean_diff(got, expected) if got.size == expected.size else None
            report(f"thumb {pdf.name} p{page} w{width}", got.size, expected.size, diff)


def refs_for(count, kind):
    last = min(count, 3)
    refs = [{"source": 0, "page": 1, "rotation": 0, "flip": True}]
    refs.append({"source": 0, "page": last, "rotation": 90, "flip": False})
    refs.append({"source": 0, "page": 1, "rotation": 180, "flip": True})
    refs.append({"source": 0, "page": last, "rotation": 270, "flip": True})
    refs.append({"source": 0, "page": 1, "rotation": 0, "flip": False})
    return refs


def render_pages(path):
    out = []
    with fitz.open(path) as doc:
        for page in doc:
            out.append(Image.open(io.BytesIO(page.get_pixmap(dpi=72).tobytes("png"))).convert("RGB"))
    return out


def check_assemble(exe, path, kind, tmp):
    global failures
    if kind == "pdf":
        with fitz.open(path) as doc:
            if doc.is_encrypted or doc.page_count < 1:
                return
            count = doc.page_count
    else:
        count = 1
    refs = refs_for(count, kind)

    rust_out = tmp / "rust"
    py_out = tmp / "python"
    rust_out.mkdir(exist_ok=True)
    py_out.mkdir(exist_ok=True)
    refs_file = tmp / "refs.json"
    refs_file.write_text(json.dumps(refs))
    run = subprocess.run([exe, "assemble", str(rust_out), str(refs_file), str(path)], capture_output=True, text=True)
    if run.returncode != 0:
        print(f"FAIL assemble {path.name}: {run.stderr.strip()}")
        failures += 1
        return
    rust_pdf = rust_out / "organized.pdf"

    settings.OUTPUT_DIR = py_out
    documents = {"d0": SimpleNamespace(path=path, kind=kind, page_count=count)}
    py_refs = [dict(r, source="d0") for r in refs]
    py_pdf, _, _ = organize_assembly.assemble_pages(py_refs, documents, "organized.pdf")

    a, b = render_pages(rust_pdf), render_pages(py_pdf)
    if len(a) != len(b):
        print(f"PAGES {path.name}: rust {len(a)} vs python {len(b)}")
        failures += 1
        return
    for i, (x, y) in enumerate(zip(a, b), start=1):
        diff = mean_diff(x, y) if x.size == y.size else None
        report(f"assemble {path.name} entry {i}", x.size, y.size, diff)
    for f in list(rust_out.iterdir()) + list(py_out.iterdir()):
        f.unlink()


def main():
    exe = Path(sys.argv[1]) if len(sys.argv) > 1 else CORE / "target/release/examples/organize"
    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        extra = tmp / "extra"
        extra.mkdir()
        special = make_special_pdfs(extra)
        pictures = make_pictures(extra)
        pdfs = [p for folder in FOLDERS for p in sorted(folder.glob("*.pdf")) if p.name not in SKIP] + [special]
        for pdf in pdfs:
            check_thumbs(exe, pdf, tmp)
        for pdf in pdfs:
            check_assemble(exe, pdf, "pdf", tmp)
        for picture in pictures:
            # The old thumbnail dropped the alpha channel instead of flattening
            # it on white like the saved page does, so a transparent picture
            # looked different in the grid than in the result. Rust flattens;
            # only opaque pictures can be compared.
            if picture.suffix != ".png":
                check_thumbs(exe, picture, tmp, "image")
            check_assemble(exe, picture, "image", tmp)
    print("FAILED" if failures else "OK", failures)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
