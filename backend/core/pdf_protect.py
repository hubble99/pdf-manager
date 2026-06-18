import logging
from pathlib import Path

import fitz  # PyMuPDF

from config import settings
from utils.file_utils import sanitize_filename

logger = logging.getLogger("pdf_manager.core.protect")

class ProtectError(Exception):
    pass


def protect_pdf(
    input_path: Path,
    user_pw: str,
    owner_pw: str,
    output_filename: str = "protected.pdf",
    allow_print: bool = True,
    allow_copy: bool = True,
    allow_modify: bool = True,
) -> tuple[Path, int, int]:
    """
    Encrypt a PDF with user and owner passwords using AES-256.
    """
    try:
        doc = fitz.open(str(input_path))
    except Exception as e:
        raise ProtectError(f"Cannot open PDF: {e}")

    try:
        out_name = sanitize_filename(output_filename or input_path.stem, "pdf")
        out_path = settings.OUTPUT_DIR / out_name

        perms = fitz.PDF_PERM_ACCESSIBILITY
        if allow_print:
            perms |= fitz.PDF_PERM_PRINT | fitz.PDF_PERM_PRINT_HQ
        if allow_copy:
            perms |= fitz.PDF_PERM_COPY
        if allow_modify:
            perms |= fitz.PDF_PERM_MODIFY | fitz.PDF_PERM_ANNOTATE | fitz.PDF_PERM_ASSEMBLE | fitz.PDF_PERM_FORM

        # PyMuPDF Encryption
        # We use AES 256
        doc.save(
            str(out_path),
            garbage=4,
            deflate=True,
            encryption=fitz.PDF_ENCRYPT_AES_256,
            owner_pw=owner_pw,
            user_pw=user_pw,
            permissions=perms,
        )
        total_pages = doc.page_count
    except Exception as e:
        raise ProtectError(f"Failed to protect PDF: {e}")
    finally:
        doc.close()

    size_bytes = out_path.stat().st_size
    logger.info(f"Protected PDF saved to {out_name}")

    return out_path, total_pages, size_bytes
