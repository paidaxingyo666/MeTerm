# build-win.ps1 — Build Windows installer from WSL
#
# Syncs the desktop project to a Windows-local directory, runs tauri build,
# then copies the resulting installer(s) to the user's Downloads folder.

param([string]$UncPath)

$env:PATH = 'C:\Program Files\nodejs;' + $env:USERPROFILE + '\.cargo\bin;' + $env:PATH
$env:CARGO_TARGET_DIR = $env:USERPROFILE + '\AppData\Local\meterm-target'

$workDir = Join-Path $env:LOCALAPPDATA "meterm-dev"

# ── Sync WSL → Windows (incremental) ─────────────────────────────────────────
Write-Host "[build-win] Syncing $UncPath -> $workDir ..."
robocopy $UncPath $workDir /MIR /XD node_modules .git target dist .vite /NFL /NDL /NJH /NJS /NP | Out-Null
Write-Host "[build-win] Sync done"

# ── Build native Windows backend sidecar ─────────────────────────────────────
$goExe = Get-Command go -ErrorAction SilentlyContinue
if (-not $goExe) {
    Write-Host "[build-win] ERROR: Go not found in PATH (required to build meterm sidecar)." -ForegroundColor Red
    exit 1
}
$backendDir = Join-Path $workDir "backend"
$sidecarDir = Join-Path $workDir "desktop\src-tauri\binaries"
$sidecarExe = Join-Path $sidecarDir "meterm-server-x86_64-pc-windows-msvc.exe"
New-Item -ItemType Directory -Force -Path $sidecarDir | Out-Null
Write-Host "[build-win] Building native sidecar -> $sidecarExe ..."
Push-Location $backendDir
try {
    go build -o $sidecarExe .
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[build-win] Sidecar build failed with exit code $LASTEXITCODE" -ForegroundColor Red
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}
Write-Host "[build-win] Sidecar build done"

# ── Build ─────────────────────────────────────────────────────────────────────
Push-Location $workDir
try {
    npm install
    npx tauri build --config src-tauri/tauri.windows.conf.json
    $buildExit = $LASTEXITCODE
    if ($buildExit -ne 0) {
        Write-Host "[build-win] Build failed with exit code $buildExit" -ForegroundColor Red
        exit $buildExit
    }
} finally {
    Pop-Location
}

# ── Copy installers to Downloads ──────────────────────────────────────────────
$bundleDir = Join-Path $env:CARGO_TARGET_DIR "release\bundle"
$dlDir = Join-Path $env:USERPROFILE "Downloads"

$copied = 0

# NSIS installer (.exe)
$nsisDir = Join-Path $bundleDir "nsis"
if (Test-Path $nsisDir) {
    Get-ChildItem -Path $nsisDir -Filter "*.exe" | ForEach-Object {
        Copy-Item $_.FullName -Destination $dlDir -Force
        Write-Host "[build-win] Copied $($_.Name) -> $dlDir" -ForegroundColor Green
        $copied++
    }
}

# MSI installer
$msiDir = Join-Path $bundleDir "msi"
if (Test-Path $msiDir) {
    Get-ChildItem -Path $msiDir -Filter "*.msi" | ForEach-Object {
        Copy-Item $_.FullName -Destination $dlDir -Force
        Write-Host "[build-win] Copied $($_.Name) -> $dlDir" -ForegroundColor Green
        $copied++
    }
}

if ($copied -eq 0) {
    Write-Host "[build-win] Warning: no installer files found in $bundleDir" -ForegroundColor Yellow
} else {
    Write-Host "[build-win] Done! $copied installer(s) copied to $dlDir" -ForegroundColor Green
}
