#!/usr/bin/env bash
# build-win.sh — 一键构建 Windows 安装包（从 WSL 中执行）
#
# 完整流程：
#   1. 构建 Web 前端 (frontend/ → backend/web/dist/)
#   2. 构建 Go sidecar (Windows 原生 exe + Linux fallback 二进制)
#   3. 同步文件 + 构建 Tauri 安装包 + 复制到 Downloads
#
# 用法：
#   bash desktop/scripts/build-win.sh
#   # 或
#   make desktop-build-win

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "════════════════════════════════════════════════════════════"
echo "  MeTerm — Windows 安装包构建"
echo "════════════════════════════════════════════════════════════"

# ── Step 1: 构建 Web 前端 ────────────────────────────────────────────────────
echo ""
echo "[1/3] 构建 Web 前端 (frontend → backend/web/dist) ..."
cd "$ROOT/frontend"
npm install --silent 2>/dev/null
npm run build
echo "[1/3] Web 前端构建完成"

# ── Step 2: 构建 Go sidecar ──────────────────────────────────────────────────
echo ""
echo "[2/3] 构建 Go sidecar (Windows native exe + Linux fallback) ..."

BACKEND_WIN=$(wslpath -w "$ROOT/backend")
SIDECAR_WIN_OUT=$(wslpath -w "$ROOT/desktop/src-tauri/binaries/meterm-server-x86_64-pc-windows-msvc.exe")
SIDECAR_LINUX_OUT=$(wslpath -w "$ROOT/desktop/src-tauri/binaries/meterm-server-x86_64-unknown-linux-gnu")
mkdir -p "$ROOT/desktop/src-tauri/binaries"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
\$env:PATH='C:\Program Files\Go\bin;'+\$env:PATH

\$tempDir = Join-Path \$env:LOCALAPPDATA 'meterm-go-build'
if (Test-Path \$tempDir) { Remove-Item -Recurse -Force \$tempDir }
Write-Host '[go] Copying backend source...'
robocopy '$BACKEND_WIN' \$tempDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null

Write-Host '[go] Cleaning Go build cache...'
go clean -cache 2>&1 | Out-Null

# Build Windows native sidecar
Write-Host '[go] Compiling Windows native sidecar...'
\$env:GOOS='windows'
\$env:GOARCH='amd64'
Push-Location \$tempDir
go build -a -o '$SIDECAR_WIN_OUT' .
\$ex = \$LASTEXITCODE
Pop-Location
if (\$ex -ne 0) { Write-Host 'Windows Go build FAILED' -ForegroundColor Red; exit \$ex }
\$info = Get-Item '$SIDECAR_WIN_OUT'
Write-Host ('[go] Windows sidecar OK — {0:N0} bytes' -f \$info.Length) -ForegroundColor Green

# Build Linux fallback sidecar (for WSL fallback)
Write-Host '[go] Compiling Linux fallback sidecar...'
\$env:GOOS='linux'
\$env:GOARCH='amd64'
Push-Location \$tempDir
go build -a -o '$SIDECAR_LINUX_OUT' .
\$ex = \$LASTEXITCODE
Pop-Location
if (\$ex -ne 0) { Write-Host 'Linux Go build FAILED' -ForegroundColor Red; exit \$ex }
\$info = Get-Item '$SIDECAR_LINUX_OUT'
Write-Host ('[go] Linux sidecar OK — {0:N0} bytes' -f \$info.Length) -ForegroundColor Green
"

echo "[2/3] Go sidecar 构建完成"

# ── Step 3: 构建 Tauri 安装包 ────────────────────────────────────────────────
echo ""
echo "[3/3] 构建 Windows 安装包 (Tauri + NSIS/MSI) ..."

DESKTOP_WIN=$(wslpath -w "$ROOT/desktop")
SCRIPT_WIN=$(wslpath -w "$ROOT/desktop/scripts/build-win-sync.ps1")

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_WIN" -UncPath "$DESKTOP_WIN"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  构建完成！安装包已复制到 Downloads 目录"
echo "════════════════════════════════════════════════════════════"
