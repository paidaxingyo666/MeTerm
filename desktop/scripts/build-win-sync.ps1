# Deprecated compatibility wrapper.
#
# Partial file syncs and local source patches are unsafe for release builds and
# were tied to the deleted sidecar layout. Use build-win.ps1, which mirrors the
# complete desktop/ and frontend/ source trees before building.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$UncPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoPath = $UncPath
if (Test-Path (Join-Path $UncPath "package.json")) {
    # Backward compatibility: the old script accepted the desktop/ path.
    $parent = Split-Path $UncPath -Parent
    if (Test-Path (Join-Path $parent "frontend\package.json")) {
        $repoPath = $parent
    }
}

Write-Warning "build-win-sync.ps1 is deprecated; running the full native Rust build instead."
& (Join-Path $PSScriptRoot "build-win.ps1") -RepoUncPath $repoPath
