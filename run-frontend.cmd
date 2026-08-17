@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
set "FRONTEND_DIR=%PROJECT_ROOT%frontend"

if not exist "%FRONTEND_DIR%\package.json" (
    echo [ERROR] frontend\package.json tidak ditemukan.
    exit /b 1
)

if not exist "%FRONTEND_DIR%\node_modules" (
    echo [ERROR] Dependency frontend belum terpasang.
    echo Jalankan: npm --prefix frontend install
    exit /b 1
)

echo Frontend PDF Manager akan tersedia di URL yang ditampilkan Vite.
echo Tekan Ctrl+C untuk menghentikan server.
echo.
npm --prefix "%FRONTEND_DIR%" run dev
exit /b %ERRORLEVEL%