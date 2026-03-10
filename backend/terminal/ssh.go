package terminal

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// SSHConfig holds SSH connection parameters.
type SSHConfig struct {
	Host       string
	Port       uint16
	Username   string
	AuthMethod string // "password" or "key"
	Password   string
	PrivateKey string // path to private key file
	Passphrase string // passphrase for private key (optional)
	// TrustedFingerprint is the SHA256 fingerprint the user has approved.
	// If set, the host key is accepted when it matches, and appended to known_hosts.
	// If empty and the host is unknown, HostKeyUnknownError is returned.
	TrustedFingerprint string
}

// HostKeyUnknownError is returned when a host is not in known_hosts and no
// TrustedFingerprint was provided. The frontend should show a confirmation
// dialog with the fingerprint and retry with TrustedFingerprint set.
type HostKeyUnknownError struct {
	Hostname    string
	Fingerprint string
	KeyType     string
}

func (e *HostKeyUnknownError) Error() string {
	return fmt.Sprintf("host key unknown: %s (%s) fingerprint %s", e.Hostname, e.KeyType, e.Fingerprint)
}

// HostKeyMismatchError is returned when the host key does not match what is
// stored in known_hosts. This may indicate a man-in-the-middle attack.
type HostKeyMismatchError struct {
	Hostname    string
	Fingerprint string
	KeyType     string
}

func (e *HostKeyMismatchError) Error() string {
	return fmt.Sprintf("host key CHANGED for %s (%s) fingerprint %s — possible MITM attack", e.Hostname, e.KeyType, e.Fingerprint)
}

// SSHTerminal implements Terminal over an SSH connection.
type SSHTerminal struct {
	client  *ssh.Client
	session *ssh.Session
	stdin   io.WriteCloser
	stdout  io.Reader
	done    chan struct{}
	mu      sync.Mutex
	closed  bool
}

var _ Terminal = (*SSHTerminal)(nil)

// NewSSHTerminal establishes an SSH connection and starts a shell session.
func NewSSHTerminal(cfg SSHConfig, cols, rows uint16) (*SSHTerminal, error) {
	authMethods, err := buildAuthMethods(cfg)
	if err != nil {
		return nil, fmt.Errorf("ssh auth setup failed: %w", err)
	}

	hostKeyCallback, err := buildHostKeyCallback(cfg)
	if err != nil {
		return nil, err
	}

	sshConfig := &ssh.ClientConfig{
		User:            cfg.Username,
		Auth:            authMethods,
		HostKeyCallback: hostKeyCallback,
		Timeout:         15 * time.Second,
	}

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	client, err := ssh.Dial("tcp", addr, sshConfig)
	if err != nil {
		return nil, fmt.Errorf("ssh dial failed: %w", err)
	}

	session, err := client.NewSession()
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("ssh session failed: %w", err)
	}

	// Request PTY — start with ECHO off so we can inject the shell hook invisibly.
	// The hook command ends with "stty echo" to re-enable echo before the first prompt.
	modes := ssh.TerminalModes{
		ssh.ECHO:          0,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := session.RequestPty("xterm-256color", int(rows), int(cols), modes); err != nil {
		session.Close()
		client.Close()
		return nil, fmt.Errorf("ssh pty request failed: %w", err)
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		session.Close()
		client.Close()
		return nil, fmt.Errorf("ssh stdin pipe failed: %w", err)
	}

	stdout, err := session.StdoutPipe()
	if err != nil {
		session.Close()
		client.Close()
		return nil, fmt.Errorf("ssh stdout pipe failed: %w", err)
	}

	// Merge stderr into stdout using an io.Pipe so both are read concurrently.
	// io.MultiReader is NOT safe here: it reads stdout to EOF before touching
	// stderr, which means stderr blocks forever while the shell is running.
	// With a PTY session, stderr is typically empty (the PTY merges streams),
	// but a concurrent pipe is still correct for non-PTY edge cases.
	stderr, err := session.StderrPipe()
	if err != nil {
		session.Close()
		client.Close()
		return nil, fmt.Errorf("ssh stderr pipe failed: %w", err)
	}
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		_, _ = io.Copy(pw, stdout)
	}()
	go func() {
		_, _ = io.Copy(pw, stderr)
	}()
	mergedReader := pr

	if err := session.Shell(); err != nil {
		session.Close()
		client.Close()
		return nil, fmt.Errorf("ssh shell start failed: %w", err)
	}

	// Inject OSC 7 CWD-tracking hook invisibly (ECHO is off).
	// The hook makes bash/zsh emit OSC 7 on every prompt, enabling CWD tracking.
	// Leading space prevents it from being saved in shell history (HISTCONTROL=ignorespace).
	// "stty echo" at the end re-enables echo before the first interactive prompt.
	hook := " if [ -n \"$ZSH_VERSION\" ]; then" +
		" precmd(){ printf '\\033]7;file://%s%s\\007' \"$(hostname)\" \"$PWD\"; };" +
		" elif [ -n \"$BASH_VERSION\" ]; then" +
		" PROMPT_COMMAND='printf \"\\033]7;file://%s%s\\007\" \"$(hostname)\" \"$PWD\"'${PROMPT_COMMAND:+\";$PROMPT_COMMAND\"};" +
		" fi; printf '\\033[A\\033[2K\\r'; stty echo\n"
	_, _ = stdin.Write([]byte(hook))

	t := &SSHTerminal{
		client:  client,
		session: session,
		stdin:   stdin,
		stdout:  mergedReader,
		done:    make(chan struct{}),
	}

	go func() {
		defer close(t.done)
		_ = session.Wait()
	}()

	// Monitor connection health
	go t.monitorConnection()

	return t, nil
}

