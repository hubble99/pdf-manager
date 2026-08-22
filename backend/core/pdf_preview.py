from pathlib import Path

import fitz


class PreviewError(Exception):
    pass


class PreviewOpenError(PreviewError):
    pass


class PreviewEncryptedError(PreviewError):
    pass


class PreviewPageError(PreviewError):
    pass


MAX_PREVIEW_DIMENSIONS = {"low": 1024, "auto": 2048, "high": 4096}
MIN_PREVIEW_DPI = 36


def render_pdf_preview(input_path: Path, *, page_number: int, dpi: int, quality_hint: str) -> bytes:
    try:
        document = fitz.open(str(input_path))
    except Exception as exc:
        raise PreviewOpenError(f"Cannot open PDF: {exc}") from exc
    try:
        if document.is_encrypted:
            raise PreviewEncryptedError("PDF is encrypted.")
        if page_number < 1 or page_number > document.page_count:
            raise PreviewPageError(f"Page number out of bounds. Document has {document.page_count} pages.")
        page = document[page_number - 1]
        max_dimension = MAX_PREVIEW_DIMENSIONS.get(quality_hint, MAX_PREVIEW_DIMENSIONS["auto"])
        target_width = page.rect.width * (dpi / 72)
        target_height = page.rect.height * (dpi / 72)
        scale = 1.0
        if target_width > max_dimension or target_height > max_dimension:
            scale = min(max_dimension / target_width, max_dimension / target_height)
        actual_dpi = max(MIN_PREVIEW_DPI, int(dpi * scale))
        return page.get_pixmap(dpi=actual_dpi).tobytes("png")
    finally:
        document.close()