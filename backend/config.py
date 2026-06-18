"""
PDF Manager Backend — Configuration
All settings loaded from environment variables with sensible defaults.
"""
from pydantic_settings import BaseSettings
from pathlib import Path
import os


class Settings(BaseSettings):
    # Server
    HOST: str = "127.0.0.1"
    PORT: int = 8000

    # CORS — React dev server
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
    ]

    # File limits
    MAX_FILE_SIZE_MB: int = 500  # per file upload
    MAX_TOTAL_SIZE_MB: int = 2000  # total batch

    # Output directory — where processed files are saved
    OUTPUT_DIR: Path = Path.home() / "PDFManager" / "output"

    # Temp directory — for intermediate files
    TEMP_DIR: Path = Path.home() / "PDFManager" / "temp"

    # Logging
    LOG_LEVEL: str = "INFO"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()

# Ensure output and temp directories exist
settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
settings.TEMP_DIR.mkdir(parents=True, exist_ok=True)
