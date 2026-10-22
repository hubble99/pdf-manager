"""Opens PDFs that only carry owner-password permissions.

A PDF with an empty open password opens in any viewer without asking, but its
owner password still restricts editing. Edit Content writes a new PDF, so the
edit session works on an unprotected copy of the uploaded file and the result
has no permission restrictions. A PDF that needs a real password is left alone
and is still rejected.
"""

from __future__ import annotations

from pathlib import Path

import fitz


def unlock_permission_only(path: Path) -> bool:
    """Replace ``path`` by an unprotected copy when no password is needed to open it.

    Returns True when the file was rewritten. Returns False, leaving the file
    untouched, for an unprotected PDF, a PDF that needs a password, or a file
    that cannot be read (the normal rejection path reports those).
    """
    unlocked = path.with_name(path.name + ".unlocked")
    try:
        # PyMuPDF opens an empty-password file by itself and then reports it as
        # not encrypted; `needs_pass` stays set when a real open password is
        # required, and the metadata still names the encryption.
        with fitz.open(str(path)) as doc:
            if doc.needs_pass or not (doc.metadata or {}).get("encryption"):
                return False
            doc.save(str(unlocked), encryption=fitz.PDF_ENCRYPT_NONE, garbage=0, deflate=False)
        unlocked.replace(path)
        return True
    except Exception:
        return False
    finally:
        unlocked.unlink(missing_ok=True)
