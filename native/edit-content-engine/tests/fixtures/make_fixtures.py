"""Builds the binary fixtures used by edge_case_corpus.rs.

two-same-name-fonts.pdf:

Page 1: two embedded TrueType subsets (DejaVu Sans and DejaVu Serif) that both
carry the name ArialMT, like the fonts Quartz writes into one document.
Page 2: Helvetica text ("gamma"), the object the test edits.

icc-colored-text.pdf: text painted with ICCBased colours (`/Cs1 cs ... sc`) as Quartz writes them.

Needs fontTools, pypdf and Pillow; run: python make_fixtures.py
"""

import io
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, StreamObject

FONTS = Path("/usr/share/fonts/truetype/dejavu")
OUT = Path(__file__).with_name("two-same-name-fonts.pdf")
ICC_OUT = Path(__file__).with_name("icc-colored-text.pdf")


def subset_named_arialmt(path, text):
    options = subset.Options()
    options.layout_features = []
    options.name_IDs = [1, 2, 3, 4, 6]
    options.notdef_outline = True
    options.glyph_names = False
    options.hinting = False
    font = TTFont(path)
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    for record in font["name"].names:
        if record.nameID in (1, 3, 4, 6, 16):
            record.string = "ArialMT"
    out = io.BytesIO()
    font.save(out)
    return out.getvalue(), font


def build_two_same_name_fonts():
    writer = PdfWriter()
    page1 = writer.add_blank_page(300, 200)
    page2 = writer.add_blank_page(300, 200)
    name = NameObject
    num = NumberObject

    def truetype(path, text):
        data, font = subset_named_arialmt(path, text)
        program = StreamObject()
        program._data = data
        program[name("/Length1")] = num(len(data))
        hmtx, cmap, upm = font["hmtx"], font.getBestCmap(), font["head"].unitsPerEm
        widths = ArrayObject(
            [num(round(hmtx[cmap[c]][0] * 1000 / upm)) if c in cmap else num(0) for c in range(32, 127)]
        )
        descriptor = DictionaryObject({
            name("/Type"): name("/FontDescriptor"), name("/FontName"): name("/ABCDEF+ArialMT"),
            name("/Flags"): num(32),
            name("/FontBBox"): ArrayObject([num(-200), num(-250), num(1200), num(950)]),
            name("/ItalicAngle"): num(0), name("/Ascent"): num(900), name("/Descent"): num(-200),
            name("/CapHeight"): num(700), name("/StemV"): num(80),
            name("/FontFile2"): writer._add_object(program),
        })
        return writer._add_object(DictionaryObject({
            name("/Type"): name("/Font"), name("/Subtype"): name("/TrueType"),
            name("/BaseFont"): name("/ABCDEF+ArialMT"), name("/FirstChar"): num(32),
            name("/LastChar"): num(126), name("/Widths"): widths,
            name("/Encoding"): name("/WinAnsiEncoding"),
            name("/FontDescriptor"): writer._add_object(descriptor),
        }))

    sans = truetype(FONTS / "DejaVuSans.ttf", "alpha")
    serif = truetype(FONTS / "DejaVuSerif.ttf", "beta")
    helvetica = writer._add_object(DictionaryObject({
        name("/Type"): name("/Font"), name("/Subtype"): name("/Type1"),
        name("/BaseFont"): name("/Helvetica"), name("/Encoding"): name("/WinAnsiEncoding"),
    }))
    page1[name("/Resources")] = DictionaryObject(
        {name("/Font"): DictionaryObject({name("/F1"): sans, name("/F2"): serif})})
    page2[name("/Resources")] = DictionaryObject({name("/Font"): DictionaryObject({name("/F3"): helvetica})})
    for page, text in ((page1, b"BT /F1 14 Tf 30 150 Td (alpha) Tj ET BT /F2 14 Tf 30 100 Td (beta) Tj ET"),
                       (page2, b"BT /F3 14 Tf 30 100 Td (gamma) Tj ET")):
        content = StreamObject()
        content._data = text
        page[name("/Contents")] = writer._add_object(content)
    with OUT.open("wb") as handle:
        writer.write(handle)


def build_icc_colored_text():
    from PIL import ImageCms

    writer = PdfWriter()
    page = writer.add_blank_page(300, 200)
    name = NameObject
    profile = StreamObject()
    profile._data = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    profile[name("/N")] = NumberObject(3)
    cs1 = ArrayObject([name("/ICCBased"), writer._add_object(profile)])
    helvetica = writer._add_object(DictionaryObject({
        name("/Type"): name("/Font"), name("/Subtype"): name("/Type1"),
        name("/BaseFont"): name("/Helvetica"), name("/Encoding"): name("/WinAnsiEncoding"),
    }))
    page[name("/Resources")] = DictionaryObject({
        name("/Font"): DictionaryObject({name("/F1"): helvetica}),
        name("/ColorSpace"): DictionaryObject({name("/Cs1"): cs1}),
    })
    content = StreamObject()
    content._data = (b"/Cs1 cs 0.3255 0.5059 0.2078 sc BT /F1 12 Tf 30 150 Td (green) Tj ET "
                     b"/Cs1 cs 0 0 0 sc BT /F1 12 Tf 30 100 Td (word) Tj ET")
    page[name("/Contents")] = writer._add_object(content)
    with ICC_OUT.open("wb") as handle:
        writer.write(handle)


if __name__ == "__main__":
    build_two_same_name_fonts()
    build_icc_colored_text()
