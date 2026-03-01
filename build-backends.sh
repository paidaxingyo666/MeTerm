#!/bin/bash
# Build backend binaries for all platforms

set -euo pipefail

echo "Building MeTerm backend binaries..."

cd backend

# macOS ARM64 (Apple Silicon)
echo "Building macOS ARM64..."
GOOS=darwin GOARCH=arm64 go build -o ../desktop/src-tauri/binaries/meterm-server-aarch64-apple-darwin .

# macOS x86_64 (Intel)
echo "Building macOS x86_64..."
GOOS=darwin GOARCH=amd64 go build -o ../desktop/src-tauri/binaries/meterm-server-x86_64-apple-darwin .

# Linux x86_64 (for Windows WSL)
echo "Building Linux x86_64..."
GOOS=linux GOARCH=amd64 go build -o ../desktop/src-tauri/binaries/meterm-server-x86_64-unknown-linux-gnu .

# Windows x86_64 (native sidecar)
echo "Building Windows x86_64..."
GOOS=windows GOARCH=amd64 go build -o ../desktop/src-tauri/binaries/meterm-server-x86_64-pc-windows-msvc.exe .

# Windows ARM64 (native sidecar)
echo "Building Windows ARM64..."
GOOS=windows GOARCH=arm64 go build -o ../desktop/src-tauri/binaries/meterm-server-aarch64-pc-windows-msvc.exe .

cd ..

echo ""
echo "Build complete! Binary files:"
ls -lh desktop/src-tauri/binaries/
