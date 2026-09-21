"""Uniform backdrop proof: real frozen transactions and adversarial dependencies."""
import io
import os

import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject,
    DictionaryObject, FloatObject, NameObject, NumberObject)
from tests.test_edit_content_empty_paint import fixture as text_fixture


def fixture(variant='safe', font_variant='safe'):
    writer = PdfWriter()
    writer.clone_document_from_reader(PdfReader(io.BytesIO(text_fixture(font_variant))))
    page = writer.pages[0]
    resources = page['/Resources']
    def stream(data, entries):
        obj = DecodedStreamObject(); obj.set_data(data)
        obj.update({NameObject(k): v for k, v in entries.items()})
        return writer._add_object(obj)
    common = {'/Type': NameObject('/XObject'), '/Subtype': NameObject('/Image'),
        '/Width': NumberObject(2), '/Height': NumberObject(2),
        '/BitsPerComponent': NumberObject(8), '/Interpolate': BooleanObject(False)}
    mask = stream(b'\0\0\0' + (b'\xff' if variant == 'painted-mask' else b'\0'),
        {**common, '/ColorSpace': NameObject('/DeviceGray'),
         '/Matte': ArrayObject([NumberObject(0)] * 3)})
    if variant == 'inverted-mask':
        mask.get_object()[NameObject('/Decode')] = ArrayObject([NumberObject(1), NumberObject(0)])
    image = stream(b'\x42' * 12, {**common, '/ColorSpace': NameObject('/DeviceRGB'), '/SMask': mask})
    if variant == 'unknown-image':
        image.get_object()[NameObject('/SMaskInData')] = NumberObject(1)
    resources[NameObject('/XObject')] = DictionaryObject({NameObject('/I'): image})
    group = DictionaryObject({NameObject('/Type'): NameObject('/Group'),
        NameObject('/S'): NameObject('/Transparency'), NameObject('/CS'): NameObject('/DeviceRGB')})
    if variant == 'knockout': group[NameObject('/K')] = BooleanObject(True)
    if variant == 'isolated': group[NameObject('/I')] = BooleanObject(True)
    page[NameObject('/Group')] = group
    annot = DictionaryObject({NameObject('/Subtype'): NameObject('/Link'),
        NameObject('/Rect'): ArrayObject([NumberObject(x) for x in (10,10,20,20)]),
        NameObject('/BS'): DictionaryObject({NameObject('/W'): NumberObject(0)}),
        NameObject('/F'): NumberObject(4)})
    if variant == 'annotation-overlap':
        annot[NameObject('/Rect')] = ArrayObject([NumberObject(x) for x in (25,95,70,115)])
    if variant == 'annotation-appearance':
        annot[NameObject('/AP')] = DictionaryObject()
    page[NameObject('/Annots')] = ArrayObject([writer._add_object(annot)])
    text = page.get_contents().get_data()
    rect = b'/P <</MCID 5>> BDC q 1 1 1 rg 10 80 170 50 re f Q EMC\n'
    if variant == 'boundary': rect = rect.replace(b'170 50', b'37 50')
    if variant == 'clipped':
        # A rectangle identical to the fill is a redundant clip that PDFium
        # removes. A triangular clip retains genuine native clip dependence.
        rect = rect.replace(b'1 1 1 rg', b'10 80 m 180 80 l 10 130 l h W n 1 1 1 rg')
    if variant == 'translucent':
        resources[NameObject('/ExtGState')] = DictionaryObject({NameObject('/A'):
            DictionaryObject({NameObject('/ca'): FloatObject(0.5)})})
        rect = rect.replace(b'1 1 1 rg', b'/A gs 1 1 1 rg')
    img = b'/P <</MCID 6>> BDC q 120 0 0 40 15 85 cm /I Do Q EMC\n'
    contents = (text + rect + img if variant == 'foreground' else rect + img + text)
    if variant == 'mixed-foreground':
        contents += b'/P <</MCID 7>> BDC q 0 0 0 rg 48 99 3 12 re f Q EMC\n'
    page[NameObject('/Contents')] = stream(contents, {})
    output = io.BytesIO(); writer.write(output); return output.getvalue()


