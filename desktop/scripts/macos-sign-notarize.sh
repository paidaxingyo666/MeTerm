#!/bin/bash
# macos-sign-notarize.sh — Developer ID sign + notarize + staple for MeTerm.
#
# Usage:
#   macos-sign-notarize.sh app <APP_PATH>   # sign (hardened runtime) + notarize + staple a .app
#   macos-sign-notarize.sh dmg <DMG_PATH>   # sign + notarize + staple a .dmg
#
# The Finder extension (.appex) must already be signed (inside-out) before the
# .app is signed — build-finder-extension.sh handles that with the same identity.
#
# Required env:
#   APPLE_SIGNING_IDENTITY   e.g. "Developer ID Application: Your Name (TEAMID)"
#   APPLE_API_KEY_ID         App Store Connect API key id
#   APPLE_API_ISSUER_ID      App Store Connect issuer id (UUID)
#   APPLE_API_KEY_PATH       path to the .p8 key file
# Optional env (app mode):
#   ENTITLEMENTS_PATH        hardened-runtime entitlements for the .app

set -euo pipefail

MODE="${1:?usage: macos-sign-notarize.sh app|dmg <path>}"
TARGET="${2:?missing target path}"

: "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is required}"
: "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID is required}"
: "${APPLE_API_ISSUER_ID:?APPLE_API_ISSUER_ID is required}"
: "${APPLE_API_KEY_PATH:?APPLE_API_KEY_PATH is required}"

notarize() {
  local path="$1"
  echo "  Notarizing: $path"
  xcrun notarytool submit "$path" \
    --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER_ID" \
    --wait
}

case "$MODE" in
  app)
    APP="$TARGET"
    echo "=== Sign + notarize app: $APP ==="
    # Sign the app bundle inside-out (no --deep): the nested .appex is already
    # signed by build-finder-extension.sh; here we seal the main bundle with the
    # hardened runtime + entitlements so notarization passes.
    if [ -n "${ENTITLEMENTS_PATH:-}" ]; then
      codesign --force --options runtime --timestamp \
        --entitlements "$ENTITLEMENTS_PATH" \
        --sign "$APPLE_SIGNING_IDENTITY" "$APP"
    else
      codesign --force --options runtime --timestamp \
        --sign "$APPLE_SIGNING_IDENTITY" "$APP"
    fi
    codesign --verify --deep --strict --verbose=2 "$APP"

    # notarytool needs a zip/dmg/pkg container for a .app
    ZIP="${APP%.app}-notarize.zip"
    rm -f "$ZIP"
    /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
    notarize "$ZIP"
    rm -f "$ZIP"
    xcrun stapler staple "$APP"
    echo "=== App stapled OK ==="
    ;;
  dmg)
    DMG="$TARGET"
    echo "=== Sign + notarize dmg: $DMG ==="
    codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"
    notarize "$DMG"
    xcrun stapler staple "$DMG"
    echo "=== DMG stapled OK ==="
    ;;
  *)
    echo "unknown mode: $MODE (expected 'app' or 'dmg')" >&2
    exit 1
    ;;
esac
