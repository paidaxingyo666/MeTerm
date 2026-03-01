#!/usr/bin/env bash
# Download conpty.dll + OpenConsole.exe from the latest Windows Terminal release.
#
# These files provide a modern conhost (OpenConsole) that fixes critical Win10
# bugs: TUI exit killing the shell process, resize phantoms, mouse input, etc.
# The NuGet package (CI.Microsoft.Windows.Console.ConPTY) is outdated and still
# has the shell-killing bug; the Windows Terminal release has the fixes.
#
# Usage: ./scripts/download-conpty.sh [output_dir]
#   output_dir defaults to desktop/src-tauri/binaries/conpty
set -euo pipefail

# Windows Terminal release version — update this when upgrading.
WT_VERSION="1.23.20211.0"
DOWNLOAD_URL="https://github.com/microsoft/terminal/releases/download/v${WT_VERSION}/Microsoft.WindowsTerminal_${WT_VERSION}_x64.zip"

OUTPUT_DIR="${1:-desktop/src-tauri/binaries/conpty}"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "[conpty] Downloading Windows Terminal v${WT_VERSION} (x64 portable) ..."
curl -fSL -o "${TEMP_DIR}/wt.zip" "${DOWNLOAD_URL}"

echo "[conpty] Extracting conpty.dll + OpenConsole.exe ..."
unzip -qo "${TEMP_DIR}/wt.zip" "conpty.dll" "OpenConsole.exe" -d "${TEMP_DIR}/extracted" || true

# The zip may have files at root or in a subdirectory — search for them.
CONPTY_DLL="$(find "${TEMP_DIR}/extracted" -name 'conpty.dll' -print -quit)"
OPENCONSOLE_EXE="$(find "${TEMP_DIR}/extracted" -name 'OpenConsole.exe' -print -quit)"

if [[ -z "$CONPTY_DLL" ]]; then
  echo "ERROR: conpty.dll not found in the zip"
  exit 1
fi
if [[ -z "$OPENCONSOLE_EXE" ]]; then
  echo "ERROR: OpenConsole.exe not found in the zip"
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"
cp "$CONPTY_DLL" "${OUTPUT_DIR}/conpty.dll"
cp "$OPENCONSOLE_EXE" "${OUTPUT_DIR}/OpenConsole.exe"

echo "[conpty] Saved to ${OUTPUT_DIR}/:"
ls -lh "${OUTPUT_DIR}/conpty.dll" "${OUTPUT_DIR}/OpenConsole.exe"
echo "[conpty] Done (from Windows Terminal v${WT_VERSION})."
