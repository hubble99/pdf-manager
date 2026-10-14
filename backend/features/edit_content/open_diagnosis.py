"""Classifies why a PDF could not be opened by Edit Content.

Runs only on the failure path. It reads the file with pypdf and never writes.
"""

from __future__ import annotations

import io
from pathlib import Path

from pypdf import PdfReader

ENCRYPTED = "PDF_ENCRYPTED"
UNREADABLE = "PDF_UNREADABLE"
UNSUPPORTED = "REJECTED_UNSUPPORTED_STRUCTURE"

OPEN_FAILURE_MESSAGES = {
    ENCRYPTED: (
        "This PDF is encrypted or permission-protected, so Edit Content cannot inspect its fonts safely. "
        "Remove the protection first (Protect PDF > Remove Password), then open it again."
    ),
    UNREADABLE: (
        "Edit Content could not read the structure of this PDF. The file may be damaged or malformed."
    ),
    UNSUPPORTED: (
        "Edit Content V1 cannot safely edit this PDF because its font or page resources are outside the supported structure."
    ),
    "ENGINE_START_FAILED": "The editing engine could not be started. Please try again; if it keeps failing, restart the app.",
    "OPEN_TIMEOUT": "The editing engine took too long to open this PDF. Please try again.",
    "INSPECT_TIMEOUT": "The editing engine took too long to analyse this PDF. Please try again.",
    "ENGINE_UNAVAILABLE": "Edit Content engine is unavailable.",
}


def diagnose_rejected_source(source: Path) -> str:
    """Return the most specific reason code for a PDF the engine rejected."""
    try:
        data = Path(source).read_bytes()
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted:
            return ENCRYPTED
    except Exception:
        return UNREADABLE
    try:
        PdfReader(io.BytesIO(data), strict=True)
    except Exception:
        return UNREADABLE
    return UNSUPPORTED
