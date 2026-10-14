"""Pages whose annotations name their own page (signature widgets, links) stay provable."""
import io

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject

from features.edit_content.resource_inspector import ReadOnlyResourceInspector


def _pdf(*, widget_title="sig", with_page_ref=True) -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    annotation = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Widget"),
        NameObject("/FT"): NameObject("/Sig"), NameObject("/T"): TextStringObject(widget_title),
        NameObject("/Rect"): ArrayObject([FloatObject(10), FloatObject(10), FloatObject(90), FloatObject(40)]),
        NameObject("/F"): NumberObject(132),
    })
    if with_page_ref:
        annotation[NameObject("/P")] = page.indirect_reference
    page[NameObject("/Annots")] = ArrayObject([writer._add_object(annotation)])
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _page(tmp_path, **kwargs):
    path = tmp_path / "annotated.pdf"
    path.write_bytes(_pdf(**kwargs))
    return ReadOnlyResourceInspector().inspect(path).to_payload()["pages"][0]


def test_annotation_back_reference_to_its_page_does_not_block_the_preservation_proof(tmp_path):
    page = _page(tmp_path)
    assert isinstance(page["pagePreservation"], str) and len(page["pagePreservation"]) == 64


def test_the_proof_still_changes_when_the_annotation_changes(tmp_path):
    assert _page(tmp_path)["pagePreservation"] != _page(tmp_path, widget_title="other")["pagePreservation"]
    assert _page(tmp_path)["pagePreservation"] != _page(tmp_path, with_page_ref=False)["pagePreservation"]


def test_the_proof_is_stable_across_identical_documents(tmp_path):
    assert _page(tmp_path)["pagePreservation"] == _page(tmp_path)["pagePreservation"]
