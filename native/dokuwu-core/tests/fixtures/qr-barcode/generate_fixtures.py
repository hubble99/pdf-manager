"""Writes reference.json for tests/qr_barcode.rs from the libraries the Python
sidecar used (python-barcode and qrcode), so the Rust encoders can be compared
with them. Run once, from this folder:

    pip install python-barcode qrcode pillow
    python generate_fixtures.py

The output is committed; the test does not need Python.
"""
import io
import json
import qrcode
import barcode
from barcode.writer import ImageWriter
from PIL import Image

BARCODES = [
    ("code128", "Dokuwu-2026"),
    ("code128", "1234567890"),
    ("code128", "abc123"),
    ("code128", "Hello World"),
    ("code128", "A"),
    ("code128", "12345"),
    ("code128", "ABC-1234-xyz"),
    ("ean13", "590123412345"),
    ("ean13", "400638133393"),
    ("ean13", "000000000000"),
    ("ean8", "9638507"),
    ("ean8", "5512345"),
    ("code39", "HELLO-1"),
    ("code39", "hello"),
    ("code39", "CODE 39 $/+%.-"),
    ("code39", "0123456789"),
]

QRS = [
    ("https://example.com", "M"),
    ("https://example.com", "L"),
    ("https://example.com", "H"),
    ("hello", "Q"),
    ("Dokuwu 2026", "M"),
    ("1234567890", "M"),
    ("HELLO WORLD", "L"),
    ("x" * 120, "M"),
    ("https://sbp.badanpangan.go.id/some/long/path?with=query&and=more#anchor", "H"),
]


def barcode_case(kind, content):
    bc = barcode.get_barcode_class(kind)(content, writer=ImageWriter())
    buf = io.BytesIO()
    bc.write(buf)
    buf.seek(0)
    width, height = Image.open(buf).size
    return {
        "type": kind,
        "content": content,
        "text": bc.get_fullcode(),
        "modules": bc.build()[0],
        "png_size": [width, height],
    }


def qr_case(content, level):
    level_const = getattr(qrcode.constants, f"ERROR_CORRECT_{level}")
    qr = qrcode.QRCode(version=None, error_correction=level_const, box_size=10, border=4)
    qr.add_data(content)
    qr.make(fit=True)
    return {
        "content": content,
        "level": level,
        "version": qr.version,
        "matrix": ["".join("1" if cell else "0" for cell in row) for row in qr.get_matrix()[4:-4]],
    }


# get_matrix includes the border; strip the 4 rows above/below and 4 columns each side.
def strip_columns(case):
    case["matrix"] = [row[4:-4] for row in case["matrix"]]
    return case


data = {
    "barcodes": [barcode_case(k, c) for k, c in BARCODES],
    "qr": [strip_columns(qr_case(c, l)) for c, l in QRS],
}
with open("reference.json", "w") as f:
    json.dump(data, f, indent=1)
print(len(data["barcodes"]), "barcodes,", len(data["qr"]), "qr codes")
