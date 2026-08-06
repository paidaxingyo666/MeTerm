.PHONY: dev backend frontend build clean desktop-sidecar desktop-dev desktop-build-dev desktop-run-dev desktop-build build-frontend desktop-dev-win desktop-dev-win-rebuild desktop-build-win release-macos release-macos-arm64 release-macos-x86_64 release-macos-all

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

desktop-dev:
	cd desktop && METERM_DEV_SIGNER_CN="$$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development:/{print $$2; exit}')" npm run tauri dev -- --features development-mobile-control --config '{"identifier":"com.meterm.dev","productName":"MeTerm Dev"}'

# Local UI/device validation only: Apple Development-signed Debug app, isolated
# from /Applications/MeTerm.app. Stable signing keeps the dev-only Keychain ACL
# usable across rebuilds without invoking any distribution/notarization flow.
desktop-build-dev:
	cd desktop && METERM_DEV_SIGNER_CN="$$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development:/{print $$2; exit}')" npm run tauri build -- --debug --bundles app --no-sign --features development-mobile-control,development-credential-recovery --config '{"identifier":"com.meterm.dev","productName":"MeTerm Dev","bundle":{"createUpdaterArtifacts":false}}'
	@set -eu; \
		identity="$$(security find-identity -v -p codesigning | awk '/"Apple Development:/{print $$2; exit}')"; \
		test -n "$$identity" || { echo "Apple Development signing identity not found" >&2; exit 1; }; \
		codesign --force --timestamp=none --options runtime \
			--entitlements desktop/src-tauri/Entitlements.plist \
			--sign "$$identity" --identifier com.meterm.dev \
			'desktop/src-tauri/target/debug/bundle/macos/MeTerm Dev.app'; \
		cn="$$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development:/{print $$2; exit}')"; \
		test -n "$$cn" || { echo "Apple Development certificate CN not found" >&2; exit 1; }; \
		codesign --verify --deep --strict \
			-R="identifier \"com.meterm.dev\" and anchor apple generic and certificate leaf[subject.OU] = \"G5J7URYYG5\" and certificate leaf[subject.CN] = \"$$cn\"" \
			'desktop/src-tauri/target/debug/bundle/macos/MeTerm Dev.app'; \
		actual_team="$$(codesign -dv --verbose=4 \
			'desktop/src-tauri/target/debug/bundle/macos/MeTerm Dev.app/Contents/MacOS/meterm' 2>&1 | \
			awk -F= '/^TeamIdentifier=/{print $$2; exit}')"; \
		test "$$actual_team" = "$${APPLE_TEAM_ID:-G5J7URYYG5}" || { \
			echo "MeTerm Dev signing team mismatch" >&2; exit 1; \
		}

# Full mobile-control validation must run the signed bundle, not the unsigned
# `tauri dev` executable, so its Keychain designated requirement stays stable.
desktop-run-dev: desktop-build-dev
	open -na 'desktop/src-tauri/target/debug/bundle/macos/MeTerm Dev.app'

desktop-dev-go: desktop-sidecar
	cd desktop && METERM_GO_SIDECAR=1 npm run tauri dev -- --config '{"identifier":"com.meterm.dev"}'

desktop-build:
	cd desktop && npm run tauri build

build-frontend:
	cd frontend && npm run build

# ── Windows dev (run from WSL terminal) ─────────────────────────────────────
# Uses PowerShell to mirror desktop/ and frontend/ into a Windows-local worktree,
# then runs the native Tauri build there. The HTTP/WebSocket server and terminal
# backends are Rust modules inside the Tauri process; there is no Go sidecar.
# Requires Windows-side Node.js, Rust/Cargo, MSVC Build Tools and WebView2.
#
#   make desktop-dev-win            # sync and start native Windows dev mode
#   make desktop-build-win          # sync and build the Windows installer
#   make desktop-dev-win-rebuild    # deprecated compatibility alias for dev-win
#
desktop-dev-win:
	@if [ ! -f desktop/src-tauri/binaries/conpty/conpty.dll ] || \
	   [ ! -f desktop/src-tauri/binaries/conpty/OpenConsole.exe ]; then \
		bash scripts/download-conpty.sh; \
	fi
	@d=$$(wslpath -w '$(CURDIR)'); \
	s=$$(wslpath -w '$(CURDIR)/desktop/scripts/dev-win.ps1'); \
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$$s" -RepoUncPath "$$d"

desktop-build-win:
	@bash desktop/scripts/build-win.sh

desktop-dev-win-rebuild:
	@echo "desktop-dev-win-rebuild is deprecated: the Rust server is built in-process."
	@$(MAKE) desktop-dev-win

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
