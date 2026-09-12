$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nativeRoot = Join-Path $repoRoot 'native/edit-content-engine'
$tauriRoot = Join-Path $repoRoot 'frontend/src-tauri'
$manifestPath = Join-Path $nativeRoot 'pdfium-artifacts.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or [IntPtr]::Size -ne 8) {
    throw 'The pinned Edit Content desktop artifact is currently Windows x64 only.'
}

$target = 'windows-x86_64'
$pin = $manifest.targets.$target
if (-not $pin -or $manifest.schema -ne 'edit-content-pdfium-artifacts/v1') {
    throw 'The pinned Windows x64 PDFium artifact manifest is unavailable.'
}

function Get-Sha256([string] $Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $digest = $algorithm.ComputeHash($stream)
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
    return [System.BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
}

function Assert-Hash([string] $Path, [string] $Expected, [string] $Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing."
    }
    $actual = Get-Sha256 $Path
    if ($actual -ne $Expected) {
        throw "$Label does not match its pinned SHA-256."
    }
    return $actual
}

$cacheRoot = Join-Path $nativeRoot 'target/pdfium-cache'
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
$archivePath = Join-Path $cacheRoot "$($pin.archiveSha256).tgz"
if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
    Assert-Hash $archivePath $pin.archiveSha256 'Cached PDFium archive' | Out-Null
} else {
    $partialPath = Join-Path $cacheRoot "$([Guid]::NewGuid().ToString('N')).download"
    try {
        Invoke-WebRequest -Uri $pin.archiveUrl -OutFile $partialPath
        Assert-Hash $partialPath $pin.archiveSha256 'Downloaded PDFium archive' | Out-Null
        Move-Item -LiteralPath $partialPath -Destination $archivePath
    } finally {
        if (Test-Path -LiteralPath $partialPath -PathType Leaf) {
            Remove-Item -LiteralPath $partialPath
        }
    }
}

