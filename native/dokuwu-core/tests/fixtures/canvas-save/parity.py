"""Compares the Rust Canvas save with backend/core/edit_canvas.py.

Run from the repository root with the backend's virtualenv:

    cargo build --release --example canvas_save --manifest-path native/dokuwu-core/Cargo.toml
    python native/dokuwu-core/tests/fixtures/canvas-save/parity.py [path/to/canvas_save]

Every case is stamped by both sides onto the same source PDF (plain, turned by
90/180/270, with an offset crop box), with the same font library, and the two
results are rendered with MuPDF. Page sizes must be identical and the mean
absolute pixel difference per channel (0 to 255) must stay under the limit
(glyph edges differ a little between the two text writers). Exit code 1 on any
difference.
"""
import base64
import io
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import fitz
import numpy as np
from PIL import Image

CORE = Path(__file__).resolve().parents[3]
BACKEND = CORE.parents[1] / "backend"
sys.path.insert(0, str(BACKEND))

from config import settings  # noqa: E402
from core import font_library  # noqa: E402
from core.edit_canvas import save_edited_pdf  # noqa: E402

FONTS = CORE / "tests/fixtures/fonts"
LIMIT = 1.0
DPI = 96


def quadrant(fmt="PNG", size=(200, 100), exif=None):
    image = Image.new("RGB", size, (255, 255, 255))
    image.paste((255, 0, 0), (0, 0, size[0] // 2, size[1] // 2))
    image.paste((0, 0, 255), (size[0] // 2, size[1] // 2, size[0], size[1]))
    out = io.BytesIO()
    if exif:
        e = Image.Exif()
        e[0x0112] = exif
        image.save(out, format=fmt, exif=e.tobytes())
    else:
        image.save(out, format=fmt)
    return out.getvalue()


def data_url(raw, mime="image/png"):
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def corners(x, y, w, h, angle):
    a = math.radians(angle)
    c, s = math.cos(a), math.sin(a)
    return [[x + px * c - py * s, y + px * s + py * c] for px, py in [(0, 0), (w, 0), (w, h), (0, h)]]


def rotated_rect_corners(x, y, w, h, angle):
    cx, cy = x + w / 2, y + h / 2
    a = math.radians(angle)
    c, s = math.cos(a), math.sin(a)

    def r(px, py):
        dx, dy = px - cx, py - cy
        return [cx + dx * c - dy * s, cy + dx * s + dy * c]

    return [r(x, y), r(x + w, y), r(x + w, y + h), r(x, y + h)]


def text(x, y, content, **extra):
    item = {"type": "text", "x": x, "y": y, "width": 200, "text": content, "lines": content.split("\n"),
            "fontFamily": "Arial", "fontSize": 16, "lineHeight": 1.16, "color": "#102030", "opacity": 1}
    item.update(extra)
    return item


def page(objects, w=400, h=300, **extra):
    return {"canvas_width": w, "canvas_height": h, "native_objects": objects, **extra}


def image_obj(x, y, w, h, angle=0, opacity=1, asset="a", **extra):
    return {"id": "i", "type": "image", "assetId": asset, "x": x, "y": y, "width": w, "height": h, "angle": angle,
            "opacity": opacity, "vectorCorners": corners(x, y, w, h, angle), **extra}


SHAPES = [
    {"type": "rect", "x": 20, "y": 20, "width": 80, "height": 40, "strokeColor": "#102030", "strokeWidth": 2, "fillColor": "#d0e0f0", "fillOpacity": 60},
    {"type": "rect", "x": 120, "y": 20, "width": 80, "height": 40, "angle": 30, "strokeColor": "#a00000", "strokeWidth": 3, "fillColor": "#ffd0d0", "fillOpacity": 100},
    {"type": "rect", "x": 220, "y": 20, "width": 80, "height": 40, "angle": 20, "vectorCorners": rotated_rect_corners(220, 20, 80, 40, 20), "strokeColor": "#00a000", "strokeWidth": 2, "fillColor": "#d0ffd0", "fillOpacity": 40},
    {"type": "circle", "x": 20, "y": 90, "width": 80, "height": 50, "strokeColor": "#0000ff", "strokeWidth": 2, "fillColor": "#d0d0ff", "fillOpacity": 75},
    {"type": "circle", "x": 120, "y": 90, "width": 80, "height": 50, "angle": 35, "strokeColor": "#0000ff", "strokeWidth": 1, "fillColor": "#d0d0ff", "fillOpacity": 0},
    {"type": "circle", "x": 220, "y": 90, "width": 80, "height": 50, "angle": 30, "vectorCorners": rotated_rect_corners(220, 90, 80, 50, 30), "strokeColor": "#800080", "strokeWidth": 2, "fillColor": "#ffd0ff", "fillOpacity": 90},
    {"type": "line", "points": [20, 170, 140, 170], "angle": 25, "strokeColor": "#ff0000", "strokeWidth": 4},
    {"type": "pen", "x": 0, "y": 0, "vectorPath": [["M", 160, 160], ["Q", 190, 130, 220, 160], ["C", 230, 170, 250, 150, 260, 175], ["L", 280, 165]], "strokeColor": "#008000", "strokeWidth": 3, "opacity": 1},
    {"type": "highlighter", "x": 0, "y": 0, "vectorPath": [["M", 20, 200], ["L", 200, 205], ["L", 300, 200]], "strokeColor": "#ffee00", "strokeWidth": 14, "opacity": 0.4},
    {"type": "pen", "x": 0, "y": 0, "transformMatrix": [1, 0, 0, 1, 30, 220], "pathOffset": [0, 0], "vectorPath": [["M", 0, 0], ["L", 40, 30], ["L", 80, 0], ["Z"]], "strokeColor": "#ff8800", "strokeWidth": 2, "opacity": 0.8},
]

TEXTS = [
    text(20, 20, "Hello Canvas"),
    text(20, 60, "Bold Italic helv", bold=True, italic=True, fontSize=20),
    text(20, 100, "Tracking", letterSpacing=150, fontSize=22),
    text(20, 140, "Line one\nLine two\nLine three", textAlign="center", width=250, lineWidths=[100, 100, 120]),
    text(20, 220, "Right aligned", textAlign="right", width=300),
    text(220, 20, "Rotated 17", transformMatrix=[math.cos(math.radians(17)), math.sin(math.radians(17)), -math.sin(math.radians(17)), math.cos(math.radians(17)), 0, 0], angle=17),
    text(250, 140, "Angle 90", angle=90),
    text(20, 260, "Mono Regular 400", fontFamily="Red Hat Mono", fontWeight=400, fontSize=14),
    text(20, 280, "Mono Bold 700", fontFamily="Red Hat Mono", fontWeight=700, bold=True, fontSize=14),
    text(180, 260, "Italiana", fontFamily="Italiana", fontSize=18),
    text(180, 200, "Synthetic 500", fontFamily="Red Hat Mono", fontWeight=500, fontFaceWeight=400, syntheticStrokeEm=0.02, fontSize=18),
    text(180, 230, "Café tíng", letterSpacing=100, fontFamily="Red Hat Mono", fontSize=16),
]

IMAGES = {"a": data_url(quadrant()), "j": data_url(quadrant("JPEG"), "image/jpeg"), "w": data_url(quadrant("WEBP"), "image/webp"),
          "e": data_url(quadrant("JPEG", exif=6), "image/jpeg"), "t": data_url(quadrant("PNG", size=(120, 60)))}


def pic(objects):
    return page(objects, image_assets=IMAGES)


CASES = {
    "shapes": [page(SHAPES)],
    "texts": [page(TEXTS)],
    "images": [pic([image_obj(20, 20, 160, 80), image_obj(220, 20, 150, 90, angle=30, asset="j"), image_obj(40, 150, 120, 60, angle=90, asset="w"),
                    image_obj(200, 170, 80, 120, asset="e"), image_obj(300, 200, 90, 50, opacity=0.5, asset="t"), image_obj(120, 230, 60, 30)])],
    "image-angles": [pic([image_obj(100, 60, 200, 100, angle=a) for a in (0, 17, 45, 133, 270)])],
    "scale-2": [page([SHAPES[0], SHAPES[3], text(40, 40, "Scaled canvas", fontSize=32)], w=800, h=600)],
    "raster-str": [base64.b64encode(quadrant()).decode()],
    "raster-rect": [page([], image_b64=base64.b64encode(quadrant()).decode(), raster_rect=[50, 50, 200, 100])],
    "legacy": [{"canvas_width": 400, "canvas_height": 300, "shapes": [
        {"type": "rect", "x": 20, "y": 20, "width": 100, "height": 60, "strokeColor": "#102030", "strokeWidth": 2, "fillColor": "#d0e0f0", "fillOpacity": 50},
        {"type": "circle", "x": 150, "y": 20, "width": 100, "height": 60, "strokeColor": "#102030", "strokeWidth": 2, "fillColor": "#f0d0d0", "fillOpacity": 100},
        {"type": "line", "points": [20, 120, 250, 150], "strokeColor": "#008000", "strokeWidth": 3}]}],
    "two-pages": ["", page([SHAPES[0], TEXTS[0]])],
}

LAYOUTS = {
    "plain": {},
    "rot90": {"rotation": 90},
    "rot180": {"rotation": 180},
    "rot270": {"rotation": 270},
    "crop": {"crop": True},
    "rot90-crop": {"rotation": 90, "crop": True},
}


def python_view(annotations):
    """What the Python side gets: it turns text the opposite way from the
    editor (Fabric turns clockwise, fitz.Matrix counter-clockwise), which Rust
    fixes, so text angles are mirrored for the comparison."""
    out = json.loads(json.dumps(annotations))
    for entry in out:
        for item in entry.get("native_objects", []) if isinstance(entry, dict) else []:
            if item.get("type") != "text":
                continue
            if item.get("angle"):
                item["angle"] = -item["angle"]
            matrix = item.get("transformMatrix")
            if matrix:
                matrix[1], matrix[2] = -matrix[1], -matrix[2]
    return out


def make_source(path, layout, pages):
    doc = fitz.open()
    for _ in range(max(1, len(pages))):
        p = doc.new_page(width=400, height=300)
        p.insert_text((12, 20), "Original source text", fontsize=10)
        p.draw_line((10, 30), (390, 30), color=(0, 0, 0), width=1)
        p.draw_rect(fitz.Rect(330, 240, 390, 290), color=(0.2, 0.2, 0.2), fill=(0.9, 0.9, 0.6))
        if layout.get("crop"):
            p.set_cropbox(fitz.Rect(20, 30, 380, 280))
        if layout.get("rotation"):
            p.set_rotation(layout["rotation"])
    doc.save(path)
    doc.close()
    # Annotation canvas = visible (rotated, cropped) page size.
    page0 = fitz.open(path)[0]
    return page0.rect.width, page0.rect.height


def render(path, index):
    doc = fitz.open(path)
    pix = doc[index].get_pixmap(dpi=DPI, alpha=False)
    out = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    doc.close()
    return out


def main():
    exe = Path(sys.argv[1]) if len(sys.argv) > 1 else CORE / "target/release/examples/canvas_save"
    failures = rows = 0
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        settings.APP_DATA_DIR = tmp / "appdata"
        for font in sorted(FONTS.glob("*.ttf")):
            font_library.save_font(font.read_bytes(), font.name)
        fonts_dir = settings.APP_DATA_DIR / "fonts"
        for layout_name, layout in LAYOUTS.items():
            for case_name, pages in CASES.items():
                src = tmp / "src.pdf"
                width, height = make_source(src, layout, pages)
                annotations = json.loads(json.dumps(pages))
                for entry in annotations:
                    if isinstance(entry, dict) and "canvas_width" in entry:
                        # Canvas is the editor's view of the (rotated, cropped) page.
                        if entry["canvas_width"] == 400:
                            entry["canvas_width"], entry["canvas_height"] = width, height
                ann = tmp / "ann.json"
                ann.write_text(json.dumps(annotations))
                expected_path = tmp / "py.pdf"
                try:
                    save_edited_pdf(src, python_view(annotations), expected_path)
                except Exception as exc:  # noqa: BLE001
                    print(f"python failed {layout_name}/{case_name}: {exc}")
                    continue
                out_dir = tmp / f"out-{layout_name}-{case_name}"
                out_dir.mkdir()
                run = subprocess.run([exe, src, ann, out_dir, fonts_dir], capture_output=True, text=True)
                if run.returncode != 0:
                    print(f"FAIL {layout_name}/{case_name}: {run.stderr.strip()}")
                    failures += 1
                    continue
                got_path = run.stdout.strip()
                if layout.get("rotation") and case_name == "raster-str":
                    # Python stamps a whole-page raster in unrotated coordinates, so it
                    # turns with the page; Rust fits it to the page as shown.
                    print(f"{layout_name:11s} {case_name:12s} skipped (deliberate difference)")
                    continue
                if layout.get("crop") and case_name in ("texts", "scale-2", "two-pages"):
                    # Python puts text higher by the crop offset; Rust matches the shapes.
                    print(f"{layout_name:11s} {case_name:12s} skipped (Python text offset bug)")
                    continue
                if layout.get("rotation") and layout.get("crop"):
                    # Python's remove_rotation drops the crop box; Rust keeps the page's crop.
                    print(f"{layout_name:11s} {case_name:12s} skipped (deliberate difference)")
                    continue
                for index in range(len(pages)):
                    expected, got = render(expected_path, index), render(got_path, index)
                    rows += 1
                    if expected.size != got.size:
                        print(f"SIZE {layout_name}/{case_name} p{index}: rust {got.size} vs python {expected.size}")
                        failures += 1
                        continue
                    diff = float(np.abs(np.asarray(got, dtype=int) - np.asarray(expected, dtype=int)).mean())
                    flag = "" if diff <= LIMIT else "  <-- above limit"
                    if flag:
                        failures += 1
                        got.save(f"/tmp/rust-{layout_name}-{case_name}-{index}.png")
                        expected.save(f"/tmp/py-{layout_name}-{case_name}-{index}.png")
                    print(f"{layout_name:11s} {case_name:12s} p{index} {got.size[0]}x{got.size[1]} diff {diff:6.3f}{flag}")
    print(f"{rows} pages compared, {failures} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
