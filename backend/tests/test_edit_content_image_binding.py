"""Exact masked-image resource binding; synthetic fixtures only."""
import io
import json
import os

import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject

from features.edit_content.resource_inspector import ReadOnlyResourceInspector
from features.edit_content.transaction_state import REQUIRED_CHECKS


def image_pdf(*, duplicate_pixels=False, inline=False, form=False, swap_masks=False):
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    images, masks = [], []
    for alpha in (255, 100):
        mask = DecodedStreamObject()
        mask.set_data(bytes([alpha]))
        mask.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
            NameObject('/Width'): NumberObject(1), NameObject('/Height'): NumberObject(1),
            NameObject('/BitsPerComponent'): NumberObject(8), NameObject('/ColorSpace'): NameObject('/DeviceGray')})
        masks.append(writer._add_object(mask))
    for i, pixels in enumerate((b'\xff\x00\x00', b'\xff\x00\x00' if duplicate_pixels else b'\x00\x00\xff')):
        image = DecodedStreamObject()
        image.set_data(pixels)
        image.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
            NameObject('/Width'): NumberObject(1), NameObject('/Height'): NumberObject(1),
            NameObject('/BitsPerComponent'): NumberObject(8), NameObject('/ColorSpace'): NameObject('/DeviceRGB'),
            NameObject('/SMask'): masks[1 - i if swap_masks else i]})
        images.append(writer._add_object(image))
    font = writer._add_object(DictionaryObject({NameObject('/Type'): NameObject('/Font'),
        NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica'),
        NameObject('/Encoding'): NameObject('/WinAnsiEncoding')}))
    xobjects = DictionaryObject({NameObject('/Im0'): images[0], NameObject('/Im1'): images[1]})
    if form:
        nested = DecodedStreamObject()
        nested.set_data(b'')
        nested[NameObject('/Subtype')] = NameObject('/Form')
        xobjects[NameObject('/Opaque')] = writer._add_object(nested)
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'): xobjects,
        NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
    contents = DecodedStreamObject()
    contents.set_data(b'BT /F1 12 Tf 30 150 Td (word) Tj ET\n'
        b'q 10 0 0 10 20 20 cm /Im0 Do Q q 10 0 0 10 80 20 cm /Im1 Do Q\n' +
        (b'BI /W 1 /H 1 /BPC 8 /CS /RGB ID abc EI\n' if inline else b''))
    page[NameObject('/Contents')] = writer._add_object(contents)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def inspect(tmp_path, **kwargs):
    path = tmp_path / 'images.pdf'
    path.write_bytes(image_pdf(**kwargs))
    return ReadOnlyResourceInspector().inspect(path).to_payload()['pages'][0]


def test_unique_image_streams_bind_complete_masked_resource_identities(tmp_path):
    page = inspect(tmp_path)
    bindings = page['imageResourceBindings']
    assert len(bindings) == 2
    assert len({v['rawSha256'] for v in bindings}) == 2
    assert sorted(v['semanticSha256'] for v in bindings) == page['preservationResources']['/XObject']
    changed = inspect(tmp_path, swap_masks=True)
    assert {v['rawSha256'] for v in bindings} == {v['rawSha256'] for v in changed['imageResourceBindings']}
    assert {v['rawSha256']: v['semanticSha256'] for v in bindings} != {
        v['rawSha256']: v['semanticSha256'] for v in changed['imageResourceBindings']}


@pytest.mark.parametrize('options', [{'duplicate_pixels': True}, {'inline': True}, {'form': True}])
def test_ambiguous_inline_and_opaque_images_have_no_binding_proof(tmp_path, options):
    assert inspect(tmp_path, **options)['imageResourceBindings'] is None


@pytest.mark.skipif(not os.environ.get('EDIT_CONTENT_TEST_SIDECAR'), reason='requires selected frozen sidecar')
@pytest.mark.parametrize('duplicate_pixels', [False, True])
def test_packaged_unique_masked_images_accept_but_ambiguous_masks_reject(tmp_path, duplicate_pixels):
    from tests.test_edit_content_packaged_transactions import PackagedBackend, EDIT
    backend = PackagedBackend(tmp_path / 'runtime').start()
    try:
        session = backend.open(image_pdf(duplicate_pixels=duplicate_pixels))['sessionId']
        target = backend.command(session, 'inspect', 0)['result']['discovery']['textObjects'][0]
        before = backend.record(session).read_bytes()
        reply = backend.command(session, 'save', 0, {'draft': EDIT}, target['targetId'])
        if duplicate_pixels:
            assert reply['status'] == 'rejected', reply
            assert before == backend.record(session).read_bytes()
        else:
            assert reply['status'] == 'accepted', reply
            state = json.loads(backend.record(session).read_bytes())['state']
            assert set(state['checkpoints'][-1]['edit']['checks']) == REQUIRED_CHECKS
            source, output = tmp_path / 'source.pdf', tmp_path / 'accepted.pdf'
            source.write_bytes(image_pdf())
            output.write_bytes(backend.download(session, reply['result']['outputId']))
            inspector = ReadOnlyResourceInspector()
            a, b = (inspector.inspect(p).to_payload()['pages'][0] for p in (source, output))
            assert a['preservationResources'] == b['preservationResources']
            # PDFium recompresses these streams. Raw hashes are per-file
            # binding keys, not preservation identities across serialization.
            assert sorted(v['semanticSha256'] for v in a['imageResourceBindings']) == sorted(
                v['semanticSha256'] for v in b['imageResourceBindings'])
            assert PdfReader(output).pages[0].extract_text().strip() == 'text'
    finally:
        backend.stop()
