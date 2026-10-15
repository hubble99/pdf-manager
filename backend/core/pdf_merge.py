"""PDF Merge Core Logic — backend/core/pdf_merge.py

Merges an ordered list of PDF files (by path) into a single output PDF using
PyMuPDF. All PDF processing lives here; routers call this module.

Two entry points exist because the two modes have different policies:

* :func:`merge_pdfs` keeps the original strict behaviour — the first unusable
  file fails the whole merge — and is what the upload endpoint uses.
* :func:`merge_documents` can skip unusable files and report them, which is what
  the folder workspace uses, where a single encrypted document must not cost the
  user the rest of the merge.

:func:`inspect_documents` classifies files without merging anything, so the
workspace can show the problems before the user commits to a merge.
"""
import logging
from dataclasses import dataclass, field
from pathlib import Path

import fitz  # PyMuPDF

from config import settings
from utils.filename_utils import sanitize_filename

logger = logging.getLogger("pdf_manager.core.merge")

PDF_SUFFIX = ".pdf"


class MergeError(Exception):
    """Raised when merge cannot be completed."""


@dataclass
class MergeProblem:
    path: str
    reason: str

    def to_dict(self) -> dict:
        return {"path": self.path, "reason": self.reason}


@dataclass
class MergeOutcome:
    output_path: Path
    total_pages: int
    size_bytes: int
    merged: int
    skipped: list[MergeProblem] = field(default_factory=list)


def classify_input(path: Path) -> str | None:
    """Return why ``path`` cannot be merged, or ``None`` when it can."""
    if not path.name.casefold().endswith(PDF_SUFFIX):
        return "not a PDF file"
    if not path.exists():
        return "file not found"
    if not path.is_file():
        return "not a file"

    try:
        with fitz.open(str(path)) as document:
            if document.is_encrypted:
                return "encrypted"
            if document.page_count < 1:
                return "no pages"
    except Exception:
        return "damaged or unreadable"
    return None


def inspect_documents(input_paths: list[Path]) -> tuple[list[Path], list[MergeProblem]]:
    """Split paths into usable files and problems, without merging anything."""
    usable: list[Path] = []
    problems: list[MergeProblem] = []
    for path in input_paths:
        reason = classify_input(path)
        if reason is None:
            usable.append(path)
        else:
            problems.append(MergeProblem(path=str(path), reason=reason))
    return usable, problems


def describe_documents(input_paths: list[Path]) -> list[tuple[int, int | None]]:
    """Size in bytes and page count for each path; the count is None when it cannot be read."""
    described: list[tuple[int, int | None]] = []
    for path in input_paths:
        try:
            size = path.stat().st_size
        except OSError:
            described.append((0, None))
            continue
        pages: int | None = None
        try:
            with fitz.open(str(path)) as document:
                if not document.is_encrypted:
                    pages = document.page_count
        except Exception:
            pages = None
        described.append((size, pages))
    return described


def _output_path(output_filename: str) -> Path:
    safe_name = sanitize_filename(output_filename, "pdf")
    return settings.OUTPUT_DIR / safe_name


def merge_documents(
    input_paths: list[Path],
    output_filename: str,
    skip_invalid: bool = False,
) -> MergeOutcome:
    """Merge ``input_paths`` in order, optionally skipping unusable files.

    With ``skip_invalid`` false the first unusable file raises, which is the
    behaviour the upload workflow relies on. With it true, unusable files are
    collected and reported in the outcome instead.
    """
    if len(input_paths) < 2:
        raise MergeError("At least 2 PDF files are required to merge.")

    if not skip_invalid:
        # Strict mode raises on the first unusable file and otherwise has already
        # written the complete output; merging again would only repeat the work.
        out_path, total_pages, size_bytes = merge_pdfs(input_paths, output_filename)
        return MergeOutcome(
            output_path=out_path, total_pages=total_pages, size_bytes=size_bytes,
            merged=len(input_paths), skipped=[],
        )

    usable, skipped = inspect_documents(input_paths)
    if len(usable) < 2:
        raise MergeError(
            "Fewer than 2 files can be merged after skipping the reported problems."
            if skipped else "At least 2 PDF files are required to merge."
        )

    out_path = _output_path(output_filename)
    merged = fitz.open()
    merged_count = 0
    try:
        for pdf_path in usable:
            try:
                with fitz.open(str(pdf_path)) as source:
                    if source.is_encrypted:
                        raise MergeError("encrypted")
                    merged.insert_pdf(source)
                merged_count += 1
            except Exception as exc:
                # A file that became unusable between the check and the merge is
                # reported rather than costing the user the whole run.
                if not skip_invalid:
                    raise MergeError(f"Cannot open '{pdf_path.name}': {exc}") from exc
                skipped.append(MergeProblem(path=str(pdf_path), reason="could not be read while merging"))

        if merged_count < 1:
            raise MergeError("None of the provided files could be merged.")

        total_pages = merged.page_count
        merged.save(str(out_path), garbage=4, deflate=True)
        logger.info(f"Merge complete → {out_path.name} ({total_pages} pages, {len(skipped)} skipped)")
    finally:
        merged.close()

    return MergeOutcome(
        output_path=out_path,
        total_pages=total_pages,
        size_bytes=out_path.stat().st_size,
        merged=merged_count,
        skipped=skipped,
    )


def merge_pdfs(input_paths: list[Path], output_filename: str) -> tuple[Path, int, int]:
    """
    Merge multiple PDF files into one.

    Args:
        input_paths: Ordered list of Path objects to merge.
        output_filename: Desired filename for the output (without path).

    Returns:
        Tuple of (output_path, total_pages, file_size_bytes).

    Raises:
        MergeError: For validation or processing failures.
    """
    if len(input_paths) < 2:
        raise MergeError("At least 2 PDF files are required to merge.")

    safe_name = sanitize_filename(output_filename, "pdf")
    out_path = settings.OUTPUT_DIR / safe_name

    merged = fitz.open()  # create empty PDF

    try:
        for idx, pdf_path in enumerate(input_paths):
            if not pdf_path.exists():
                raise MergeError(f"File not found: {pdf_path.name}")

            try:
                src = fitz.open(str(pdf_path))
            except Exception as e:
                raise MergeError(f"Cannot open '{pdf_path.name}': {e}")

            if src.is_encrypted:
                src.close()
                raise MergeError(f"'{pdf_path.name}' is encrypted and cannot be merged.")

            merged.insert_pdf(src)
            src.close()
            logger.debug(f"Inserted PDF #{idx + 1}: {pdf_path.name}")

        total_pages = merged.page_count
        merged.save(str(out_path), garbage=4, deflate=True)
        logger.info(f"Merge complete → {out_path.name} ({total_pages} pages)")

    finally:
        merged.close()

    size_bytes = out_path.stat().st_size
    return out_path, total_pages, size_bytes
