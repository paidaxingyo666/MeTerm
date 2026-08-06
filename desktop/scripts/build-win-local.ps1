# Build from the existing Windows-local worktree without syncing from WSL.
#
# This is an explicit developer convenience for testing changes made inside
# the cached worktree. Release builds should use make desktop-build-win.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$env:PATH = 'C:\Program Files\nodejs;' + $env:USERPROFILE + '\.cargo\bin;' + $env:PATH
$env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA "meterm-target"

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)

    & $Command @Arguments
    $commandExit = $LASTEXITCODE
    if ($commandExit -ne 0) {
        throw "$Command failed with exit code $commandExit"
    }
}

$workRoot = Join-Path $env:LOCALAPPDATA "meterm-rust-dev"
$desktopDir = Join-Path $workRoot "desktop"
$frontendDir = Join-Path $workRoot "frontend"
if (-not (Test-Path (Join-Path $desktopDir "package.json")) -or
    -not (Test-Path (Join-Path $frontendDir "package.json"))) {
    throw "Windows worktree not found. Run make desktop-dev-win or make desktop-build-win first."
}

$conptyDir = Join-Path (Join-Path $desktopDir "src-tauri\binaries") "conpty"
if (-not (Test-Path (Join-Path $conptyDir "conpty.dll")) -or
    -not (Test-Path (Join-Path $conptyDir "OpenConsole.exe"))) {
    throw "ConPTY resources are missing from $conptyDir"
}

Write-Host "[build-win-local] Building standalone web frontend ..."
Push-Location $frontendDir
try {
    Invoke-Checked "npm.cmd" @("install")
    Invoke-Checked "npm.cmd" @("run", "build")
} finally {
    Pop-Location
}

Write-Host "[build-win-local] Building native Tauri/Rust installer from $workRoot ..."
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
    Write-Host "[build-win-local] Copied $($installer.Name) -> $downloadDir" -ForegroundColor Green
}
Write-Host "[build-win-local] Done: $($installers.Count) installer(s) copied." -ForegroundColor Green
