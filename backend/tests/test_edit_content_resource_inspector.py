import io
import hashlib
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NullObject,
    NumberObject,
    TextStringObject,
)

from features.edit_content.resource_inspector import (
    ReadOnlyResourceInspector,
    _codepoint_ranges,
    _font_cmap_codepoints,
)


def _stream(writer: PdfWriter, data: bytes):
    stream = DecodedStreamObject()
    stream.set_data(data)
    return writer._add_object(stream)


def _embedded_subset_font() -> bytes:
    builder = FontBuilder(1000, isTTF=True)
    glyph_order = [".notdef", "A"]
    builder.setupGlyphOrder(glyph_order)
    builder.setupCharacterMap({65: "A"})
    glyphs = {}
    for name in glyph_order:
        pen = TTGlyphPen(None)
        glyphs[name] = pen.glyph()
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({name: (600, 0) for name in glyph_order})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupOS2(
        sTypoAscender=800,
        sTypoDescender=-200,
        usWinAscent=800,
        usWinDescent=200,
    )
    builder.setupNameTable(
        {
            "familyName": "SubsetFixture",
            "styleName": "Regular",
            "uniqueFontIdentifier": "SubsetFixture-Regular",
            "fullName": "SubsetFixture Regular",
            "psName": "SubsetFixture-Regular",
        }
    )
    builder.setupPost()
    builder.setupMaxp()
    output = io.BytesIO()
    builder.save(output)
    return output.getvalue()


def _font_fixture(path: Path) -> dict[str, bytes]:
    writer = PdfWriter()
    pages = [writer.add_blank_page(width=200, height=200) for _ in range(2)]
    to_unicode = b"/CIDInit /ProcSet findresource begin\nend"
    font_program = b"fixture-font-program"
    cid_map = b"\x00\x00\x00\x01"

    descriptor = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/FontDescriptor"),
            NameObject("/FontName"): NameObject("/ABCDEF+SharedSans"),
            NameObject("/FontFile2"): _stream(writer, font_program),
        }
    )
    descriptor_ref = writer._add_object(descriptor)
    descendant = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/CIDFontType2"),
            NameObject("/BaseFont"): NameObject("/ABCDEF+SharedSans"),
            NameObject("/FontDescriptor"): descriptor_ref,
            NameObject("/DW"): NumberObject(1000),
            NameObject("/W"): ArrayObject(
                [NumberObject(1), ArrayObject([NumberObject(500), NumberObject(510)])]
            ),
            NameObject("/CIDToGIDMap"): _stream(writer, cid_map),
            NameObject("/CIDSystemInfo"): DictionaryObject(
                {
                    NameObject("/Registry"): TextStringObject("Adobe"),
                    NameObject("/Ordering"): TextStringObject("Identity"),
                    NameObject("/Supplement"): NumberObject(0),
                }
            ),
        }
    )
    descendant_ref = writer._add_object(descendant)
    type_zero = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type0"),
            NameObject("/BaseFont"): NameObject("/ABCDEF+SharedSans"),
            NameObject("/Encoding"): NameObject("/Identity-H"),
            NameObject("/ToUnicode"): _stream(writer, to_unicode),
            NameObject("/DescendantFonts"): ArrayObject([descendant_ref]),
        }
    )
    type_zero_ref = writer._add_object(type_zero)

    form_font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
            NameObject("/Encoding"): DictionaryObject(
                {
                    NameObject("/BaseEncoding"): NameObject("/WinAnsiEncoding"),
                    NameObject("/Differences"): ArrayObject(
                        [NumberObject(65), NameObject("/A")]
                    ),
                }
            ),
            NameObject("/FirstChar"): NumberObject(32),
            NameObject("/LastChar"): NumberObject(65),
            NameObject("/Widths"): ArrayObject([NumberObject(500)]),
        }
    )
    form_font_ref = writer._add_object(form_font)
    form_resources = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Font"): DictionaryObject(
                    {NameObject("/Nested"): form_font_ref}
                )
            }
        )
    )
    form = DecodedStreamObject()
    form.set_data(b"")
    form.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Form"),
            NameObject("/BBox"): ArrayObject(
                [NumberObject(0), NumberObject(0), NumberObject(10), NumberObject(10)]
            ),
            NameObject("/Resources"): form_resources,
        }
    )
    form_ref = writer._add_object(form)

    shared_resources = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Font"): DictionaryObject(
                    {NameObject("/FShared"): type_zero_ref}
                ),
                NameObject("/XObject"): DictionaryObject(
                    {NameObject("/FormA"): form_ref}
                ),
            }
        )
    )
    pages_root = writer._root_object["/Pages"].get_object()
    pages_root[NameObject("/Resources")] = shared_resources
    for page in pages:
        page.pop(NameObject("/Resources"), None)
    writer.write(path)
    return {"to_unicode": to_unicode, "font_program": font_program, "cid_map": cid_map}


