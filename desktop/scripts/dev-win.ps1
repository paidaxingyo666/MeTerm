# dev-win.ps1 — invoked by: make desktop-dev-win
#
# Copies the desktop project from WSL to a Windows-local directory, then runs
# tauri dev from there.  This side-steps every UNC-path issue (esbuild realpath,
# cmd.exe CWD, net use) by simply working on a native Windows filesystem.

param([string]$UncPath)

$env:PATH = 'C:\Program Files\nodejs;' + $env:USERPROFILE + '\.cargo\bin;' + $env:PATH
$env:CARGO_TARGET_DIR = $env:USERPROFILE + '\AppData\Local\meterm-target'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'

$workDir = Join-Path $env:LOCALAPPDATA "meterm-dev"

# ── Sync WSL → Windows (incremental after the first run) ─────────────────────
Write-Host "[dev-win] Syncing $UncPath -> $workDir ..."
robocopy $UncPath $workDir /MIR /XD node_modules .git target dist .vite /NFL /NDL /NJH /NJS /NP | Out-Null
Write-Host "[dev-win] Sync done"
Write-Host "[dev-win] WebView2 remote debugging: http://127.0.0.1:9222/json/list"

# ── Build native Windows backend sidecar ─────────────────────────────────────
$goExe = Get-Command go -ErrorAction SilentlyContinue
if (-not $goExe) {
    Write-Host "[dev-win] ERROR: Go not found in PATH (required to build meterm sidecar)." -ForegroundColor Red
    exit 1
}
$backendDir = Join-Path $workDir "backend"
$sidecarDir = Join-Path $workDir "desktop\src-tauri\binaries"
$sidecarExe = Join-Path $sidecarDir "meterm-server-x86_64-pc-windows-msvc.exe"
New-Item -ItemType Directory -Force -Path $sidecarDir | Out-Null
Write-Host "[dev-win] Building native sidecar -> $sidecarExe ..."
Push-Location $backendDir
try {
    go build -o $sidecarExe .
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
Write-Host "[dev-win] Sidecar build done"

# ── Run tauri dev from the Windows-local copy ─────────────────────────────────
Push-Location $workDir
try {
    npm install
    npx tauri dev --config src-tauri/tauri.windows.conf.json
} finally {
    Pop-Location
}
