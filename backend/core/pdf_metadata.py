from pathlib import Path

import fitz


class MetadataError(Exception):
    pass


class MetadataOpenError(MetadataError):
    pass


class MetadataEncryptedError(MetadataError):
    pass


def update_pdf_metadata(
    input_path: Path,
    output_path: Path,
    *,
    title: str,
    author: str,
    subject: str,
    keywords: str,
) -> None:
    try:
        document = fitz.open(str(input_path))
    except Exception as exc:
        raise MetadataOpenError(f"Cannot open PDF: {exc}") from exc
    try:
        if document.is_encrypted:
            raise MetadataEncryptedError("PDF is encrypted.")
        metadata = document.metadata
        metadata.update(title=title, author=author, subject=subject, keywords=keywords)
        document.set_metadata(metadata)
        document.save(str(output_path), garbage=4, deflate=True)
    finally:
        document.close()