# Deprecated compatibility wrapper for the deleted Go-sidecar rebuild flow.
# The Rust server is linked into the Tauri executable and is rebuilt
# automatically by `tauri dev` when its sources change.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DesktopUncPath,
    [string]$BackendUncPath,
    [string]$SidecarUncPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoPath = Split-Path $DesktopUncPath -Parent
if (-not (Test-Path (Join-Path $repoPath "frontend\package.json"))) {
    throw "DesktopUncPath must point to the repository desktop directory: $DesktopUncPath"
}

Write-Warning "dev-win-rebuild.ps1 is deprecated; tauri dev now rebuilds the in-process Rust server."
& (Join-Path $PSScriptRoot "dev-win.ps1") -RepoUncPath $repoPath
