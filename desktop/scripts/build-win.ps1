# build-win.ps1 — build the native Windows installer from a WSL checkout
#
# Mirrors desktop/ and frontend/ into a Windows-local worktree, builds both web
# frontends, then builds the Tauri app. The HTTP/WebSocket server and terminal
# backends are linked into the Rust executable; no sidecar binary is built.

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

Write-Host "[build-win] Syncing desktop and frontend into $workRoot ..."
Invoke-RobocopyMirror $desktopSource $desktopDir
Invoke-RobocopyMirror $frontendSource $frontendDir
Write-Host "[build-win] Sync done"

$conptyDir = Join-Path (Join-Path $desktopDir "src-tauri\binaries") "conpty"
if (-not (Test-Path (Join-Path $conptyDir "conpty.dll")) -or
    -not (Test-Path (Join-Path $conptyDir "OpenConsole.exe"))) {
    throw "ConPTY resources are missing. Run make desktop-build-win from WSL so scripts/download-conpty.sh can prepare them."
}

# The Rust in-process server embeds frontend/dist. Build it before Cargo.
Write-Host "[build-win] Building standalone web frontend ..."
Push-Location $frontendDir
try {
    Invoke-Checked "npm.cmd" @("install")
    Invoke-Checked "npm.cmd" @("run", "build")
} finally {
    Pop-Location
}

Write-Host "[build-win] Building native Tauri/Rust installer ..."
Push-Location $desktopDir
try {
    Invoke-Checked "npm.cmd" @("install")
    Invoke-Checked "npx.cmd" @("tauri", "build", "--config", "src-tauri/tauri.windows.conf.json")
} finally {
    Pop-Location
}

$bundleDir = Join-Path $env:CARGO_TARGET_DIR "release\bundle"
$downloadDir = Join-Path $env:USERPROFILE "Downloads"
New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null

$installers = @()
$nsisDir = Join-Path $bundleDir "nsis"
if (Test-Path $nsisDir) {
    $installers += @(Get-ChildItem -Path $nsisDir -Filter "*.exe" -File)
}
$msiDir = Join-Path $bundleDir "msi"
if (Test-Path $msiDir) {
    $installers += @(Get-ChildItem -Path $msiDir -Filter "*.msi" -File)
}

if ($installers.Count -eq 0) {
    throw "Tauri completed but no installer was found in $bundleDir"
}

foreach ($installer in $installers) {
    Copy-Item $installer.FullName -Destination $downloadDir -Force
    Write-Host "[build-win] Copied $($installer.Name) -> $downloadDir" -ForegroundColor Green
}
Write-Host "[build-win] Done: $($installers.Count) installer(s) copied." -ForegroundColor Green
