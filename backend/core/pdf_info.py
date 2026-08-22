from pathlib import Path

import fitz


class PdfInfoError(Exception):
    pass


class PdfInfoOpenError(PdfInfoError):
    pass


def read_pdf_info(input_path: Path, filename: str) -> dict:
    try:
        document = fitz.open(str(input_path))
    except Exception as exc:
        raise PdfInfoOpenError(f"Cannot open PDF: {exc}") from exc
    try:
        return {
            "filename": filename,
            "total_pages": document.page_count,
            "file_size_bytes": input_path.stat().st_size,
            "metadata": document.metadata,
        }
    finally:
        document.close()