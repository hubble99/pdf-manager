"""
PDF Manager Backend — FastAPI Application Entry Point
"""
import logging
import shutil
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from models.common import SuccessResponse, ErrorResponse
from routers import merge, extract, compress, pdf_to_image, image_to_pdf, qr_barcode, insert, pdf_info, settings as settings_router, organize, metadata, protect, preview

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("pdf_manager")


# ── Startup / Shutdown Cleanup ─────────────────────────────────────────────────
def _clean_directory(path, label: str) -> None:
    """
    Remove every file and sub-folder inside *path*, but keep the directory itself.
    Errors are logged as warnings (best-effort cleanup).
    """
    if not path.exists():
        path.mkdir(parents=True, exist_ok=True)
        return
    removed, errors = 0, 0
    for item in path.iterdir():
        try:
            if item.is_file() or item.is_symlink():
                item.unlink()
            elif item.is_dir():
                shutil.rmtree(item, ignore_errors=True)
            removed += 1
        except Exception as exc:
            logger.warning(f"Cleanup [{label}]: could not remove '{item.name}': {exc}")
            errors += 1
    if removed or errors:
        logger.info(f"Cleanup [{label}]: {removed} item(s) removed" + (f", {errors} error(s) skipped" if errors else ""))


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI lifespan handler.
    STARTUP : Clean leftover temp upload files from previous sessions.
              Output dir is intentionally NOT cleaned here — user may not
              have downloaded their files from the previous session yet.
    SHUTDOWN: Clean both temp and output dirs so the app leaves no trace
              after exit. This is triggered when uvicorn receives SIGTERM
              (graceful shutdown) — e.g. when Tauri calls the clear-temp
              API before killing the sidecar, or when the sidecar exits
              cleanly on its own.
    """
    # ─ STARTUP ───────────────────────────────────────────────────────
    logger.info("PDF Manager starting up — cleaning leftover temp files from previous session...")
    _clean_directory(settings.TEMP_DIR, "temp")
    settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)  # ensure output dir exists
    logger.info("Startup cleanup complete. Ready to serve requests.")

    yield  # ← app runs here

    # ─ SHUTDOWN ─────────────────────────────────────────────────────
    logger.info("PDF Manager shutting down — performing final cleanup...")
    _clean_directory(settings.TEMP_DIR, "temp")
    _clean_directory(settings.OUTPUT_DIR, "output")
    logger.info("Shutdown cleanup complete.")

# ── FastAPI App ─────────────────────────────────────────────────────────────────
app = FastAPI(
    title="PDF Manager API",
    version="1.0.0",
    description="Backend API for PDF Manager desktop application",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# ── CORS ────────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-Total-Pages",
        "X-File-Size",
        "X-Output-File",
        "X-Format",
        "X-DPI",
        "X-Page-Size",
        "X-Reduction-Pct",
        "X-Size-Before",
        "X-Size-After",
        "X-Pages-Extracted",
        "X-Pages-Exported",
        "X-Images-Processed",
        "X-Output-Mode",
        "X-Content-Length",
        "X-Barcode-Type",
        "X-Rules-Applied",
    ],
)

# ── Expose Headers Middleware (safety net for Tauri webview) ─────────────────────
# The CORS middleware only adds Access-Control-Expose-Headers when the Origin
# matches allow_origins. In Tauri production mode the webview may send an origin
# (e.g. "http://tauri.localhost" or a custom-scheme variant) that doesn't match
# exactly, causing custom X-* headers to be invisible to the browser / axios.
# This middleware unconditionally ensures they are always exposed.
_EXPOSE_HEADERS = ", ".join([
    "X-Total-Pages",
    "X-File-Size",
    "X-Output-File",
    "X-Format",
    "X-DPI",
    "X-Page-Size",
    "X-Reduction-Pct",
    "X-Size-Before",
    "X-Size-After",
    "X-Pages-Extracted",
    "X-Pages-Exported",
    "X-Images-Processed",
    "X-Output-Mode",
    "X-Content-Length",
    "X-Barcode-Type",
    "X-Rules-Applied",
    "Content-Disposition",
])


@app.middleware("http")
async def expose_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Expose-Headers"] = _EXPOSE_HEADERS
    return response


# ── Global Exception Handler ────────────────────────────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception on {request.url}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content=ErrorResponse(
            status="error",
            message="An unexpected server error occurred.",
            detail=str(exc),
        ).model_dump(),
    )

# ── Routers ─────────────────────────────────────────────────────────────────────
app.include_router(merge.router, prefix="/api/v1")
app.include_router(extract.router, prefix="/api/v1")
app.include_router(compress.router, prefix="/api/v1")
app.include_router(pdf_to_image.router, prefix="/api/v1")
app.include_router(image_to_pdf.router, prefix="/api/v1")
app.include_router(qr_barcode.router, prefix="/api/v1")
app.include_router(insert.router, prefix="/api/v1")
app.include_router(pdf_info.router, prefix="/api/v1")
app.include_router(settings_router.router, prefix="/api/v1")
app.include_router(organize.router, prefix="/api/v1")
app.include_router(metadata.router, prefix="/api/v1")
app.include_router(protect.router, prefix="/api/v1")
app.include_router(preview.router, prefix="/api/v1")

# ── Health Check ────────────────────────────────────────────────────────────────
@app.get("/health", response_model=SuccessResponse, tags=["system"])
async def health_check():
    """Health check endpoint — used by Tauri sidecar and frontend."""
    return SuccessResponse(
        status="success",
        message="PDF Manager API is running",
        data={
            "version": "1.0.0",
            "output_dir": str(settings.OUTPUT_DIR),
            "temp_dir": str(settings.TEMP_DIR),
        },
    )

@app.get("/", tags=["system"])
async def root():
    return {"message": "PDF Manager API — visit /docs for Swagger UI"}


# ── Entry point (for direct run / Tauri sidecar) ─────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    import sys
    import threading
    import os
    import time

    logger.info(f"Starting PDF Manager API on {settings.HOST}:{settings.PORT}")

    # When running as a PyInstaller frozen executable, the module system is
    # different — uvicorn cannot import "main" as a string because there's no
    # real filesystem module. We must pass the app object directly.
    is_frozen = getattr(sys, 'frozen', False)

    if is_frozen:
        # Start a daemon thread to monitor the parent process (PyInstaller bootloader)
        # If the bootloader is killed by Tauri, this child process becomes an orphan
        # and needs to self-terminate.
        def monitor_parent():
            ppid = os.getppid()
            import platform
            if platform.system() == "Windows":
                import ctypes
                kernel32 = ctypes.windll.kernel32
                SYNCHRONIZE = 0x00100000
                while True:
                    process = kernel32.OpenProcess(SYNCHRONIZE, False, ppid)
                    if process == 0:
                        os._exit(0)
                    if kernel32.WaitForSingleObject(process, 0) == 0:
                        kernel32.CloseHandle(process)
                        os._exit(0)
                    kernel32.CloseHandle(process)
                    time.sleep(2)
            else:
                while True:
                    if os.getppid() != ppid or os.getppid() == 1:
                        os._exit(0)
                    time.sleep(2)

        t = threading.Thread(target=monitor_parent, daemon=True)
        t.start()

        # PyInstaller / Tauri sidecar mode: pass app object directly
        uvicorn.run(
            app,
            host=settings.HOST,
            port=settings.PORT,
            reload=False,
            log_level=settings.LOG_LEVEL.lower(),
        )
    else:
        # Normal dev mode: use string so --reload works
        uvicorn.run(
            "main:app",
            host=settings.HOST,
            port=settings.PORT,
            reload=False,
            log_level=settings.LOG_LEVEL.lower(),
        )


