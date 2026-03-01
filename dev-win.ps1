# dev-win.ps1 — Windows dev launcher for MeTerm
# Usage (Windows PowerShell / Windows Terminal):
#   .\dev-win.ps1
# Usage (from WSL shell):
#   make desktop-dev-win

param(
    [switch]$RebuildSidecar   # Pass -RebuildSidecar to also rebuild the Go backend
)

$ErrorActionPreference = "Stop"
$root = Split-Path $MyInvocation.MyCommand.Path -Parent

# ── 1. Optionally rebuild the sidecar (Go → native Windows binary) ─────────
if ($RebuildSidecar) {
    $goExe = Get-Command go -ErrorAction SilentlyContinue
    if (-not $goExe) {
        Write-Error "go not found in PATH. Install Go for Windows or skip -RebuildSidecar."
        exit 1
    }
    Write-Host "[sidecar] Building meterm-server (windows/amd64) ..." -ForegroundColor Cyan
    $backendDir  = Join-Path $root "backend"
    $outBinary   = Join-Path $root "desktop\src-tauri\binaries\meterm-server-x86_64-pc-windows-msvc.exe"
    $env:GOOS    = "windows"
    $env:GOARCH  = "amd64"
    Push-Location $backendDir
    go build -o $outBinary .
    Pop-Location
    Remove-Item Env:GOOS
    Remove-Item Env:GOARCH
    Write-Host "[sidecar] Done." -ForegroundColor Green
}

# ── 2. Start Tauri in dev mode (Vite HMR + Rust hot-rebuild) ─────────────
$desktopDir = Join-Path $root "desktop"
Write-Host "[tauri]   Starting dev mode in $desktopDir ..." -ForegroundColor Cyan
Set-Location $desktopDir
npm run tauri dev
