#!/usr/bin/env bash
# Build the native Windows installer from a WSL checkout.
#
# PowerShell performs the Windows-local sync and Tauri build. The application
# server is Rust code linked into the Tauri executable; there is no Go sidecar.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if ! command -v wslpath >/dev/null 2>&1 || ! command -v powershell.exe >/dev/null 2>&1; then
  echo "ERROR: build-win.sh must run inside WSL with powershell.exe available." >&2
  exit 1
fi

if [[ ! -f "$ROOT/desktop/src-tauri/binaries/conpty/conpty.dll" ||
      ! -f "$ROOT/desktop/src-tauri/binaries/conpty/OpenConsole.exe" ]]; then
  bash "$ROOT/scripts/download-conpty.sh" "$ROOT/desktop/src-tauri/binaries/conpty"
fi

REPO_WIN="$(wslpath -w "$ROOT")"
SCRIPT_WIN="$(wslpath -w "$ROOT/desktop/scripts/build-win.ps1")"

echo "[build-win] Starting native Tauri/Rust Windows build ..."
powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$SCRIPT_WIN" \
  -RepoUncPath "$REPO_WIN"