func expandTilde(path string) string {
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, path[2:])
		}
	}
	return path
}

func buildAuthMethods(cfg SSHConfig) ([]ssh.AuthMethod, error) {
	var methods []ssh.AuthMethod

	switch cfg.AuthMethod {
	case "key":
		keyPath := cfg.PrivateKey
		if keyPath == "" {
			home, _ := os.UserHomeDir()
			keyPath = home + "/.ssh/id_rsa"
		} else {
			keyPath = expandTilde(keyPath)
		}
		// Validate key path: resolve to absolute and ensure no directory traversal
		keyPath = filepath.Clean(keyPath)
		if !filepath.IsAbs(keyPath) {
			return nil, fmt.Errorf("private key path must be absolute")
		}
		// Restrict to user's home directory to prevent arbitrary file reads
		home, _ := os.UserHomeDir()
		if home != "" && !strings.HasPrefix(keyPath, home+string(filepath.Separator)) {
			return nil, fmt.Errorf("private key path must be within home directory")
		}
		keyData, err := os.ReadFile(keyPath)
		if err != nil {
			return nil, fmt.Errorf("failed to read private key: %w", err)
		}

		var signer ssh.Signer
		if cfg.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(keyData, []byte(cfg.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(keyData)
		}
		if err != nil {
			return nil, fmt.Errorf("failed to parse private key: %w", err)
		}
		methods = append(methods, ssh.PublicKeys(signer))

	case "password":
		methods = append(methods, ssh.Password(cfg.Password))

	default:
		// Try password first, then key
		if cfg.Password != "" {
			methods = append(methods, ssh.Password(cfg.Password))
		}
		home, _ := os.UserHomeDir()
		for _, keyFile := range []string{
			home + "/.ssh/id_ed25519",
			home + "/.ssh/id_rsa",
			home + "/.ssh/id_ecdsa",
		} {
			if keyData, err := os.ReadFile(keyFile); err == nil {
				if signer, err := ssh.ParsePrivateKey(keyData); err == nil {
					methods = append(methods, ssh.PublicKeys(signer))
					break
				}
			}
		}
	}

	if len(methods) == 0 {
		return nil, fmt.Errorf("no auth methods available")
	}
	return methods, nil
}

// knownHostsPath returns the path to the user's known_hosts file.
func knownHostsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ssh", "known_hosts")
}

