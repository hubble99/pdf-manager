#!/usr/bin/env python3
"""Regenerate every raster logo asset from the two SVG masters in docs/brand.

    python scripts/brand/generate_brand_assets.py

Masters (edit these, never the PNG/ICO output):
  docs/brand/dokuwu-logo.svg   full mascot, used from 64 px up
  docs/brand/dokuwu-mark.svg   simplified mascot (no arms, legs, text lines or
                               shield), used at 48 px and below where the extra
                               detail turns into noise

Output:
  frontend/src-tauri/icons/     Tauri bundle icons (png, ico, icns, Windows tiles)
  frontend/public/favicon.svg   copy of the mark master
  frontend/src/assets/brand/    copies of both masters for the app UI
  docs/assets/                  favicon and logo for the GitHub Pages site
  docs/brand/store/             MSIX package assets and Partner Center listing art

Needs Pillow and a Chromium-based browser (set CHROME_BIN to override detection).
The browser is only used to rasterise the SVG at 1024 px; all smaller sizes are
resampled from that render.
"""
from __future__ import annotations

import io
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "docs" / "brand"
ICONS = ROOT / "frontend" / "src-tauri" / "icons"
STORE = BRAND / "store"
MASTER_SIZE = 1024
# At or below this size the simplified mark replaces the full mascot.
MARK_MAX = 64
BRAND_BG = (58, 78, 110, 255)  # navy used behind the logo on opaque surfaces


def find_browser() -> str:
    env = os.environ.get("CHROME_BIN")
    if env:
        return env
    for name in ("chromium", "chromium-browser", "google-chrome", "chrome", "msedge"):
        found = shutil.which(name)
        if found:
            return found
    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    ]
    for path in candidates:
        if Path(path).exists():
            return path
    sys.exit("No Chromium-based browser found. Set CHROME_BIN.")


def rasterise(svg: Path, browser: str) -> Image.Image:
    """Render an SVG to a transparent MASTER_SIZE square."""
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "page.html"
        shot = Path(tmp) / "shot.png"
        page.write_text(
            "<html><body style='margin:0;background:transparent'>"
            f"<img src='{svg.resolve().as_uri()}' width={MASTER_SIZE} height={MASTER_SIZE}>"
            "</body></html>"
        )
        # Headless windows are shorter than requested, so ask for extra height and crop.
        subprocess.run(
            [
                browser, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
                "--default-background-color=00000000",
                f"--window-size={MASTER_SIZE},{MASTER_SIZE + 300}",
                f"--screenshot={shot}", page.resolve().as_uri(),
            ],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        img = Image.open(shot).convert("RGBA")
        return img.crop((0, 0, MASTER_SIZE, MASTER_SIZE))


class Logo:
    def __init__(self, full: Image.Image, mark: Image.Image):
        self.full, self.mark = full, mark

    def square(self, size: int, variant: str | None = None) -> Image.Image:
        src = self.mark if (variant or ("mark" if size <= MARK_MAX else "full")) == "mark" else self.full
        return src.resize((size, size), Image.LANCZOS)

    def tile(self, width: int, height: int, fill: float = 0.86, variant: str | None = None) -> Image.Image:
        """Centre the logo on a transparent width x height canvas."""
        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        side = max(1, round(min(width, height) * fill))
        canvas.alpha_composite(self.square(side, variant), ((width - side) // 2, (height - side) // 2))
        return canvas


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_ico(logo: Logo, path: Path) -> None:
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [(s, png_bytes(logo.square(s))) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries, blobs = b"", b""
    for size, data in frames:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    path.write_bytes(header + entries + blobs)


def write_icns(logo: Logo, path: Path) -> None:
    chunks = b""
    for tag, size in ((b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024)):
        data = png_bytes(logo.square(size, "full"))
        chunks += tag + struct.pack(">I", len(data) + 8) + data
    path.write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


def tauri_icons(logo: Logo) -> None:
    save_png(logo.square(32), ICONS / "32x32.png")
    save_png(logo.square(128), ICONS / "128x128.png")
    save_png(logo.square(256), ICONS / "128x128@2x.png")
    save_png(logo.square(512), ICONS / "icon.png")
    for size in (30, 44, 71, 89, 107, 142, 150, 284, 310):
        save_png(logo.square(size), ICONS / f"Square{size}x{size}Logo.png")
    save_png(logo.square(50), ICONS / "StoreLogo.png")
    write_ico(logo, ICONS / "icon.ico")
    write_icns(logo, ICONS / "icon.icns")


SCALES = (100, 125, 150, 200, 400)


def msix_assets(logo: Logo) -> None:
    out = STORE / "Assets"

    def scaled(name: str, width: int, height: int, fill: float, variant: str | None = None) -> None:
        for scale in SCALES:
            w, h = round(width * scale / 100), round(height * scale / 100)
            save_png(logo.tile(w, h, fill, variant), out / f"{name}.scale-{scale}.png")

    scaled("Square44x44Logo", 44, 44, 0.96, "mark")
    scaled("Square71x71Logo", 71, 71, 0.9)
    scaled("Square150x150Logo", 150, 150, 0.82)
    scaled("Wide310x150Logo", 310, 150, 0.82)
    scaled("Square310x310Logo", 310, 310, 0.82)
    scaled("StoreLogo", 50, 50, 0.96, "mark")
    scaled("SplashScreen", 620, 300, 0.7)

    # App-list and taskbar icons. altform-unplated skips the tile plate on the taskbar.
    for size in (16, 24, 32, 48, 256):
        img = logo.tile(size, size, 1.0)
        save_png(img, out / f"Square44x44Logo.targetsize-{size}.png")
        save_png(img, out / f"Square44x44Logo.targetsize-{size}_altform-unplated.png")
        save_png(img, out / f"Square44x44Logo.altform-lightunplated_targetsize-{size}.png")


def listing_art(logo: Logo) -> None:
    out = STORE / "listing"
    save_png(logo.tile(300, 300, 0.92), out / "logo-300x300.png")
    save_png(logo.tile(1080, 1080, 0.86), out / "logo-1080x1080-transparent.png")
    plate = Image.new("RGBA", (1080, 1080), BRAND_BG)
    plate.alpha_composite(logo.tile(1080, 1080, 0.7))
    save_png(plate.convert("RGB"), out / "logo-1080x1080-navy.png")
    wide = Image.new("RGBA", (2400, 1200), BRAND_BG)
    wide.alpha_composite(logo.tile(2400, 1200, 0.8))
    save_png(wide.convert("RGB"), out / "hero-2400x1200-navy.png")


def web_assets(logo: Logo) -> None:
    shutil.copyfile(BRAND / "dokuwu-mark.svg", ROOT / "frontend" / "public" / "favicon.svg")
    assets = ROOT / "frontend" / "src" / "assets" / "brand"
    assets.mkdir(parents=True, exist_ok=True)
    for name in ("dokuwu-logo.svg", "dokuwu-mark.svg"):
        shutil.copyfile(BRAND / name, assets / name)
    save_png(logo.square(64, "mark"), ROOT / "docs" / "assets" / "favicon.png")
    save_png(logo.square(256, "full"), ROOT / "docs" / "assets" / "logo.png")


def main() -> None:
    browser = find_browser()
    logo = Logo(rasterise(BRAND / "dokuwu-logo.svg", browser), rasterise(BRAND / "dokuwu-mark.svg", browser))
    tauri_icons(logo)
    msix_assets(logo)
    listing_art(logo)
    web_assets(logo)
    print("Brand assets written.")


if __name__ == "__main__":
    main()
