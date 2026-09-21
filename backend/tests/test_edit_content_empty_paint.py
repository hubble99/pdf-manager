"""Empty paint is an exact glyph/slot proof, never an empty-text exemption."""
import io
import json
import os

import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject,
    NameObject, NumberObject)
from features.edit_content.empty_paint import empty_winansi_space, text_paint_slots


def fixture(variant='safe'):
    builder = FontBuilder(1000, isTTF=True)
    order = ['.notdef', 'blank', 'letterA', 'letterB']
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap({32: 'blank', 65: 'letterA', 66: 'letterB'})
    glyphs = {}
    for name in order:
        pen = TTGlyphPen(None)
        if name != 'blank' or variant in ('painted-space','lying-space-bounds'):
            pen.moveTo((0, 0)); pen.lineTo((500, 0)); pen.lineTo((500, 700)); pen.lineTo((0, 700)); pen.closePath()
        glyphs[name] = pen.glyph()
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({g: (600, 0) for g in order})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({'familyName':'ProofFixture','styleName':'Regular','psName':'ProofFixture'})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    if variant in ('variable-empty','variable-painted'):
        from fontTools.ttLib.tables.TupleVariation import TupleVariation
        builder.setupFvar([('wdth',75,100,125,'Width')],[])
        coordinates=[(0,0),(-138,0),(0,0),(0,0)]
        if variant=='variable-painted':
            builder.font['glyf']['blank']=builder.font['glyf']['letterB']
            coordinates=[(0,0)]*4+coordinates
        builder.setupGvar({'blank':[TupleVariation({'wdth':(-1,-1,0)},coordinates)]})
    if variant == 'lying-space-bounds':
        glyph = builder.font['glyf']['blank']
        glyph.xMin = glyph.yMin = glyph.xMax = glyph.yMax = 0
        builder.font.recalcBBoxes = False
    if variant == 'conflicting-cmap':
        builder.font['cmap'].tables[0].cmap = {**builder.font['cmap'].tables[0].cmap, 32:'letterB'}
    stream = io.BytesIO(); builder.save(stream)
    writer = PdfWriter(); page = writer.add_blank_page(width=200, height=200)
    def indirect(data):
        obj = DecodedStreamObject(); obj.set_data(data); return writer._add_object(obj)
    desc = DictionaryObject({NameObject('/Type'):NameObject('/FontDescriptor'),
        NameObject('/FontName'):NameObject('/ProofFixture'), NameObject('/Flags'):NumberObject(32),
        NameObject('/FontBBox'):ArrayObject([NumberObject(x) for x in (0,-200,600,800)]),
        NameObject('/ItalicAngle'):NumberObject(0),NameObject('/Ascent'):NumberObject(800),
        NameObject('/Descent'):NumberObject(-200),NameObject('/CapHeight'):NumberObject(700),
        NameObject('/StemV'):NumberObject(80),NameObject('/FontFile2'):indirect(stream.getvalue())})
    font = DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/TrueType'),
        NameObject('/BaseFont'):NameObject('/ProofFixture'),NameObject('/Encoding'):NameObject('/WinAnsiEncoding'),
        NameObject('/FirstChar'):NumberObject(32),NameObject('/LastChar'):NumberObject(66),
        NameObject('/Widths'):ArrayObject([NumberObject(600)]*35),NameObject('/FontDescriptor'):writer._add_object(desc)})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/A'):writer._add_object(font)})})
    contents = b'/P <</MCID 1>> BDC BT /A 12 Tf 1 0 0 1 30 100 Tm (AA) Tj ET\n'
    space = b'BT /A 12 Tf 1 0 0 1 45 100 Tm ( ) Tj ET\n'
    if variant == 'visible-neighbor': space = space.replace(b'( )', b'(B)')
    if variant == 'clip-mode': space = space.replace(b'( )', b'7 Tr ( )')
    contents += space + (space if variant == 'duplicate-slot' else b'') + b'EMC\n'
    page[NameObject('/Contents')] = indirect(contents)
    out = io.BytesIO(); writer.write(out); return out.getvalue()


def test_exact_empty_outline_is_required():
    for variant, expected in [('safe',True),('painted-space',False),('lying-space-bounds',False),('conflicting-cmap',False),('variable-empty',True),('variable-painted',False)]:
        page = PdfReader(io.BytesIO(fixture(variant))).pages[0]
        assert empty_winansi_space(page['/Resources']['/Font']['/A']) is expected


def test_exact_operand_and_nonclipping_mode_are_required():
    for variant, expected in [('safe',True),('visible-neighbor',False),('clip-mode',False)]:
        page = PdfReader(io.BytesIO(fixture(variant))).pages[0]
        slots = text_paint_slots(page,page['/Resources'])
        assert slots[0]['emptyPaint'] is False
        assert slots[1]['emptyPaint'] is expected


def test_unreadable_optional_glyph_proof_never_authorizes_paint_exception(monkeypatch):
    import features.edit_content.empty_paint as proof
    def unavailable(_): raise ValueError('malformed variation data')
    monkeypatch.setattr(proof,'empty_winansi_space',unavailable)
    page=PdfReader(io.BytesIO(fixture())).pages[0]
    slots=proof.text_paint_slots(page,page['/Resources'])
    assert len(slots)==2
    assert all(not s['emptyPaint'] and s['asciiCodes'] is None for s in slots)


@pytest.mark.skipif(not os.environ.get('EDIT_CONTENT_TEST_SIDECAR'),reason='selected frozen sidecar required')
@pytest.mark.parametrize('variant',['safe','variable-empty','variable-painted','painted-space','lying-space-bounds','conflicting-cmap','visible-neighbor','clip-mode','duplicate-slot'])
def test_frozen_empty_glyph_layout_proof(tmp_path,variant):
    from tests.test_edit_content_packaged_transactions import PackagedBackend
    backend = PackagedBackend(tmp_path/'runtime').start()
    try:
        sid = backend.open(fixture(variant))['sessionId']
        target = backend.command(sid,'inspect',0)['result']['discovery']['textObjects'][0]
        before = backend.record(sid).read_bytes()
        reply = backend.command(sid,'save',0,{'draft':{'expectedText':target['text'],
            'expectedOldText':'AA','replacementText':'AAA','utf16Start':0,'utf16End':2}},target['targetId'])
        if variant in ('safe','variable-empty'):
            assert reply['status'] == 'accepted',reply
            result = backend.download(sid,reply['result']['outputId'])
            assert 'AAA' in PdfReader(io.BytesIO(result)).pages[0].extract_text()
        else:
            assert reply['status'] == 'rejected',reply
            assert backend.record(sid).read_bytes() == before
    finally:
        backend.stop()
