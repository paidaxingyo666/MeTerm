.PHONY: dev backend frontend build clean desktop-sidecar desktop-dev desktop-build build-frontend desktop-dev-win desktop-dev-win-rebuild desktop-build-win release-macos release-macos-arm64 release-macos-x86_64 release-macos-all

dev:
	@echo "Building backend..."
	@cd backend && go build -o /tmp/meterm-server .
	@echo "Starting meterm..."
	@trap 'kill 0' EXIT; \
		/tmp/meterm-server & \
		sleep 1; \
		cd frontend && npm run dev

backend:
	cd backend && go run .

frontend:
	cd frontend && npm run dev

build:
	cd backend && go build -o ../bin/meterm-server .
	cd backend && go build -o ../bin/meterm ./cmd/meterm
	cd frontend && npm run build

desktop-sidecar:
	cd backend && go build -o ../desktop/src-tauri/binaries/meterm-server-$$(rustc --print host-tuple) .

desktop-dev: desktop-sidecar
	cd desktop && npm run tauri dev

desktop-build: desktop-sidecar
	cd desktop && npm run tauri build

build-frontend:
	cd frontend && npm run build

# ── Windows dev (run from WSL terminal) ─────────────────────────────────────
# Uses PowerShell to sync files from WSL to a Windows-local directory
# (%LOCALAPPDATA%\meterm-dev), then runs tauri dev from there.
# The sidecar is a native Windows exe (ConPTY backend), no WSL required at runtime.
# Requires Node.js + Rust/Cargo + Go installed on the Windows side.
#
#   make desktop-dev-win            # start dev (sidecar already built)
#   make desktop-dev-win-rebuild    # rebuild Go sidecar first, then start dev
#   make desktop-build-win          # full build: web frontend + sidecar + installer
#
desktop-dev-win:
	@d=$$(wslpath -w '$(CURDIR)/desktop'); \
	s=$$(wslpath -w '$(CURDIR)/desktop/scripts/dev-win.ps1'); \
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$$s" -UncPath "$$d"

desktop-build-win:
	@bash desktop/scripts/build-win.sh

desktop-dev-win-rebuild:
	@d=$$(wslpath -w '$(CURDIR)/desktop'); \
	b=$$(wslpath -w '$(CURDIR)/backend'); \
	x=$$(wslpath -w '$(CURDIR)/desktop/src-tauri/binaries/meterm-server-x86_64-pc-windows-msvc.exe'); \
	s=$$(wslpath -w '$(CURDIR)/desktop/scripts/dev-win-rebuild.ps1'); \
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$$s" -DesktopUncPath "$$d" -BackendUncPath "$$b" -SidecarUncPath "$$x"

# ── macOS release build ──────────────────────────────────────────────────────
release-macos:
	./build-macos.sh

release-macos-arm64:
	./build-macos.sh --arch arm64

release-macos-x86_64:
	./build-macos.sh --arch x86_64

release-macos-all:
	./build-macos.sh --arch both

clean:
	rm -rf bin/ frontend/dist/ backend/web/dist/ desktop/dist/ dist/
