#!/bin/bash
# build-finder-extension.sh — Build and embed Finder Sync Extension into MeTerm.app
#
# Usage:
#   ./build-finder-extension.sh [app_bundle_path] [signing_identity]
#
# Arguments:
#   app_bundle_path   — Path to MeTerm.app (default: build only, don't embed)
#   signing_identity  — Code signing identity (default: "-" for ad-hoc)
#
# The target architecture is auto-detected from the app bundle's main binary.
# If no app bundle is given, falls back to the host architecture.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/../src-tauri" && pwd)"
EXT_SRC="$TAURI_DIR/finder-extension"
BUILD_DIR="$TAURI_DIR/target/finder-extension"

APP_BUNDLE="${1:-}"
SIGN_IDENTITY="${2:--}"

# Detect target architecture from the app bundle binary, or fall back to host arch
if [ -n "$APP_BUNDLE" ] && [ -d "$APP_BUNDLE" ]; then
    APP_BINARY="$APP_BUNDLE/Contents/MacOS/MeTerm"
    if [ -f "$APP_BINARY" ]; then
        BINARY_ARCH=$(lipo -archs "$APP_BINARY" 2>/dev/null || echo "")
        if echo "$BINARY_ARCH" | grep -q "x86_64"; then
            ARCH="x86_64"
        else
            ARCH="arm64"
        fi
    else
        ARCH=$(uname -m)
    fi
else
    ARCH=$(uname -m)
fi

if [ "$ARCH" = "arm64" ]; then
    TARGET="arm64-apple-macos14.0"
else
    TARGET="x86_64-apple-macos14.0"
fi

echo "=== Building MeTerm Finder Extension ==="
echo "  Architecture: $ARCH"
echo "  Target: $TARGET"
echo "  Sign identity: $SIGN_IDENTITY"

# Clean and create build directory
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Create .appex bundle structure
APPEX_DIR="$BUILD_DIR/MeTermFinder.appex"
mkdir -p "$APPEX_DIR/Contents/MacOS"

# Compile Swift source
echo "  Compiling FinderSync.swift..."
swiftc \
    -target "$TARGET" \
    -module-name MeTermFinder \
    -framework Cocoa \
    -framework FinderSync \
    -o "$APPEX_DIR/Contents/MacOS/MeTermFinder" \
    "$EXT_SRC/FinderSync.swift"

# Copy Info.plist
cp "$EXT_SRC/Info.plist" "$APPEX_DIR/Contents/Info.plist"

# Sign the .appex (skip --timestamp for ad-hoc signing)
echo "  Signing .appex..."
if [ "$SIGN_IDENTITY" = "-" ]; then
    codesign --force --sign "$SIGN_IDENTITY" \
        --entitlements "$EXT_SRC/MeTermFinder.entitlements" \
        "$APPEX_DIR"
else
    codesign --force --sign "$SIGN_IDENTITY" \
        --entitlements "$EXT_SRC/MeTermFinder.entitlements" \
        --timestamp \
        "$APPEX_DIR"
fi

echo "  Built: $APPEX_DIR"

# Embed into app bundle if path is provided
if [ -n "$APP_BUNDLE" ] && [ -d "$APP_BUNDLE" ]; then
    PLUGINS_DIR="$APP_BUNDLE/Contents/PlugIns"
    mkdir -p "$PLUGINS_DIR"
    rm -rf "$PLUGINS_DIR/MeTermFinder.appex"
    cp -R "$APPEX_DIR" "$PLUGINS_DIR/"
    echo "  Embedded into: $PLUGINS_DIR/MeTermFinder.appex"
elif [ -n "$APP_BUNDLE" ]; then
    echo "  WARNING: App bundle not found at $APP_BUNDLE, skipping embed"
fi

echo "=== Done ==="
