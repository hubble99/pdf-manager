"""Synthetic read-only ownership proof tests; no corpus data."""
import io
import json
import os

import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, FloatObject, NameObject
from features.edit_content.marked_content import marked_content_proof
from features.edit_content.preservation import UnprovenPreservation
from features.edit_content.preservation import semantic_hash


def marked_pdf(extra=b'', *, alpha=0.78431, mixed=False, same_name=False):
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    fonts = DictionaryObject()
    for alias, base in (('/A', '/Helvetica'), ('/B', '/Helvetica' if same_name else '/Courier')):
        fonts[NameObject(alias)] = writer._add_object(DictionaryObject({
            NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
            NameObject('/BaseFont'): NameObject(base), NameObject('/Encoding'): NameObject('/WinAnsiEncoding')}))
    gs = DictionaryObject({NameObject('/ca'): FloatObject(alpha), NameObject('/BM'): NameObject('/Normal')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): fonts,
        NameObject('/ExtGState'): DictionaryObject({NameObject('/G'): writer._add_object(gs)})})
    contents = DecodedStreamObject()
    contents.set_data(b'/P <</MCID 10>> BDC BT /A 12 Tf 30 150 Td (word) Tj ET EMC\n'
        b'/P <</MCID 11>> BDC BT /B 12 Tf 30 110 Td (other) Tj ET EMC\n'
        b'/Artifact <</MCID 12>> BDC q /G gs 10 10 10 10 re f Q\n' +
        (b'30 10 10 10 re f\n' if mixed else b'') + b'EMC\n' + extra)
    page[NameObject('/Contents')] = writer._add_object(contents)
    result = io.BytesIO()
    writer.write(result)
    return result.getvalue()


def inspect(data):
    page = PdfReader(io.BytesIO(data), strict=True).pages[0]
    return marked_content_proof(page, page['/Resources'])


def test_mark_groups_retain_dictionary_identity_and_exact_nondefault_state():
    proof = inspect(marked_pdf(same_name=True))
    groups = proof['groups']
    assert groups[0]['fonts'] != groups[1]['fonts']
    assert groups[2]['state'] == [0.78431, 1.0, '/Normal']
    assert proof['resources'] == {}


def test_mixed_state_group_is_not_authorized():
    assert inspect(marked_pdf(mixed=True))['groups'][2]['state'] is None


def test_passive_language_and_pagination_do_not_change_font_or_state_proof():
    source = marked_pdf()
    extra = (b'/Span <</MCID 99 /Lang (id-ID)>> BDC EMC\n'
             b'/Artifact <</Type /Pagination /Subtype /Footer /Attached [/Bottom]>> BDC EMC\n')
    assert inspect(source) == inspect(marked_pdf(extra))


