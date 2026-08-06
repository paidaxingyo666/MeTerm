#!/bin/bash
# build-macos.sh — build the current in-process Rust/Tauri desktop app.
#
# This script intentionally does not export signing identities from Keychain.
# Developer ID signing uses an existing local Keychain identity and notarization
# uses an App Store Connect API key path supplied explicitly by the operator.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $*"; }
ok() { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step() {
    echo -e "\n${CYAN}══════════════════════════════════════════${NC}"
    echo -e "${CYAN}  $*${NC}"
    echo -e "${CYAN}══════════════════════════════════════════${NC}"
}

ARCH="$(uname -m)"
SIGN=false
NOTARIZE=false
SKIP_FRONTEND=false
OUTPUT_DIR="dist"
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd -P)"

usage() {
    cat <<'EOF'
用法 / Usage: ./build-macos.sh [选项]

选项 / Options:
  --arch <arm64|x86_64|both>   目标架构（默认：当前架构）
  --sign                       使用本机 Keychain 中的 Developer ID 签名
  --notarize                   提交 Apple 公证并 staple（需要 --sign）
  --skip-frontend              复用已存在的 desktop/dist
  --output-dir <dir>           输出目录（默认：dist）
  -h, --help                   显示帮助

签名环境变量：
  APPLE_SIGNING_IDENTITY       Developer ID Application 完整名称或 SHA-1

公证环境变量：
  APPLE_API_KEY_ID             App Store Connect API key ID
  APPLE_API_ISSUER_ID          App Store Connect issuer ID
  APPLE_API_KEY_PATH           本机 .p8 文件路径

脚本只使用现有 Keychain 身份，不导出私钥。正式发布证据仍必须来自干净、
不可变 tag 及隔离的 build/sign/verify 流水线；本地输出默认属于开发验收产物。
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --arch)
            [[ $# -ge 2 ]] || { err "--arch 缺少参数"; exit 2; }
            ARCH="$2"
            shift 2
            ;;
        --sign) SIGN=true; shift ;;
        --notarize) NOTARIZE=true; shift ;;
        --skip-frontend) SKIP_FRONTEND=true; shift ;;
        --output-dir)
            [[ $# -ge 2 ]] || { err "--output-dir 缺少参数"; exit 2; }
            OUTPUT_DIR="$2"
            shift 2
            ;;
        -h|--help) usage; exit 0 ;;
        *) err "未知参数：$1"; usage >&2; exit 2 ;;
    esac
done

case "$ARCH" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64) ARCH="x86_64" ;;
    both) ;;
    *) err "不支持的架构：$ARCH"; exit 2 ;;
esac

if $NOTARIZE && ! $SIGN; then
    err "--notarize 必须与 --sign 一起使用"
    exit 2
fi

case "$OUTPUT_DIR" in
    ""|/|.|..) err "输出目录不安全：$OUTPUT_DIR"; exit 2 ;;
esac

