@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
set "BACKEND_DIR=%PROJECT_ROOT%backend"
set "PYTHON=%BACKEND_DIR%\.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo [ERROR] Python virtual environment tidak ditemukan:
    echo         %PYTHON%
    echo Jalankan instalasi dependency backend terlebih dahulu.
    exit /b 1
)

pushd "%BACKEND_DIR%"
echo Backend PDF Manager: http://127.0.0.1:8000
echo API docs: http://127.0.0.1:8000/docs
echo Tekan Ctrl+C untuk menghentikan server.
echo.
"%PYTHON%" -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" echo Backend berhenti dengan exit code %EXIT_CODE%.
exit /b %EXIT_CODE%