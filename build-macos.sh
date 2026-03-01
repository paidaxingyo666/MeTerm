#!/bin/bash
# ============================================================================
# macOS 构建打包脚本 / macOS Build & Package Script
# 构建 MeTerm 的 macOS DMG 安装包
# ============================================================================

set -euo pipefail

# ── 颜色输出 ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo -e "\n${CYAN}══════════════════════════════════════════${NC}"; echo -e "${CYAN}  $*${NC}"; echo -e "${CYAN}══════════════════════════════════════════${NC}"; }

# ── 默认参数 ────────────────────────────────────────────────────────────────
ARCH="$(uname -m)"          # 默认当前机器架构
SIGN=false
NOTARIZE=false
SKIP_FRONTEND=false
OUTPUT_DIR="dist"
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── 帮助信息 ────────────────────────────────────────────────────────────────
usage() {
    cat <<EOF
用法 / Usage: $0 [选项]

选项 / Options:
  --arch <arm64|x86_64|both>   目标架构 (默认: 当前架构 $ARCH)
  --sign                       启用 Apple Developer ID 代码签名
  --notarize                   启用 Apple 公证 (需要 --sign)
  --skip-frontend              跳过前端构建 (前端未修改时加速)
  --output-dir <dir>           输出目录 (默认: dist/)
  -h, --help                   显示帮助

签名环境变量 / Signing Environment Variables:
  APPLE_SIGNING_IDENTITY       Developer ID Application 证书名称
  APPLE_ID                     Apple ID 邮箱
  APPLE_TEAM_ID                Apple Developer 团队 ID
  APPLE_PASSWORD               App-specific password (或 @keychain:label)

示例 / Examples:
  $0                           # 构建当前架构
  $0 --arch arm64              # 构建 Apple Silicon 版本
  $0 --arch x86_64             # 构建 Intel 版本
  $0 --arch both               # 构建双架构
  $0 --arch arm64 --sign       # 构建并签名
EOF
    exit 0
}

# ── 参数解析 ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --arch)     ARCH="$2"; shift 2 ;;
        --sign)     SIGN=true; shift ;;
        --notarize) NOTARIZE=true; shift ;;
        --skip-frontend) SKIP_FRONTEND=true; shift ;;
        --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
        -h|--help)  usage ;;
        *) err "未知参数: $1"; usage ;;
    esac
done

# 标准化架构名称
case "$ARCH" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x86_64" ;;
    both)          ARCH="both" ;;
    *) err "不支持的架构: $ARCH (支持: arm64, x86_64, both)"; exit 1 ;;
esac

if $NOTARIZE && ! $SIGN; then
    err "--notarize 需要同时使用 --sign"
    exit 1
fi

# ── 环境检查 ────────────────────────────────────────────────────────────────
step "Step 1/6: 环境检查 / Checking prerequisites"

check_cmd() {
    if ! command -v "$1" &>/dev/null; then
        err "未找到 $1，请先安装"
        exit 1
    fi
    local ver
    ver=$("$@" 2>&1 | head -1)
    ok "$1: $ver"
}

check_cmd go version
check_cmd rustc --version
check_cmd cargo --version
check_cmd node --version
check_cmd npm --version

# 检查 Rust target 是否已安装
install_rust_target() {
    local target="$1"
    if ! rustup target list --installed | grep -q "$target"; then
        info "安装 Rust target: $target"
        rustup target add "$target"
    fi
    ok "Rust target $target 已就绪"
}

if [[ "$ARCH" == "arm64" ]] || [[ "$ARCH" == "both" ]]; then
    install_rust_target "aarch64-apple-darwin"
fi
if [[ "$ARCH" == "x86_64" ]] || [[ "$ARCH" == "both" ]]; then
    install_rust_target "x86_64-apple-darwin"
fi

# ── 构建前端 ───────────────────────────────────────────────────────────────
# Web 前端必须先构建，Go 后端通过 go:embed 嵌入 backend/web/dist/
step "Step 2/6: 构建前端 / Building frontend"

# 构建 web frontend (嵌入 Go 后端)
if [[ -d "$PROJECT_ROOT/frontend" ]]; then
    info "构建 Web 前端 (嵌入 Go 后端)..."
    (cd "$PROJECT_ROOT/frontend" && npm ci --prefer-offline && npm run build)
    ok "Web 前端构建完成"
fi

if $SKIP_FRONTEND && [[ -d "$PROJECT_ROOT/desktop/dist" ]]; then
    warn "跳过桌面前端构建 (--skip-frontend)"
else
    info "安装桌面前端依赖..."
    (cd "$PROJECT_ROOT/desktop" && npm ci --prefer-offline)
    info "构建桌面前端..."
    (cd "$PROJECT_ROOT/desktop" && npm run build)
    ok "桌面前端构建完成"
fi

# ── 构建 Go sidecar ────────────────────────────────────────────────────────
step "Step 3/6: 构建 Go sidecar / Building Go sidecar"