$extractRoot = Join-Path $nativeRoot "target/pdfium-$target-$($pin.archiveSha256.Substring(0, 12))"
if (-not (Test-Path -LiteralPath $extractRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $extractRoot | Out-Null
    & tar.exe -xzf $archivePath -C $extractRoot
    if ($LASTEXITCODE -ne 0) { throw 'Pinned PDFium archive extraction failed.' }
}

$versionPath = Join-Path $extractRoot 'VERSION'
$versionFields = @{}
foreach ($line in Get-Content -LiteralPath $versionPath) {
    $parts = $line -split '=', 2
    if ($parts.Count -eq 2) { $versionFields[$parts[0]] = $parts[1] }
}
$reportedBuild = "$($versionFields.MAJOR).$($versionFields.MINOR).$($versionFields.BUILD).$($versionFields.PATCH)"
if ($reportedBuild -ne $manifest.buildIdentity) {
    throw 'Extracted PDFium build identity does not match the pinned manifest.'
}
$argsText = Get-Content -Raw -LiteralPath (Join-Path $extractRoot 'args.gn')
if ($argsText -notmatch 'target_os = "win"' -or $argsText -notmatch 'target_cpu = "x64"') {
    throw 'Extracted PDFium target is not Windows x64.'
}
$librarySource = Join-Path $extractRoot ($pin.libraryPath -replace '/', '\')
Assert-Hash $librarySource $pin.librarySha256 'Extracted PDFium DLL' | Out-Null

$noticeRelativePaths = @($pin.notices | ForEach-Object { $_.path })
$actualNoticePaths = @(
    Get-ChildItem -LiteralPath $extractRoot -Recurse -File |
        Where-Object { $_.FullName -match '[\\/]licenses[\\/]' -or $_.Name -eq 'LICENSE' } |
        ForEach-Object { $_.FullName.Substring($extractRoot.Length + 1).Replace('\', '/') } |
        Sort-Object
)
$expectedNoticePaths = @($noticeRelativePaths | Sort-Object)
if (Compare-Object -ReferenceObject $expectedNoticePaths -DifferenceObject $actualNoticePaths) {
    throw 'PDFium notice inventory differs from the pinned manifest.'
}
foreach ($notice in $pin.notices) {
    $noticeSource = Join-Path $extractRoot ($notice.path -replace '/', '\')
    Assert-Hash $noticeSource $notice.sha256 "PDFium notice $($notice.path)" | Out-Null
}

$cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
$workerManifest = Join-Path $nativeRoot 'Cargo.toml'
& $cargo build --locked --release --target 'x86_64-pc-windows-msvc' --manifest-path $workerManifest
if ($LASTEXITCODE -ne 0) { throw 'The pinned Edit Content worker build failed.' }
$workerPath = Join-Path $nativeRoot 'target/x86_64-pc-windows-msvc/release/edit-content-engine.exe'
if (-not (Test-Path -LiteralPath $workerPath -PathType Leaf)) {
    throw 'The Windows x64 Edit Content worker was not produced.'
}

$runtimeRoot = Join-Path $tauriRoot 'target/edit-content-runtime'
$runtimeNotices = Join-Path $runtimeRoot 'notices'
New-Item -ItemType Directory -Force -Path $runtimeNotices | Out-Null
Copy-Item -LiteralPath $workerPath -Destination (Join-Path $runtimeRoot 'edit-content-engine.exe') -Force
Copy-Item -LiteralPath $librarySource -Destination (Join-Path $runtimeRoot $pin.libraryFile) -Force
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $runtimeRoot 'pdfium-artifacts.json') -Force
foreach ($notice in $pin.notices) {
    $relative = $notice.path -replace '/', '\'
    $destination = Join-Path $runtimeNotices $relative
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
    Copy-Item -LiteralPath (Join-Path $extractRoot $relative) -Destination $destination -Force
}

$workerSha256 = Get-Sha256 (Join-Path $runtimeRoot 'edit-content-engine.exe')
$runtimeFiles = @(
    @{ path = 'edit-content-engine.exe'; sha256 = $workerSha256 },
    @{ path = $pin.libraryFile; sha256 = $pin.librarySha256 },
    @{ path = 'pdfium-artifacts.json'; sha256 = (Get-Sha256 (Join-Path $runtimeRoot 'pdfium-artifacts.json')) }
)
foreach ($notice in $pin.notices) {
    $relative = "notices/$($notice.path)"
    $runtimeFiles += @{ path = $relative; sha256 = (Get-Sha256 (Join-Path $runtimeRoot ($relative -replace '/', '\'))) }
}
$packageManifest = @{
    schema = 'edit-content-desktop-package/v1'
    target = 'x86_64-pc-windows-msvc'
    pdfiumBuild = $manifest.buildIdentity
    wrapperVersion = $manifest.wrapperVersion
    sourceArchiveSha256 = $pin.archiveSha256
    files = $runtimeFiles
}
$packageManifestPath = Join-Path $runtimeRoot 'edit-content-package-manifest.json'
$packageManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $packageManifestPath -Encoding utf8

$expectedPackagePaths = @(
    @($runtimeFiles | ForEach-Object { $_.path }) + 'edit-content-package-manifest.json' |
        Sort-Object
)
$actualPackagePaths = @(
    Get-ChildItem -LiteralPath $runtimeRoot -Recurse -File |
        ForEach-Object { $_.FullName.Substring($runtimeRoot.Length + 1).Replace('\', '/') } |
        Sort-Object
)
if (Compare-Object -ReferenceObject $expectedPackagePaths -DifferenceObject $actualPackagePaths) {
    throw 'Staged Edit Content package contains files outside the acceptance inventory.'
}
foreach ($entry in $runtimeFiles) {
    $stagedPath = Join-Path $runtimeRoot ($entry.path -replace '/', '\')
    Assert-Hash $stagedPath $entry.sha256 "Staged package file $($entry.path)" | Out-Null
}

$backendRoot = Join-Path $repoRoot 'backend'
$python = Join-Path $backendRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw 'The existing backend virtual environment is required to build the desktop sidecar.'
}
$binaryRoot = Join-Path $tauriRoot 'binaries'
New-Item -ItemType Directory -Force -Path $binaryRoot | Out-Null
$workRoot = Join-Path $tauriRoot 'target/pyinstaller-work'
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
Push-Location $backendRoot
try {
    & $python -m PyInstaller --noconfirm --distpath $binaryRoot --workpath $workRoot 'build.spec'
    if ($LASTEXITCODE -ne 0) { throw 'The packaged backend sidecar build failed.' }
} finally {
    Pop-Location
}
$backendOutput = Join-Path $binaryRoot 'pdf-manager-backend.exe'
$backendSidecar = Join-Path $binaryRoot 'pdf-manager-backend-x86_64-pc-windows-msvc.exe'
if (-not (Test-Path -LiteralPath $backendOutput -PathType Leaf)) {
    throw 'The packaged backend sidecar was not produced.'
}
Copy-Item -LiteralPath $backendOutput -Destination $backendSidecar -Force

"Prepared Edit Content desktop resources: PDFium $($manifest.buildIdentity), worker SHA-256 $workerSha256, notices $($pin.notices.Count)."