def test_inspector_walks_inherited_shared_and_descendant_resources(tmp_path):
    source = tmp_path / "font-scope.pdf"
    expected = _font_fixture(source)

    report = ReadOnlyResourceInspector().inspect(source)
    assert report.supported is True
    payload = report.to_payload()
    assert payload["schemaVersion"] == "edit-content-resource-inspection/v1"
    assert len(payload["pages"]) == 2
    assert payload["pages"][0]["inheritedResourcesFrom"] is not None
    assert payload["pages"][0]["inheritedResourcesFrom"] == payload["pages"][1]["inheritedResourcesFrom"]
    assert payload["sharedResources"]
    assert payload["sharedResources"][0]["pageIndexes"] == [0, 1]

    page_fonts = payload["pages"][0]["fonts"]
    top = next(font for font in page_fonts if font["resourceName"] == "/FShared")
    assert top["effectiveBaseFont"] == "SharedSans"
    assert top["collisionEffectiveBaseFont"] == "ABCDEF+SharedSans"
    assert len(top["encoding"]["sha256"]) == 64
    assert top["toUnicode"]["sha256"] == hashlib.sha256(expected["to_unicode"]).hexdigest()
    descendant = top["descendants"][0]
    assert descendant["subtype"] == "/CIDFontType2"
    assert descendant["collisionEffectiveBaseFont"] == "ABCDEF+SharedSans"
    assert descendant["glyphCoverage"]["status"] == "unknown"
    assert descendant["glyphCoverage"]["fontProgramSha256"] == hashlib.sha256(
        expected["font_program"]
    ).hexdigest()
    assert descendant["widths"]["detail"]["DW"] == 1000
    assert len(descendant["widths"]["sha256"]) == 64
    assert descendant["cidToGidMap"]["sha256"] == hashlib.sha256(expected["cid_map"]).hexdigest()
    assert descendant["cidSystemInfo"]["/Ordering"] == "Identity"
    assert descendant["fontPrograms"][0]["sha256"] == hashlib.sha256(expected["font_program"]).hexdigest()

    nested = next(font for font in page_fonts if font["resourceName"] == "/Nested")
    assert nested["scope"] == "page/XObject:/FormA"
    assert len(nested["encoding"]["sha256"]) == 64
    assert nested["collisionEffectiveBaseFont"] == "Helvetica"
    assert nested["glyphCoverage"]["status"] == "proven"
    assert nested["glyphCoverage"]["source"] == "standard-font-encoding"
    assert any(start <= 65 <= end for start, end in nested["glyphCoverage"]["ranges"])


def test_inspector_fails_closed_for_unresolvable_font_dictionary(tmp_path):
    source = tmp_path / "unsupported.pdf"
    writer = PdfWriter()
    page = writer.add_blank_page(width=100, height=100)
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject(
                {NameObject("/Broken"): NullObject()}
            )
        }
    )
    writer.write(source)

    payload = ReadOnlyResourceInspector().inspect(source).to_payload()
    assert payload == {
        "schemaVersion": "edit-content-resource-inspection/v1",
        "supported": False,
        "guardReason": "REJECTED_UNSUPPORTED_STRUCTURE",
        "error": "resource inspection is unavailable for this document",
    }
    assert str(source) not in str(payload)


def test_embedded_subset_cmap_proves_only_glyphs_present_in_exact_program():
    points = _font_cmap_codepoints(_embedded_subset_font())

    assert points == {65}
    assert _codepoint_ranges(points) == [[65, 65]]
    assert ord("ő") not in points
