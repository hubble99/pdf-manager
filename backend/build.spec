# PyInstaller spec for bundling FastAPI + uvicorn backend as a single executable
# Build with: .venv\Scripts\pyinstaller build.spec

block_cipher = None

a = Analysis(
    ['main.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        ('.venv/Lib/site-packages/barcode/fonts/DejaVuSansMono.ttf', 'barcode/fonts')
    ],
    hiddenimports=[
        # uvicorn internals
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.loops.asyncio',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'uvicorn.lifespan.off',
        'uvicorn.main',
        'uvicorn.config',
        # FastAPI / starlette
        'starlette.routing',
        'starlette.middleware',
        'starlette.middleware.cors',
        'starlette.staticfiles',
        'fastapi.routing',
        # async
        'anyio',
        'anyio._backends._asyncio',
        # PDF / image
        'fitz',
        'PIL',
        'PIL.Image',
        'PIL.ImageOps',
        'PIL.ImageFile',
        # QR / barcode
        'qrcode',
        'qrcode.image.pil',
        'barcode',
        'barcode.writer',
        # pydantic
        'pydantic',
        'pydantic_settings',
        'pydantic.deprecated.config',
        # python-multipart (for file uploads)
        'multipart',
        'multipart.multipart',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'scipy',
        'numpy',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='pdf-manager-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
