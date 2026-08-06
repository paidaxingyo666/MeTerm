#!/usr/bin/env bash
# Prepare the pinned ConPTY runtime files used by native Windows builds.
#
# Microsoft ships conpty.dll in the ConPTY NuGet package and OpenConsole.exe
# in the Windows Terminal portable archive. Generated binaries stay ignored by
# git and are mirrored into the Windows-local build worktree by the WSL scripts.

set -euo pipefail

NUGET_PACKAGE="CI.Microsoft.Windows.Console.ConPTY"
NUGET_VERSION="1.22.250314001"
NUGET_URL="https://www.nuget.org/api/v2/package/${NUGET_PACKAGE}/${NUGET_VERSION}"
NUGET_SHA256="36176ae949aa1b0762067376bb7172728fc98b6047ca7f7d5660ba5177e38a4c"
WT_VERSION="1.23.20211.0"
WT_URL="https://github.com/microsoft/terminal/releases/download/v${WT_VERSION}/Microsoft.WindowsTerminal_${WT_VERSION}_x64.zip"
WT_SHA256="83efe4572599479e9df38317a7be7feb1e2e86430432fc8d84f76df19de6cd11"

OUTPUT_DIR="${1:-desktop/src-tauri/binaries/conpty}"

if [[ -f "$OUTPUT_DIR/conpty.dll" && -f "$OUTPUT_DIR/OpenConsole.exe" ]]; then
  echo "[conpty] Reusing prepared files in $OUTPUT_DIR"
  exit 0
fi

for command in curl unzip awk; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: $command is required to prepare Windows ConPTY files." >&2
    exit 1
  fi
done

verify_sha256() {
  local expected="$1"
  local file="$2"
  local actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    echo "ERROR: sha256sum or shasum is required to verify Windows build inputs." >&2
    exit 1
  fi
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: SHA-256 mismatch for $file" >&2
    exit 1
  fi
}

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
mkdir -p "$TEMP_DIR/nuget" "$TEMP_DIR/terminal" "$OUTPUT_DIR"

echo "[conpty] Downloading ${NUGET_PACKAGE} ${NUGET_VERSION} ..."
curl -fL --retry 3 -o "$TEMP_DIR/conpty.nupkg" "$NUGET_URL"
verify_sha256 "$NUGET_SHA256" "$TEMP_DIR/conpty.nupkg"
# Some Unix unzip versions return 1 after successfully normalizing the NuGet
# archive's Windows path separators. Validate the exact x64 output below.
unzip -q "$TEMP_DIR/conpty.nupkg" -d "$TEMP_DIR/nuget" || true
CONPTY_DLL="$TEMP_DIR/nuget/runtimes/win10-x64/native/conpty.dll"
if [[ ! -f "$CONPTY_DLL" ]]; then
  echo "ERROR: conpty.dll was not found in ${NUGET_PACKAGE} ${NUGET_VERSION}." >&2
  exit 1
fi

echo "[conpty] Downloading Windows Terminal ${WT_VERSION} ..."
curl -fL --retry 3 -o "$TEMP_DIR/windows-terminal.zip" "$WT_URL"
verify_sha256 "$WT_SHA256" "$TEMP_DIR/windows-terminal.zip"
unzip -q "$TEMP_DIR/windows-terminal.zip" -d "$TEMP_DIR/terminal"
OPENCONSOLE_EXE="$TEMP_DIR/terminal/terminal-$WT_VERSION/OpenConsole.exe"
if [[ ! -f "$OPENCONSOLE_EXE" ]]; then
  echo "ERROR: OpenConsole.exe was not found in Windows Terminal ${WT_VERSION}." >&2
  exit 1
fi

cp "$CONPTY_DLL" "$OUTPUT_DIR/conpty.dll"
cp "$OPENCONSOLE_EXE" "$OUTPUT_DIR/OpenConsole.exe"
echo "[conpty] Prepared pinned Windows runtime files in $OUTPUT_DIR"
