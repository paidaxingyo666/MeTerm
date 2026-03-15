// Package buildinfo holds MeTerm build-time constants.
package buildinfo

// Version is the MeTerm version string. Referenced by:
//   - API /info endpoint (handler.go)
//   - PTY environment TERM_PROGRAM_VERSION (pty_unix.go, pty_windows.go)
//
// Update this when bumping the release version.
const Version = "0.1.8"
