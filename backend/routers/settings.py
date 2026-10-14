import logging
from fastapi import APIRouter, HTTPException
from config import settings
from models.common import SuccessResponse

logger = logging.getLogger("pdf_manager.routers.settings")
router = APIRouter(prefix="/settings", tags=["settings"])

@router.post("/clear-temp", response_model=SuccessResponse)
async def clear_temp():
    files_deleted = 0
    bytes_freed = 0
    
    dirs_to_clean = [settings.TEMP_DIR, settings.OUTPUT_DIR]
    
    for d in dirs_to_clean:
        if not d.exists():
            continue
        for file in d.glob("*"):
            if file.is_file():
                try:
                    size = file.stat().st_size
                    file.unlink()
                    files_deleted += 1
                    bytes_freed += size
                except Exception as e:
                    logger.warning(f"Failed to delete {file}: {e}")
                    
    return SuccessResponse(
        data={"files_deleted": files_deleted, "bytes_freed": bytes_freed},
        message="Temp and output files cleared successfully"
    )

import os
import subprocess
import sys

@router.post("/open-downloads", response_model=SuccessResponse)
async def open_downloads():
    try:
        downloads_path = os.path.join(os.path.expanduser('~'), 'Downloads')
        if sys.platform == "win32":
            # os.startfile can fail when running as a frozen sidecar due to privilege isolation.
            # Using explorer.exe directly is more reliable.
            subprocess.Popen(['explorer', downloads_path])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", downloads_path])
        else:
            subprocess.Popen(["xdg-open", downloads_path])
        return SuccessResponse(data={"opened": True}, message="Opened downloads folder")
    except Exception as e:
        logger.exception("Error opening downloads")
        raise HTTPException(status_code=500, detail="Could not open the downloads folder") from e

# ── Donation ──────────────────────────────────────────────────────────────────

def _donation_state() -> dict:
    """The configured donation value and what may be done with it."""
    value = (settings.DONATION_PAYPAL_VALUE or "").strip()
    placeholder = (settings.DONATION_PAYPAL_PLACEHOLDER or "").strip()
    is_placeholder = not value or (bool(placeholder) and value == placeholder)
    # Only a real https link can be opened; an email address can still be copied.
    can_open = (not is_placeholder) and value.startswith("https://") and len(value) > len("https://")
    return {"value": "" if is_placeholder else value, "is_placeholder": is_placeholder, "can_open": can_open}


@router.get("/donation")
async def donation_configuration():
    """Read-only: the page and the open action read the same configured value."""
    return SuccessResponse(data=_donation_state(), message="Donation configuration.")


@router.post("/open-donation")
async def open_donation():
    """Open the configured donation link in the system browser.

    Takes no destination from the caller: only the configured value is ever
    opened, and only when it is an https link, so this cannot be used to open an
    arbitrary address or a local path.
    """
    state = _donation_state()
    if not state["can_open"]:
        raise HTTPException(status_code=422, detail="No donation link is configured yet.")
    try:
        import webbrowser

        opened = webbrowser.open(state["value"], new=2)
    except Exception as e:
        logger.error(f"open donation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="The link could not be opened.")
    if not opened:
        raise HTTPException(status_code=500, detail="The link could not be opened.")
    return SuccessResponse(data={"opened": True}, message="Opened the donation link.")

