"""Synthetic read-only resource evidence; no real/private corpus is copied."""

import pytest
from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject,
    NumberObject,
)

from features.edit_content.preservation import (
    UnprovenPreservation, optional_proof, resource_fingerprints, semantic_hash,
)


def stream(data):
    value = DecodedStreamObject()
    value.set_data(data)
    return value


def test_decoded_stream_identity_ignores_compression_and_xrefs():
    value = stream(b"synthetic font program")
    compressed = value.flate_encode()
    first, second = PdfWriter(), PdfWriter()
    second._add_object(DictionaryObject())
    assert semantic_hash(first._add_object(value)) == semantic_hash(second._add_object(compressed))
    assert semantic_hash(value) != semantic_hash(stream(b"other font program"))


def test_alias_renumbering_preserves_resource_identity_not_multiplicity():
    image = stream(b"pixels")
    a = DictionaryObject({NameObject("/XObject"): DictionaryObject({NameObject("/Im0"): image})})
    b = DictionaryObject({NameObject("/XObject"): DictionaryObject({NameObject("/OtherAlias"): image})})
    assert resource_fingerprints(a) == resource_fingerprints(b)
    b["/XObject"][NameObject("/Duplicate")] = image
    assert resource_fingerprints(a) != resource_fingerprints(b)


def test_mask_and_font_mapping_changes_are_not_unicode_equivalence():
    image = stream(b"same pixels")
    image[NameObject("/SMask")] = stream(b"mask one")
    before = semantic_hash(image)
    image[NameObject("/SMask")] = stream(b"mask two")
    assert semantic_hash(image) != before
    font = DictionaryObject({NameObject("/BaseFont"): NameObject("/SameName"),
                             NameObject("/Widths"): ArrayObject([NumberObject(600)])})
    before = semantic_hash(font)
    font["/Widths"][0] = NumberObject(601)
    assert semantic_hash(font) != before


def test_cycles_and_nonfinite_values_are_missing_proof_not_discovery_failure():
    writer = PdfWriter()
    value = DictionaryObject()
    reference = writer._add_object(value)
    value[NameObject("/Cycle")] = reference
    with pytest.raises(UnprovenPreservation):
        semantic_hash(reference)
    assert optional_proof(semantic_hash, reference) is None
    assert optional_proof(semantic_hash, float("nan")) is None
    assert semantic_hash(FloatObject(12.0)) == semantic_hash(NumberObject(12))


def test_explicit_default_graphics_state_is_not_a_new_dependency():
    state = DictionaryObject({NameObject("/BM"): NameObject("/Normal"),
                              NameObject("/CA"): NumberObject(1), NameObject("/ca"): FloatObject(1.0)})
    resources = DictionaryObject({NameObject("/ExtGState"): DictionaryObject({NameObject("/FXE1"): state})})
    assert resource_fingerprints(resources) == resource_fingerprints(DictionaryObject())
    state[NameObject("/BM")] = NameObject("/Multiply")
    assert optional_proof(resource_fingerprints, resources) is None
    state[NameObject("/BM")] = NameObject("/Normal")
    state[NameObject("/ca")] = FloatObject(0.5)
    assert optional_proof(resource_fingerprints, resources) is None
