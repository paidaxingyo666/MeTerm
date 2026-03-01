# build-win-sync.ps1 — Sync specific files from WSL, then build
#
# Copies changed files from WSL into the existing Windows working directory,
# patches main.ts for window visibility, then builds the installer.

param([string]$UncPath)

$env:PATH = 'C:\Program Files\nodejs;' + $env:USERPROFILE + '\.cargo\bin;' + $env:PATH
$env:CARGO_TARGET_DIR = $env:USERPROFILE + '\AppData\Local\meterm-target'

$workDir = Join-Path $env:LOCALAPPDATA "meterm-dev"

if (-not (Test-Path $workDir)) {
    Write-Host "[build-win] ERROR: Working directory not found: $workDir" -ForegroundColor Red
    exit 1
}

# ── Sync changed files from WSL ──────────────────────────────────────────────
$filesToSync = @(
    "src-tauri\src\lib.rs",
    "src-tauri\src\commands.rs",
    "src-tauri\src\sidecar.rs",
    "src-tauri\tauri.conf.json",
    "src-tauri\tauri.windows.conf.json",
    "src-tauri\binaries\meterm-server-x86_64-pc-windows-msvc.exe",
    "src-tauri\binaries\meterm-server-x86_64-unknown-linux-gnu"
)

foreach ($rel in $filesToSync) {
    $src = Join-Path $UncPath $rel
    $dst = Join-Path $workDir $rel
    $dstDir = Split-Path $dst -Parent
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination $dst -Force
        (Get-Item $dst).LastWriteTime = Get-Date
        Write-Host "[build-win] Synced $rel" -ForegroundColor Cyan
    } else {
        Write-Host "[build-win] WARN: $src not found, skipping" -ForegroundColor Yellow
    }
}

# ── Patch main.ts: show window after init (for visible:false config) ─────────
$mainTs = Join-Path $workDir "src\main.ts"
$mainContent = Get-Content $mainTs -Raw -Encoding UTF8

$marker = "await invoke('mark_window_initialized', { windowLabel: currentWindowLabel });"
$showLine = "  await getCurrentWindow().show();"

if ($mainContent.Contains($marker) -and -not $mainContent.Contains("// Show window after init")) {
    $replacement = $marker + "`n`n  // Show window after init (window starts hidden to avoid WebView2 flashing)`n" + $showLine
    $mainContent = $mainContent.Replace($marker, $replacement)
    [System.IO.File]::WriteAllText($mainTs, $mainContent, [System.Text.UTF8Encoding]::new($false))
    Write-Host "[build-win] Patched main.ts: added window.show() after init" -ForegroundColor Cyan
} else {
    Write-Host "[build-win] main.ts already patched or marker not found" -ForegroundColor Gray
}

# ── Force Cargo recompile ─────────────────────────────────────────────────────
Write-Host "[build-win] Cleaning cached Rust build..."
$cargoExe = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
& $cargoExe clean -p meterm_lib --manifest-path (Join-Path $workDir "src-tauri\Cargo.toml") --release 2>$null

# ── Build ─────────────────────────────────────────────────────────────────────
Write-Host "[build-win] Building from: $workDir"

Push-Location $workDir
try {
    Write-Host "[build-win] Building frontend (tsc + vite)..."
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[build-win] Frontend build failed" -ForegroundColor Red
        exit $LASTEXITCODE
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

# ── Copy installers to Downloads ──────────────────────────────────────────────
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
    Write-Host "[build-win] Warning: no installer files found" -ForegroundColor Yellow
} else {
    Write-Host "[build-win] Done! $copied installer(s) copied to $dlDir" -ForegroundColor Green
}
