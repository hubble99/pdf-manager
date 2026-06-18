import logging
from fastapi import APIRouter
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
import platform
import subprocess

@router.post("/open-downloads", response_model=SuccessResponse)
async def open_downloads():
    try:
        downloads_path = os.path.join(os.path.expanduser('~'), 'Downloads')
        if platform.system() == "Windows":
            # os.startfile can fail when running as a frozen sidecar due to privilege isolation.
            # Using explorer.exe directly is more reliable.
            subprocess.Popen(['explorer', downloads_path])
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", downloads_path])
        else:
            subprocess.Popen(["xdg-open", downloads_path])
        return SuccessResponse(message="Opened downloads folder")
    except Exception as e:
        logger.error(f"Error opening downloads: {e}")
        return SuccessResponse(message="Failed to open downloads")

