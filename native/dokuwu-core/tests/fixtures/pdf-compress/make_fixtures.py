"""Builds the PDFs used by tests/pdf_compress.rs.

Run from this folder:  python3 make_fixtures.py   (needs pymupdf, pillow, numpy)

Every picture is synthetic and deterministic, so the fixtures can be rebuilt.
Photos are smooth shapes plus mild noise: big as lossless data, small as JPEG,
like real photos.
"""
import io
from pathlib import Path

import fitz
import numpy as np
from PIL import Image, ImageCms, ImageDraw

OUT = Path(__file__).parent


def photo(size=(320, 240), seed=1, mode="RGB"):
    rng = np.random.default_rng(seed)
    w, h = size
    y, x = np.mgrid[0:h, 0:w]
    base = np.stack(
        [
            127 + 100 * np.sin(x / (23 + seed) + seed),
            127 + 100 * np.sin(y / (17 + seed) - seed),
            127 + 100 * np.sin((x + y) / (31 + seed)),
        ],
        axis=-1,
    )
    base += rng.normal(0, 6, base.shape)
    img = Image.fromarray(np.clip(base, 0, 255).astype("uint8"), "RGB")
    return img.convert("L") if mode == "L" else img


def png(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def jpeg(img, quality=95):
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def page_with(doc, stream, rect=(20, 20, 280, 220), size=(300, 240)):
    page = doc.new_page(width=size[0], height=size[1])
    xref = page.insert_image(fitz.Rect(*rect), stream=stream)
    return page, xref


def save(doc, name, **kw):
    doc.save(OUT / name, **kw)
    doc.close()


def build():
    # An ordinary RGB photo stored losslessly.
    doc = fitz.open()
    page, xref = page_with(doc, png(photo()))
    doc.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
    save(doc, "photo.pdf", deflate=True)

    # Grey photo.
    doc = fitz.open()
    page, xref = page_with(doc, png(photo(mode="L", seed=2)))
    doc.xref_set_key(xref, "ColorSpace", "/DeviceGray")
    save(doc, "gray.pdf", deflate=True)

    # A high quality JPEG that is re-encoded at a lower quality.
    doc = fitz.open()
    page_with(doc, jpeg(photo(seed=3), 98))
    save(doc, "jpeg-source.pdf", deflate=True)

    # Transparency: black under fully transparent corners.
    pic = photo((320, 320), seed=4).convert("RGBA")
    alpha = Image.new("L", pic.size, 0)
    ImageDraw.Draw(alpha).ellipse((20, 20, 300, 300), fill=255)
    pic.putalpha(alpha)
    pic = Image.composite(pic, Image.new("RGBA", pic.size, (0, 0, 0, 0)), alpha)
    doc = fitz.open()
    page_with(doc, png(pic), rect=(10, 10, 290, 290), size=(300, 300))
    save(doc, "transparent.pdf", deflate=True)

    # Stencil mask: must stay exactly as it is.
    stencil = Image.new("1", (256, 256), 1)
    ImageDraw.Draw(stencil).rectangle((32, 32, 160, 160), fill=0)
    doc = fitz.open()
    page, xref = page_with(doc, png(stencil), rect=(0, 0, 100, 100), size=(100, 100))
    doc.xref_set_key(xref, "ImageMask", "true")
    save(doc, "stencil.pdf", deflate=True)

    # Palette image (Indexed): left alone. PyMuPDF expands palettes itself, so
    # the colour space and the index samples are written by hand.
    quant = photo(seed=5).quantize(64)
    palette = bytes(quant.getpalette()[: 64 * 3])
    doc = fitz.open()
    page, xref = page_with(doc, png(photo(seed=5)))
    doc.xref_set_key(xref, "ColorSpace", f"[/Indexed /DeviceRGB 63 <{palette.hex()}>]")
    doc.update_stream(xref, quant.tobytes(), compress=True)
    save(doc, "indexed.pdf", deflate=True)

    # CMYK JPEG: left alone.
    doc = fitz.open()
    page_with(doc, jpeg(photo((200, 150), seed=6).convert("CMYK"), 70))
    save(doc, "cmyk.pdf", deflate=True)

    # RGB photo whose colour space is an ICC profile: the profile must survive.
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    doc = fitz.open()
    page, xref = page_with(doc, png(photo(seed=7)))
    icc = doc.get_new_xref()
    doc.update_object(icc, "<< /N 3 /Alternate /DeviceRGB >>")
    doc.update_stream(icc, profile)
    doc.xref_set_key(xref, "ColorSpace", f"[/ICCBased {icc} 0 R]")
    save(doc, "icc.pdf", deflate=True)

    # The same picture on three pages: one image object, processed once.
    doc = fitz.open()
    data = png(photo(seed=8))
    first_xref = None
    for _ in range(3):
        page = doc.new_page(width=300, height=240)
        first_xref = page.insert_image(fitz.Rect(20, 20, 280, 220), stream=data, xref=first_xref or 0)
    save(doc, "shared.pdf", deflate=True)

    # Several different pictures, so the worker pool has something to do.
    doc = fitz.open()
    for i in range(6):
        page_with(doc, png(photo((240, 160), seed=10 + i)), size=(300, 220), rect=(10, 10, 290, 210))
    save(doc, "many.pdf", deflate=True)

    # No pictures, content stream and fonts stored uncompressed: only the
    # structural clean-up can shrink it.
    doc = fitz.open()
    for p in range(3):
        page = doc.new_page()
        for line in range(40):
            page.insert_text((50, 60 + 16 * line), f"Page {p + 1} line {line + 1}: the quick brown fox", fontsize=11)
    save(doc, "text-plain.pdf", deflate=False, garbage=0)

    # Already as small as it gets: a tiny text page, compressed and cleaned.
    doc = fitz.open()
    doc.new_page().insert_text((72, 72), "Hello", fontsize=12)
    save(doc, "tiny.pdf", deflate=True, garbage=4, clean=True)

    # Encrypted (open password).
    doc = fitz.open()
    page_with(doc, png(photo(seed=9)))
    save(doc, "encrypted.pdf", encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")

    # Not a PDF at all.
    (OUT / "not-a-pdf.pdf").write_bytes(b"this is not a pdf\n" * 20)


if __name__ == "__main__":
    build()
    for f in sorted(OUT.glob("*.pdf")):
        print(f"{f.name:20s} {f.stat().st_size:8d}")