@pytest.mark.skipif(not os.environ.get('EDIT_CONTENT_TEST_SIDECAR'), reason='selected frozen sidecar required')
@pytest.mark.parametrize('variant', ['safe', 'painted-mask', 'inverted-mask', 'unknown-image',
    'knockout', 'isolated', 'annotation-overlap', 'annotation-appearance', 'boundary',
    'clipped', 'translucent', 'foreground', 'mixed-foreground'])
def test_frozen_uniform_backdrop(tmp_path, variant):
    from tests.test_edit_content_packaged_transactions import PackagedBackend
    backend = PackagedBackend(tmp_path / 'runtime').start()
    try:
        sid = backend.open(fixture(variant))['sessionId']
        targets = backend.command(sid, 'inspect', 0)['result']['discovery']['textObjects']
        target = next(o for o in targets if o['text'] == 'AA')
        before = backend.record(sid).read_bytes()
        reply = backend.command(sid, 'save', 0, {'draft': {'expectedText': 'AA',
            'expectedOldText': 'AA', 'replacementText': 'AAA', 'utf16Start': 0, 'utf16End': 2}}, target['targetId'])
        if variant == 'safe':
            assert reply['status'] == 'accepted', reply
            assert 'AAA' in PdfReader(io.BytesIO(backend.download(sid, reply['result']['outputId']))).pages[0].extract_text()
        else:
            assert reply['status'] == 'rejected', reply
            assert backend.record(sid).read_bytes() == before
    finally:
        backend.stop()


@pytest.mark.parametrize('variant,expected', [('safe',True),('knockout',False),
    ('isolated',False),('annotation-appearance',False),('painted-mask',True),
    ('inverted-mask',True),('unknown-image',True)])
def test_bounded_dependency_context(variant, expected):
    from features.edit_content.backdrop import backdrop_context
    from features.edit_content.preservation import optional_proof
    page=PdfReader(io.BytesIO(fixture(variant))).pages[0]
    proof=optional_proof(lambda r:backdrop_context(page,r),page['/Resources'])
    assert (proof is not None) is expected
    if proof is not None:
        assert bool(proof['zeroMaskImages']) is (variant=='safe')


@pytest.mark.skipif(not os.environ.get('EDIT_CONTENT_TEST_SIDECAR'), reason='selected frozen sidecar required')
@pytest.mark.parametrize('replacement,font_variant,accepted',[
    ('AA ','safe',True),('AAA ','safe',False),('AA  ','safe',False),
    ('AA ','painted-space',False),('AA ','lying-space-bounds',False),
    ('AA ','conflicting-cmap',False),('AA ','duplicate-slot',False)])
def test_frozen_empty_advance_on_translucent_content(tmp_path,replacement,font_variant,accepted):
    from tests.test_edit_content_packaged_transactions import PackagedBackend
    backend=PackagedBackend(tmp_path/'runtime').start()
    try:
        sid=backend.open(fixture('translucent',font_variant))['sessionId']
        # Some font variants append an extraction-generated separator. Select
        # the known synthetic object and replace its complete native text, just
        # as in the real footer, without stripping or guessing the edit range.
        target=next(o for o in backend.command(sid,'inspect',0)['result']['discovery']['textObjects']
            if o['sourceScope']['objectPath']==[2])
        assert target['text'] in ('AA','AA ')
        before=backend.record(sid).read_bytes()
        reply=backend.command(sid,'save',0,{'draft':{'expectedText':target['text'],'expectedOldText':target['text'],
            'replacementText':replacement,'utf16Start':0,'utf16End':len(target['text'])}},target['targetId'])
        assert (reply['status']=='accepted') is accepted,reply
        if not accepted: assert backend.record(sid).read_bytes()==before
    finally:
        backend.stop()
