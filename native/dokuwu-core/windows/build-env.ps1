# Dot-source before `cargo build` / `cargo test` on Windows:
#   . native\dokuwu-core\windows\build-env.ps1
# Needs Visual Studio Build Tools (C++ workload) and LLVM (winget install LLVM.LLVM).
$header = (Resolve-Path "$PSScriptRoot\max_align.h").Path -replace '\\', '/'
$env:BINDGEN_EXTRA_CLANG_ARGS = "-include `"$header`""
if (-not $env:LIBCLANG_PATH) { $env:LIBCLANG_PATH = 'C:\Program Files\LLVM\bin' }
# mupdf-sys picks toolset v143 (VS 2022) or v142. For a newer Build Tools install, name yours:
if (-not $env:MUPDF_MSVC_PLATFORM_TOOLSET) { $env:MUPDF_MSVC_PLATFORM_TOOLSET = 'v145' }
# MuPDF is copied into a deep OUT_DIR; use a short target dir to stay under path limits.
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = 'C:\t' }
Write-Host "dokuwu-core Windows build env set (target dir $env:CARGO_TARGET_DIR)"
