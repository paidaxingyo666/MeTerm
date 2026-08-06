# dev-win.ps1 — invoked by: make desktop-dev-win
#
# Mirrors only the two source trees needed by the native Windows app into a
# Windows-local worktree, builds the standalone web frontend used by the
# in-process Rust server, then starts Tauri dev. There is no backend sidecar.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias("UncPath")]
    [string]$RepoUncPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$env:PATH = 'C:\Program Files\nodejs;' + $env:USERPROFILE + '\.cargo\bin;' + $env:PATH
$env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA "meterm-target"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'

function Invoke-RobocopyMirror {
    param([string]$Source, [string]$Destination)

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & robocopy.exe $Source $Destination /MIR /XD node_modules .git target dist .vite /NFL /NDL /NJH /NJS /NP | Out-Null
    $copyExit = $LASTEXITCODE
    if ($copyExit -ge 8) {
        throw "robocopy failed for $Source with exit code $copyExit"
    }
}

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)

    & $Command @Arguments
    $commandExit = $LASTEXITCODE
    if ($commandExit -ne 0) {
        throw "$Command failed with exit code $commandExit"
    }
}

$desktopSource = Join-Path $RepoUncPath "desktop"
$frontendSource = Join-Path $RepoUncPath "frontend"
if (-not (Test-Path (Join-Path $desktopSource "package.json")) -or
    -not (Test-Path (Join-Path $frontendSource "package.json"))) {
    throw "RepoUncPath must point to the MeTerm repository root: $RepoUncPath"
}

$workRoot = Join-Path $env:LOCALAPPDATA "meterm-rust-dev"
$desktopDir = Join-Path $workRoot "desktop"
$frontendDir = Join-Path $workRoot "frontend"

Write-Host "[dev-win] Syncing desktop and frontend into $workRoot ..."
Invoke-RobocopyMirror $desktopSource $desktopDir
Invoke-RobocopyMirror $frontendSource $frontendDir
Write-Host "[dev-win] Sync done"

$conptyDir = Join-Path (Join-Path $desktopDir "src-tauri\binaries") "conpty"
if (-not (Test-Path (Join-Path $conptyDir "conpty.dll")) -or
    -not (Test-Path (Join-Path $conptyDir "OpenConsole.exe"))) {
    throw "ConPTY resources are missing. Run make desktop-dev-win from WSL so scripts/download-conpty.sh can prepare them."
}

# RustEmbed serves this sibling tree to mobile/web clients. It must be built
# before Cargo compiles the in-process server.
Write-Host "[dev-win] Building standalone web frontend ..."
Push-Location $frontendDir
try {
    Invoke-Checked "npm.cmd" @("install")
    Invoke-Checked "npm.cmd" @("run", "build")
} finally {
    Pop-Location
}

Write-Host "[dev-win] WebView2 remote debugging: http://127.0.0.1:9222/json/list"
Write-Host "[dev-win] Starting native Tauri/Rust development app ..."
Push-Location $desktopDir
try {
    Invoke-Checked "npm.cmd" @("install")
    Invoke-Checked "npx.cmd" @(
        "tauri", "dev",
        "--features", "development-mobile-control",
        "--config", "src-tauri/tauri.windows.conf.json"
    )
} finally {
    Pop-Location
}
