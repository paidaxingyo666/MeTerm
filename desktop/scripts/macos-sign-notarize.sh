#!/bin/bash
# macos-sign-notarize.sh — Developer ID sign + notarize + staple for MeTerm.
#
# Usage:
#   macos-sign-notarize.sh app <APP_PATH>          # legacy combined operation
#   macos-sign-notarize.sh dmg <DMG_PATH>          # legacy combined operation
#   macos-sign-notarize.sh sign-app <APP_PATH>     # Developer ID key only
#   macos-sign-notarize.sh sign-dmg <DMG_PATH>     # Developer ID key only
#   macos-sign-notarize.sh notarize-app <APP_PATH> # Notary API key only
#   macos-sign-notarize.sh notarize-dmg <DMG_PATH> # Notary API key only
#
# The Finder extension (.appex) must already be signed (inside-out) before the
# .app is signed — build-finder-extension.sh handles that with the same identity.
#
# Required env for sign modes:
#   APPLE_SIGNING_IDENTITY   e.g. "Developer ID Application: Your Name (TEAMID)"
# Required env for notarize modes:
#   APPLE_API_KEY_ID         App Store Connect API key id
#   APPLE_API_ISSUER_ID      App Store Connect issuer id (UUID)
#   APPLE_API_KEY_PATH       path to the .p8 key file
# Optional env (app mode):
#   ENTITLEMENTS_PATH        hardened-runtime entitlements for the .app

set -euo pipefail

MODE="${1:?usage: macos-sign-notarize.sh app|dmg|sign-app|sign-dmg|notarize-app|notarize-dmg <path>}"
TARGET="${2:?missing target path}"

require_signing_identity() {
  : "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is required}"
}

require_notary_identity() {
  : "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID is required}"
  : "${APPLE_API_ISSUER_ID:?APPLE_API_ISSUER_ID is required}"
  : "${APPLE_API_KEY_PATH:?APPLE_API_KEY_PATH is required}"
}

notarize() {
  local path="$1"
  echo "  Notarizing: $path"
  xcrun notarytool submit "$path" \
    --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER_ID" \
    --wait
}

sign_app() {
  local app="$1"
  echo "=== Sign app: $app ==="
  if [ -n "${ENTITLEMENTS_PATH:-}" ]; then
    codesign --force --options runtime --timestamp \
      --entitlements "$ENTITLEMENTS_PATH" \
      --sign "$APPLE_SIGNING_IDENTITY" "$app"
  else
    codesign --force --options runtime --timestamp \
      --sign "$APPLE_SIGNING_IDENTITY" "$app"
  fi
  codesign --verify --deep --strict --verbose=2 "$app"
}

notarize_app() {
  local app="$1" zip
  zip="${app%.app}-notarize.zip"
  rm -f "$zip"
  /usr/bin/ditto -c -k --keepParent "$app" "$zip"
  notarize "$zip"
  rm -f "$zip"
  xcrun stapler staple "$app"
  echo "=== App stapled OK ==="
}

sign_dmg() {
  local dmg="$1"
  echo "=== Sign dmg: $dmg ==="
  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg"
}

notarize_dmg() {
  local dmg="$1"
  notarize "$dmg"
  xcrun stapler staple "$dmg"
  echo "=== DMG stapled OK ==="
}

case "$MODE" in
  app)
    require_signing_identity
    require_notary_identity
    sign_app "$TARGET"
    notarize_app "$TARGET"
    ;;
  dmg)
    require_signing_identity
    require_notary_identity
    sign_dmg "$TARGET"
    notarize_dmg "$TARGET"
    ;;
  sign-app)
    require_signing_identity
    sign_app "$TARGET"
    ;;
  sign-dmg)
    require_signing_identity
    sign_dmg "$TARGET"
    ;;
  notarize-app)
    require_notary_identity
    notarize_app "$TARGET"
    ;;
  notarize-dmg)
    require_notary_identity
    notarize_dmg "$TARGET"
    ;;
  *)
    echo "unknown mode: $MODE" >&2
    exit 1
    ;;
esac
