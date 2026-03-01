# build-win-local.ps1 — Build from existing Windows working directory (no sync)
#
# Builds directly from the existing %LOCALAPPDATA%\meterm-dev directory,
# preserving any changes made during dev mode.

$env:PATH = 'C:\Program Files\nodejs;' + $env:USERPROFILE + '\.cargo\bin;' + $env:PATH
$env:CARGO_TARGET_DIR = $env:USERPROFILE + '\AppData\Local\meterm-target'

$workDir = Join-Path $env:LOCALAPPDATA "meterm-dev"

if (-not (Test-Path $workDir)) {
    Write-Host "[build-win] ERROR: Working directory not found: $workDir" -ForegroundColor Red
    Write-Host "[build-win] Run 'make desktop-dev-win' first to create it." -ForegroundColor Yellow
    exit 1
}

Write-Host "[build-win] Building from: $workDir (no sync)"

Push-Location $workDir
try {
    $goExe = Get-Command go -ErrorAction SilentlyContinue
    if (-not $goExe) {
        Write-Host "[build-win] ERROR: Go not found in PATH (required to build meterm sidecar)." -ForegroundColor Red
        exit 1
    }

    $backendDir = Join-Path $workDir "backend"
    $sidecarDir = Join-Path $workDir "desktop\src-tauri\binaries"
    $sidecarExe = Join-Path $sidecarDir "meterm-server-x86_64-pc-windows-msvc.exe"
    New-Item -ItemType Directory -Force -Path $sidecarDir | Out-Null
    Push-Location $backendDir
    try {
        Write-Host "[build-win] Building native sidecar -> $sidecarExe ..."
        go build -o $sidecarExe .
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[build-win] Sidecar build failed with exit code $LASTEXITCODE" -ForegroundColor Red
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }

    npx tauri build --config src-tauri/tauri.windows.conf.json
    $buildExit = $LASTEXITCODE
    if ($buildExit -ne 0) {
        Write-Host "[build-win] Build failed with exit code $buildExit" -ForegroundColor Red
        exit $buildExit
    }
} finally {
    Pop-Location
}

$bundleDir = Join-Path $env:CARGO_TARGET_DIR "release\bundle"
$dlDir = Join-Path $env:USERPROFILE "Downloads"
$copied = 0

$nsisDir = Join-Path $bundleDir "nsis"
if (Test-Path $nsisDir) {
    Get-ChildItem -Path $nsisDir -Filter "*.exe" | ForEach-Object {
        Copy-Item $_.FullName -Destination $dlDir -Force
        Write-Host "[build-win] Copied $($_.Name) -> $dlDir" -ForegroundColor Green
        $copied++
    }
}

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
