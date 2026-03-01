# dev-win-rebuild.ps1 — invoked by: make desktop-dev-win-rebuild
# Rebuilds the native Windows sidecar binary, then starts the Tauri dev server.
# Same as dev-win.ps1 but rebuilds the sidecar first.

param(
    [string]$DesktopUncPath,
    [string]$BackendUncPath,
    [string]$SidecarUncPath
)

$env:PATH = 'C:\Program Files\Go\bin;C:\Program Files\nodejs;' + $env:USERPROFILE + '\.cargo\bin;' + $env:PATH
$env:CARGO_TARGET_DIR = $env:USERPROFILE + '\AppData\Local\meterm-target'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'

# ── Build the native Windows sidecar binary ──────────────────────────────────
# Windows Go cannot work on WSL filesystem (UNC path file locking fails),
# so we copy backend/ to a Windows-local temp dir first.
$goExe = Get-Command go -ErrorAction SilentlyContinue
if (-not $goExe) {
    Write-Host "[dev-win] ERROR: Go not found in PATH." -ForegroundColor Red
    exit 1
}

$tempDir = Join-Path $env:LOCALAPPDATA "meterm-go-build"
if (Test-Path $tempDir) { Remove-Item -Recurse -Force $tempDir }

Write-Host "[dev-win] Copying backend to Windows-local dir..."
robocopy $BackendUncPath $tempDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null

Write-Host "[dev-win] Cleaning Go build cache..."
go clean -cache 2>$null

Write-Host "[dev-win] Building native Windows sidecar -> $SidecarUncPath"
Push-Location $tempDir
$env:GOOS   = 'windows'
$env:GOARCH = 'amd64'
go build -a -o $SidecarUncPath .
$buildExit = $LASTEXITCODE
Remove-Item Env:GOOS
Remove-Item Env:GOARCH
Pop-Location
if ($buildExit -ne 0) {
    Write-Host "[dev-win] Go build FAILED" -ForegroundColor Red
    exit $buildExit
}

$info = Get-Item $SidecarUncPath
Write-Host ("[dev-win] Sidecar OK — {0:N0} bytes" -f $info.Length) -ForegroundColor Green

# ── Sync & run ────────────────────────────────────────────────────────────────
$workDir = Join-Path $env:LOCALAPPDATA "meterm-dev"

Write-Host "[dev-win] Syncing $DesktopUncPath -> $workDir ..."
robocopy $DesktopUncPath $workDir /MIR /XD node_modules .git target dist .vite /NFL /NDL /NJH /NJS /NP | Out-Null
Write-Host "[dev-win] Sync done"
Write-Host "[dev-win] WebView2 remote debugging: http://127.0.0.1:9222/json/list"

Push-Location $workDir
try {
    npm install
    npx tauri dev --config src-tauri/tauri.windows.conf.json
} finally {
    Pop-Location
}
