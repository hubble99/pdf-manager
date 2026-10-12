"""Assemble one PDF from an ordered list of page references.

The workspace owns the page order, so this module performs no position
arithmetic: it walks the list, copies the referenced page from its source
document, and applies that entry's orientation. Reordering, deleting,
duplicating, and inserting are therefore all expressed by the list itself.
"""
from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Iterable, Mapping

import fitz

from config import settings
from core.image_page import ImagePageError, prepare_image_page
from core.pdf_page_transform import apply_orientation
from utils.filename_utils import sanitize_filename

logger = logging.getLogger("pdf_manager.core.organize_assembly")

VALID_ROTATIONS = (0, 90, 180, 270)


class OrganizeAssemblyError(Exception):
    """Raised when the page list cannot be assembled."""


def _read_source_id(entry: Mapping[str, object], index: int) -> str:
    source = entry.get("source")
    if not isinstance(source, str) or not source:
        raise OrganizeAssemblyError(f"Page entry {index + 1} has no source document.")
    return source


def _read_page(entry: Mapping[str, object], index: int, page_count: int) -> int:
    page = entry.get("page", 1)
    if not isinstance(page, int) or isinstance(page, bool):
        raise OrganizeAssemblyError(f"Page entry {index + 1} has an invalid page number.")
    if page < 1 or page > page_count:
        raise OrganizeAssemblyError(
            f"Page entry {index + 1} refers to page {page}, but that source has {page_count} page(s)."
        )
    return page


def _read_rotation(entry: Mapping[str, object], index: int) -> int:
    rotation = entry.get("rotation", 0)
    # Reject rather than normalise: silently turning 360 or -90 into a quarter
    # turn would hide a caller that is sending values outside the contract.
    if not isinstance(rotation, int) or isinstance(rotation, bool) or rotation not in VALID_ROTATIONS:
        raise OrganizeAssemblyError(f"Page entry {index + 1} has an unsupported rotation.")
    return rotation


def _read_flip(entry: Mapping[str, object], index: int) -> bool:
    flip = entry.get("flip", False)
    if not isinstance(flip, bool):
        raise OrganizeAssemblyError(f"Page entry {index + 1} has an invalid flip flag.")
    return flip


def _remove_partial(path: Path) -> None:
    """Discard a partially written output so a failed save leaves no broken file."""
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def _output_path(output_filename: str) -> Path:
    name = sanitize_filename(output_filename or "organized.pdf", "pdf")
    path = settings.OUTPUT_DIR / name
    if path.exists():
        path = settings.OUTPUT_DIR / f"{path.stem}_{uuid.uuid4().hex[:8]}{path.suffix}"
    return path


def assemble_pages(
    page_refs: Iterable[Mapping[str, object]],
    documents: Mapping[str, object],
    output_filename: str = "organized.pdf",
) -> tuple[Path, int, int]:
    """Build one PDF from ``page_refs`` and return ``(path, pages, bytes)``.

    ``documents`` maps a source id to an object exposing ``path``, ``kind``
    (``"pdf"`` or ``"image"``) and ``page_count``.
    """
    refs = list(page_refs)
    if not refs:
        raise OrganizeAssemblyError("The document has no pages to save.")

    out_path = _output_path(output_filename)
    output = fitz.open()
    source_documents: dict[str, fitz.Document] = {}

    def source_pdf(source_id: str) -> fitz.Document:
        if source_id not in source_documents:
            source_documents[source_id] = fitz.open(str(documents[source_id].path))
        return source_documents[source_id]

    try:
        for index, entry in enumerate(refs):
            source_id = _read_source_id(entry, index)
            source = documents.get(source_id)
            if source is None:
                raise OrganizeAssemblyError(
                    f"Page entry {index + 1} refers to a document that is no longer available."
                )

            page_number = _read_page(entry, index, source.page_count)
            rotation = _read_rotation(entry, index)
            flip = _read_flip(entry, index)

            if source.kind == "image":
                try:
                    jpeg, width, height = prepare_image_page(
                        source.path, rotation=rotation, flip=flip
                    )
                except ImagePageError as exc:
                    raise OrganizeAssemblyError(str(exc)) from exc
                page = output.new_page(width=width, height=height)
                page.insert_image(fitz.Rect(0, 0, width, height), stream=jpeg)
            else:
                output.insert_pdf(
                    source_pdf(source_id),
                    from_page=page_number - 1,
                    to_page=page_number - 1,
                )
                apply_orientation(output, output[-1], rotation=rotation, flip=flip)

        if output.page_count < 1:
            raise OrganizeAssemblyError("The assembled document has no pages.")

        output.save(str(out_path), garbage=4, deflate=True)
    except OrganizeAssemblyError:
        _remove_partial(out_path)
        raise
    except Exception as exc:
        _remove_partial(out_path)
        raise OrganizeAssemblyError(f"Failed to assemble the document: {exc}") from exc
    finally:
        # Each document is closed exactly once here. Closing a PyMuPDF document a
        # second time raises, which would mask the real error.
        for document in source_documents.values():
            document.close()
        output.close()

    size_bytes = out_path.stat().st_size
    logger.info(f"Organized document saved to {out_path.name} ({len(refs)} page entries)")
    return out_path, len(refs), size_bytes