if [[ "$OUTPUT_DIR" == /* ]]; then
    FINAL_OUTPUT_DIR="$OUTPUT_DIR"
else
    FINAL_OUTPUT_DIR="$PROJECT_ROOT/$OUTPUT_DIR"
fi

require_command() {
    command -v "$1" >/dev/null 2>&1 || {
        err "未找到必需命令：$1"
        exit 1
    }
}

install_rust_target() {
    local target="$1"
    if ! rustup target list --installed | grep -Fx "$target" >/dev/null; then
        info "安装 Rust target：$target"
        rustup target add "$target"
    fi
}

find_unique_app() {
    local bundle_dir="$1"
    local matches=()
    local candidate
    while IFS= read -r candidate; do
        matches+=("$candidate")
    done < <(find "$bundle_dir/macos" -maxdepth 1 -type d -name '*.app' -print)
    if [[ ${#matches[@]} -ne 1 ]]; then
        err "期望唯一 .app，实际 ${#matches[@]} 个：$bundle_dir/macos"
        exit 1
    fi
    printf '%s\n' "${matches[0]}"
}

rebuild_dmg() {
    local app_path="$1"
    local destination="$2"
    local app_name="$3"
    local staging_dir=""
    local temp_root="${TMPDIR:-/tmp}"
    temp_root="${temp_root%/}"

    rm -f -- "$destination"
    if command -v create-dmg >/dev/null 2>&1; then
        create-dmg \
            --volname "$app_name" \
            --window-size 660 400 \
            --icon-size 80 \
            --icon "$app_name.app" 180 170 \
            --app-drop-link 480 170 \
            "$destination" \
            "$app_path"
        return
    fi

    warn "未安装 create-dmg；使用 hdiutil 生成无自定义窗口布局的等价 DMG"
    staging_dir="$(mktemp -d "$temp_root/meterm-dmg.XXXXXXXX")"
    chmod 700 "$staging_dir"
    if ! ditto "$app_path" "$staging_dir/$app_name.app" || \
       ! ln -s /Applications "$staging_dir/Applications" || \
       ! hdiutil create -quiet -volname "$app_name" -srcfolder "$staging_dir" \
            -ov -format UDZO "$destination"; then
        rm -rf -- "$staging_dir"
        return 1
    fi
    rm -rf -- "$staging_dir"
}

step "1/5 环境检查"
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
for command_name in rustc cargo rustup node npm xcrun swiftc codesign security ditto hdiutil; do
    require_command "$command_name"
done
xcrun xcodebuild -version

if $SIGN; then
    : "${APPLE_SIGNING_IDENTITY:?--sign 需要 APPLE_SIGNING_IDENTITY}"
    identity_matches="$(security find-identity -v -p codesigning | grep -F -c "$APPLE_SIGNING_IDENTITY" || true)"
    if [[ "$identity_matches" -ne 1 ]]; then
        err "Keychain 中必须恰好存在一个指定签名身份（当前匹配：${identity_matches}）"
        exit 1
    fi
fi

if $NOTARIZE; then
    : "${APPLE_API_KEY_ID:?--notarize 需要 APPLE_API_KEY_ID}"
    : "${APPLE_API_ISSUER_ID:?--notarize 需要 APPLE_API_ISSUER_ID}"
    : "${APPLE_API_KEY_PATH:?--notarize 需要 APPLE_API_KEY_PATH}"
    [[ -f "$APPLE_API_KEY_PATH" && ! -L "$APPLE_API_KEY_PATH" && -r "$APPLE_API_KEY_PATH" ]] || {
        err "APPLE_API_KEY_PATH 必须是可读普通文件且不能是符号链接"
        exit 1
    }
fi

if [[ "$ARCH" == "arm64" || "$ARCH" == "both" ]]; then
    install_rust_target aarch64-apple-darwin
fi
if [[ "$ARCH" == "x86_64" || "$ARCH" == "both" ]]; then
    install_rust_target x86_64-apple-darwin
fi

step "2/5 安装锁定的桌面依赖"
(cd "$PROJECT_ROOT/desktop" && npm ci --prefer-offline)
if $SKIP_FRONTEND; then
    [[ -f "$PROJECT_ROOT/desktop/dist/index.html" ]] || {
        err "--skip-frontend 要求 desktop/dist/index.html 已存在"
        exit 1
    }
fi

build_one() {
    local target="$1"
    local label="$2"
    local config_json
    local bundle_dir
    local app_path
    local dmg_path
    local app_name
    local dmg_name
    local app_version
    local sign_identity="-"

    step "3/5 构建 $label"
    config_json='{"bundle":{"targets":["app"],"createUpdaterArtifacts":false}}'
    if $SKIP_FRONTEND; then
        config_json='{"build":{"beforeBuildCommand":""},"bundle":{"targets":["app"],"createUpdaterArtifacts":false}}'
    fi
    (
        cd "$PROJECT_ROOT/desktop"
        # Tauri auto-detects these variables and would otherwise sign while it
        # is still executing the repository build. Keep the build phase free
        # of signing/notary handles; the fixed operations below sign afterward.
        unset APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
        unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
        unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
        unset APPLE_API_KEY_ID APPLE_API_ISSUER_ID
        CARGO_NET_OFFLINE="${CARGO_NET_OFFLINE:-false}" \
            npm run tauri build -- --target "$target" --config "$config_json"
    )

    bundle_dir="$PROJECT_ROOT/desktop/src-tauri/target/$target/release/bundle"
    app_path="$(find_unique_app "$bundle_dir")"
    if $SIGN; then sign_identity="$APPLE_SIGNING_IDENTITY"; fi

    step "4/5 嵌入 Finder 扩展并重建容器（${label}）"
    bash "$PROJECT_ROOT/desktop/scripts/build-finder-extension.sh" "$app_path" "$sign_identity"

    if $SIGN; then
        ENTITLEMENTS_PATH="$PROJECT_ROOT/desktop/src-tauri/Entitlements.plist" \
            APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
            bash "$PROJECT_ROOT/desktop/scripts/macos-sign-notarize.sh" sign-app "$app_path"
    fi

    app_name="$(basename "$app_path" .app)"
    app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Contents/Info.plist")"
    [[ "$app_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
        err "App 版本格式无效：$app_version"
        exit 1
    }
    mkdir -p "$bundle_dir/dmg"
    dmg_name="${app_name}_${app_version}_${label}.dmg"
    dmg_path="$bundle_dir/dmg/$dmg_name"
    rebuild_dmg "$app_path" "$bundle_dir/dmg/$dmg_name" "$app_name"
    dmg_path="$bundle_dir/dmg/$dmg_name"
    [[ -f "$dmg_path" ]] || { err "DMG 重建失败"; exit 1; }

    if $SIGN; then
        APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
            bash "$PROJECT_ROOT/desktop/scripts/macos-sign-notarize.sh" sign-dmg "$dmg_path"
        codesign --verify --strict --verbose=2 "$dmg_path"
    fi

    if $NOTARIZE; then
        APPLE_API_KEY_ID="$APPLE_API_KEY_ID" \
            APPLE_API_ISSUER_ID="$APPLE_API_ISSUER_ID" \
            APPLE_API_KEY_PATH="$APPLE_API_KEY_PATH" \
            bash "$PROJECT_ROOT/desktop/scripts/macos-sign-notarize.sh" notarize-app "$app_path"
        APPLE_API_KEY_ID="$APPLE_API_KEY_ID" \
            APPLE_API_ISSUER_ID="$APPLE_API_ISSUER_ID" \
            APPLE_API_KEY_PATH="$APPLE_API_KEY_PATH" \
            bash "$PROJECT_ROOT/desktop/scripts/macos-sign-notarize.sh" notarize-dmg "$dmg_path"
        xcrun stapler validate "$app_path"
        xcrun stapler validate "$dmg_path"
    fi

    step "5/5 收集并复核 $label 产物"
    mkdir -p "$FINAL_OUTPUT_DIR"
    local output_app="$FINAL_OUTPUT_DIR/${app_name}-${label}.app"
    local output_dmg="$FINAL_OUTPUT_DIR/${app_name}-${label}.dmg"
    if [[ -e "$output_app" || -L "$output_app" || -e "$output_dmg" || -L "$output_dmg" ]]; then
        err "输出已存在，拒绝覆盖：$output_app 或 $output_dmg"
        exit 1
    fi
    ditto "$app_path" "$output_app"
    cp "$dmg_path" "$output_dmg"
    if $SIGN; then
        codesign --verify --deep --strict --verbose=2 "$output_app"
        codesign --verify --strict --verbose=2 "$output_dmg"
    fi
    shasum -a 256 "$output_dmg"
    ok "产物：$output_app"
    ok "产物：$output_dmg"
}

case "$ARCH" in
    arm64) build_one aarch64-apple-darwin arm64 ;;
    x86_64) build_one x86_64-apple-darwin x86_64 ;;
    both)
        build_one aarch64-apple-darwin arm64
        build_one x86_64-apple-darwin x86_64
        ;;
esac

echo
ok "macOS 本地构建完成"
if $NOTARIZE; then
    ok "签名与公证已完成并验证"
elif $SIGN; then
    warn "已完成 Developer ID 签名，但未提交公证"
else
    warn "当前为未签名开发验收产物"
fi