def test_unpainted_font_selection_cannot_hide_failed_font_load():
    writer = PdfWriter()
    writer.clone_document_from_reader(PdfReader(io.BytesIO(marked_pdf())))
    page = writer.pages[0]
    page['/Resources']['/Font'][NameObject('/Unused')] = writer._add_object(DictionaryObject({
        NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type0')}))
    contents = page.get_contents()
    contents.set_data(contents.get_data() + b'\n/Unused 12 Tf\n')
    page[NameObject('/Contents')] = writer._add_object(contents)
    out = io.BytesIO()
    writer.write(out)
    with pytest.raises(UnprovenPreservation):
        inspect(out.getvalue())


@pytest.mark.parametrize('key,value', [('/SMask', '/None'), ('/BM', '/Multiply'),
    ('/TR', '/Identity'), ('/Font', '/A'), ('/OP', '/True')])
def test_unproven_graphics_dependencies_are_not_normalized_away(key, value):
    writer = PdfWriter()
    writer.clone_document_from_reader(PdfReader(io.BytesIO(marked_pdf())))
    writer.pages[0]['/Resources']['/ExtGState']['/G'][NameObject(key)] = NameObject(value)
    out = io.BytesIO()
    writer.write(out)
    with pytest.raises(UnprovenPreservation):
        inspect(out.getvalue())


@pytest.mark.parametrize('extra', [b'Q', b'q', b'EMC', b'BX', b'/Missing 12 Tf',
    b'/P <</MCID -1>> BDC EMC', b'/P <</MCID 10.5>> BDC EMC',
    b'/P <</MCID 1>> BDC /P <</MCID 2>> BDC EMC EMC',
    b'/P <</MCID 99 /ActualText (hidden)>> BDC EMC',
    b'/P <</MCID 99 /Lang 42>> BDC EMC', b'/OC BMC EMC',
    b'/Missing gs', b'0 0 m /P <</MCID 99>> BDC 2 2 l S EMC',
    b'BT /A 12 Tf [] TJ ET'])
def test_unsupported_or_ambiguous_grammar_fails_closed(extra):
    with pytest.raises(UnprovenPreservation):
        inspect(marked_pdf(extra))


@pytest.mark.parametrize('alpha', [-0.01, 1.01, float('inf')])
def test_invalid_alpha_fails_closed(alpha):
    with pytest.raises((UnprovenPreservation, ValueError, OverflowError)):
        inspect(marked_pdf(alpha=alpha))


@pytest.mark.skipif(not os.environ.get('EDIT_CONTENT_TEST_SIDECAR'), reason='requires selected frozen sidecar')
@pytest.mark.parametrize('variant', ['safe', 'marked-duplicates', 'duplicate-mark', 'disjoint-space', 'opaque-mark', 'mixed', 'ambiguous', 'collision'])
def test_packaged_marked_ownership_and_state(tmp_path, variant):
    from tests.test_edit_content_packaged_transactions import PackagedBackend, EDIT
    from features.edit_content.transaction_state import REQUIRED_CHECKS
    extra = b''
    if variant in ('marked-duplicates', 'duplicate-mark'):
        extra = (b'/P <</MCID 15>> BDC BT /B 12 Tf 100 50 Td ( ) Tj ET EMC\n'
                 b'/P <</MCID 16>> BDC BT /B 12 Tf 100 50 Td ( ) Tj ET EMC\n')
        if variant == 'duplicate-mark':
            extra = extra.replace(b'/MCID 16', b'/MCID 15')
    if variant == 'disjoint-space':
        extra = b'/P <</MCID 15>> BDC BT /B 12 Tf 150 50 Td ( ) Tj ET EMC\n'
    if variant == 'opaque-mark':
        extra = b'/P <</MCID 99 /ActualText (hidden)>> BDC EMC\n'
    source = marked_pdf(extra, mixed=variant == 'mixed', same_name=variant == 'collision')
    if variant == 'ambiguous':
        # Equal-width token replacement preserves xref offsets; both native
        # handles now have the same candidate set and must not be arbitrarily assigned.
        source = source.replace(b'/MCID 11', b'/MCID 10')
    backend = PackagedBackend(tmp_path / 'runtime').start()
    try:
        session = backend.open(source)['sessionId']
        target = backend.command(session, 'inspect', 0)['result']['discovery']['textObjects'][0]
        before = backend.record(session).read_bytes()
        reply = backend.command(session, 'save', 0, {'draft': EDIT}, target['targetId'])
        if variant in ('safe', 'marked-duplicates', 'disjoint-space'):
            assert reply['status'] == 'accepted', reply
            state = json.loads(backend.record(session).read_bytes())['state']
            assert set(state['checkpoints'][-1]['edit']['checks']) == REQUIRED_CHECKS
            result = backend.download(session, reply['result']['outputId'])
            # Xrefs can change; compare complete font identities and effective
            # states, never a resource alias or ordinal as preservation identity.
            fingerprints = lambda data: sorted(semantic_hash(v) for v in
                PdfReader(io.BytesIO(data)).pages[0]['/Resources']['/Font'].values())
            assert fingerprints(source) == fingerprints(result)
            assert [g['state'] for g in inspect(source)['groups']] == [g['state'] for g in inspect(result)['groups']]
            assert 'text' in PdfReader(io.BytesIO(result)).pages[0].extract_text()
            (tmp_path / 'accepted.pdf').write_bytes(result)
        else:
            assert reply['status'] == 'rejected', reply
            assert backend.record(session).read_bytes() == before
    finally:
        backend.stop()