build_go_sidecar() {
    local goarch="$1"
    local rust_triple="$2"
    local output="$PROJECT_ROOT/desktop/src-tauri/binaries/meterm-server-${rust_triple}"

    info "构建 ${rust_triple} ..."
    GOOS=darwin GOARCH="$goarch" go build -C "$PROJECT_ROOT/backend" \
        -ldflags="-s -w" \
        -o "$output" .
    ok "sidecar 已生成: $(basename "$output") ($(du -h "$output" | cut -f1))"
}

if [[ "$ARCH" == "arm64" ]] || [[ "$ARCH" == "both" ]]; then
    build_go_sidecar "arm64" "aarch64-apple-darwin"
fi
if [[ "$ARCH" == "x86_64" ]] || [[ "$ARCH" == "both" ]]; then
    build_go_sidecar "amd64" "x86_64-apple-darwin"
fi

# ── Tauri 构建 ──────────────────────────────────────────────────────────────
step "Step 4/6: Tauri 构建 / Building Tauri app"

build_tauri() {
    local rust_target="$1"
    local label="$2"

    info "构建 Tauri ($label) → target: $rust_target"
    (cd "$PROJECT_ROOT/desktop" && npm run tauri build -- --target "$rust_target")
    ok "Tauri 构建完成 ($label)"
}

if [[ "$ARCH" == "arm64" ]] || [[ "$ARCH" == "both" ]]; then
    build_tauri "aarch64-apple-darwin" "Apple Silicon (arm64)"
fi
if [[ "$ARCH" == "x86_64" ]] || [[ "$ARCH" == "both" ]]; then
    build_tauri "x86_64-apple-darwin" "Intel (x86_64)"
fi

# ── 代码签名 (可选) ─────────────────────────────────────────────────────────
step "Step 5/6: 代码签名 / Code signing"

sign_app() {
    local app_path="$1"

    if ! $SIGN; then
        warn "跳过代码签名 (未指定 --sign)"
        return
    fi

    if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
        err "APPLE_SIGNING_IDENTITY 未设置"
        err "示例: export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)'"
        exit 1
    fi

    info "签名: $(basename "$app_path")"
    codesign --deep --force --options runtime \
        --sign "$APPLE_SIGNING_IDENTITY" \
        --timestamp \
        "$app_path"
    ok "签名完成: $(basename "$app_path")"

    # 验证签名
    codesign --verify --verbose=2 "$app_path"
    ok "签名验证通过"
}

notarize_dmg() {
    local dmg_path="$1"

    if ! $NOTARIZE; then
        warn "跳过公证 (未指定 --notarize)"
        return
    fi

    for var in APPLE_ID APPLE_TEAM_ID APPLE_PASSWORD; do
        if [[ -z "${!var:-}" ]]; then
            err "$var 未设置"
            exit 1
        fi
    done

    info "提交公证: $(basename "$dmg_path")"
    xcrun notarytool submit "$dmg_path" \
        --apple-id "$APPLE_ID" \
        --team-id "$APPLE_TEAM_ID" \
        --password "$APPLE_PASSWORD" \
        --wait

    info "装订公证票据..."
    xcrun stapler staple "$dmg_path"
    ok "公证完成: $(basename "$dmg_path")"
}

# ── 收集产物 ────────────────────────────────────────────────────────────────
step "Step 6/6: 收集产物 / Collecting artifacts"

mkdir -p "$PROJECT_ROOT/$OUTPUT_DIR"

collect_artifacts() {
    local rust_target="$1"
    local label="$2"
    local bundle_dir="$PROJECT_ROOT/desktop/src-tauri/target/${rust_target}/release/bundle"

    # 签名 .app
    local app_path
    app_path=$(find "$bundle_dir/macos" -name "*.app" -maxdepth 1 2>/dev/null | head -1)
    if [[ -n "$app_path" ]]; then
        sign_app "$app_path"
    fi

    # 复制 DMG
    local dmg_path
    dmg_path=$(find "$bundle_dir/dmg" -name "*.dmg" -maxdepth 1 2>/dev/null | head -1)
    if [[ -n "$dmg_path" ]]; then
        local dest="$PROJECT_ROOT/$OUTPUT_DIR/$(basename "$dmg_path" .dmg)-${label}.dmg"
        cp "$dmg_path" "$dest"
        notarize_dmg "$dest"
        ok "DMG: $dest ($(du -h "$dest" | cut -f1))"
    else
        warn "未找到 DMG ($label)"
    fi
}

if [[ "$ARCH" == "arm64" ]] || [[ "$ARCH" == "both" ]]; then
    collect_artifacts "aarch64-apple-darwin" "arm64"
fi
if [[ "$ARCH" == "x86_64" ]] || [[ "$ARCH" == "both" ]]; then
    collect_artifacts "x86_64-apple-darwin" "x86_64"
fi

# ── 构建摘要 ────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}  构建完成! / Build Complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo ""
info "产物目录: $PROJECT_ROOT/$OUTPUT_DIR/"
ls -lh "$PROJECT_ROOT/$OUTPUT_DIR/"*.dmg 2>/dev/null || warn "未找到 DMG 文件"
echo ""
if $SIGN; then
    ok "代码签名: 已签名"
else
    warn "代码签名: 未签名 (用户安装时需在系统偏好设置中允许)"
fi
if $NOTARIZE; then
    ok "Apple 公证: 已完成"
else
    warn "Apple 公证: 未执行"
fi