// buildHostKeyCallback creates a HostKeyCallback that verifies against known_hosts.
// If the host is unknown and TrustedFingerprint is not set, returns HostKeyUnknownError.
// If the host key changed (mismatch), returns HostKeyMismatchError.
// If TrustedFingerprint matches the server's key, accepts and writes to known_hosts.
func buildHostKeyCallback(cfg SSHConfig) (ssh.HostKeyCallback, error) {
	khPath := knownHostsPath()

	// Ensure ~/.ssh directory and known_hosts file exist
	sshDir := filepath.Dir(khPath)
	if err := os.MkdirAll(sshDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create .ssh directory: %w", err)
	}
	if _, err := os.Stat(khPath); os.IsNotExist(err) {
		if err := os.WriteFile(khPath, []byte{}, 0600); err != nil {
			return nil, fmt.Errorf("failed to create known_hosts file: %w", err)
		}
	}

	// Load existing known_hosts
	khCallback, err := knownhosts.New(khPath)
	if err != nil {
		return nil, fmt.Errorf("failed to load known_hosts: %w", err)
	}

	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		fingerprint := ssh.FingerprintSHA256(key)
		keyType := key.Type()
		_ = keyType // used only for debugging

		// Check against known_hosts
		err := khCallback(hostname, remote, key)
		if err == nil {
			// Host key matches known_hosts — all good
			return nil
		}

		// Determine if it's an unknown host or a mismatch
		var keyErr *knownhosts.KeyError
		if errors.As(err, &keyErr) {
			if len(keyErr.Want) == 0 {
				// Host not in known_hosts — unknown host
				if cfg.TrustedFingerprint != "" && subtle.ConstantTimeCompare([]byte(cfg.TrustedFingerprint), []byte(fingerprint)) == 1 {
					// User has approved this fingerprint — accept and save
					if writeErr := AppendKnownHost(khPath, cfg.Host, cfg.Port, key); writeErr != nil {
						// Log but don't fail — the connection itself is fine
						fmt.Fprintf(os.Stderr, "warning: could not write to known_hosts: %v\n", writeErr)
					}
					return nil
				}
				return &HostKeyUnknownError{
					Hostname:    hostname,
					Fingerprint: fingerprint,
					KeyType:     keyType,
				}
			}
			// Host key changed — possible MITM
			return &HostKeyMismatchError{
				Hostname:    hostname,
				Fingerprint: fingerprint,
				KeyType:     keyType,
			}
		}

		return err
	}, nil
}

// AppendKnownHost writes a host's public key to the known_hosts file.
func AppendKnownHost(khPath string, host string, port uint16, key ssh.PublicKey) error {
	addr := host
	if port != 22 {
		addr = fmt.Sprintf("[%s]:%d", host, port)
	}
	line := knownhosts.Line([]string{knownhosts.Normalize(addr)}, key)
	f, err := os.OpenFile(khPath, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if !strings.HasSuffix(line, "\n") {
		line += "\n"
	}
	_, err = f.WriteString(line)
	return err
}

// Read reads from the SSH session stdout.
func (t *SSHTerminal) Read(buf []byte) (int, error) {
	return t.stdout.Read(buf)
}

// Write writes to the SSH session stdin.
func (t *SSHTerminal) Write(data []byte) (int, error) {
	return t.stdin.Write(data)
}

// Resize sends a window change request to the SSH session.
func (t *SSHTerminal) Resize(cols, rows uint16) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	return t.session.WindowChange(int(rows), int(cols))
}

// Done returns a channel that closes when the SSH session ends.
func (t *SSHTerminal) Done() <-chan struct{} {
	return t.done
}

// Close gracefully closes the SSH session and connection.
func (t *SSHTerminal) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.closed {
		return nil
	}
	t.closed = true

	// Send exit signal
	_ = t.stdin.Close()

	// Wait briefly for graceful exit
	select {
	case <-t.done:
	case <-time.After(3 * time.Second):
	}

	_ = t.session.Close()
	return t.client.Close()
}

// SSHClient returns the underlying SSH client for SFTP usage.
func (t *SSHTerminal) SSHClient() *ssh.Client {
	return t.client
}

// monitorConnection periodically checks if the SSH connection is alive.
func (t *SSHTerminal) monitorConnection() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-t.done:
			return
		case <-ticker.C:
			t.mu.Lock()
			if t.closed {
				t.mu.Unlock()
				return
			}
			t.mu.Unlock()

			// Send keepalive
			_, _, err := t.client.SendRequest("keepalive@openssh.com", true, nil)
			if err != nil {
				if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
					continue
				}
				t.Close()
				return
			}
		}
	}
}
