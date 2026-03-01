package sftp

import (
	"fmt"
	"io"
	"os"
	"sync/atomic"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// SFTPClient wraps an SFTP client
// Note: sftp.Client is already thread-safe, no additional locking needed
type SFTPClient struct {
	sshClient *ssh.Client
	sftp      *sftp.Client
	closed    atomic.Bool
}

// NewSFTPClient creates an SFTP client from an existing SSH connection
func NewSFTPClient(sshClient *ssh.Client) (*SFTPClient, error) {
	if sshClient == nil {
		return nil, fmt.Errorf("ssh client is nil")
	}

	sftpClient, err := sftp.NewClient(sshClient,
		// Allow multiple in-flight SFTP write requests instead of waiting for
		// each ACK sequentially. Critical for upload throughput on high-latency links.
		sftp.UseConcurrentWrites(true),
		// Allow multiple in-flight SFTP read requests (default is already true,
		// but set explicitly to document the intent).
		sftp.UseConcurrentReads(true),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create SFTP client: %w", err)
	}

	return &SFTPClient{
		sshClient: sshClient,
		sftp:      sftpClient,
	}, nil
}

// ListDir lists files in a directory
func (c *SFTPClient) ListDir(path string) ([]os.FileInfo, error) {
	if c.closed.Load() {
		return nil, fmt.Errorf("client is closed")
	}
	return c.sftp.ReadDir(path)
}

// ReadFile reads the entire file content
func (c *SFTPClient) ReadFile(path string) ([]byte, error) {
	if c.closed.Load() {
		return nil, fmt.Errorf("client is closed")
	}

	file, err := c.sftp.Open(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open file: %w", err)
	}
	defer file.Close()

	return io.ReadAll(file)
}

// WriteFile creates or overwrites a file
func (c *SFTPClient) WriteFile(path string, reader io.Reader) error {
	if c.closed.Load() {
		return fmt.Errorf("client is closed")
	}

	file, err := c.sftp.Create(path)
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}
	defer file.Close()

	_, err = io.Copy(file, reader)
	if err != nil {
		return fmt.Errorf("failed to write file %s: %w", path, err)
	}
	return nil
}

// Remove deletes a file or empty directory
func (c *SFTPClient) Remove(path string) error {
	if c.closed.Load() {
		return fmt.Errorf("client is closed")
	}
	return c.sftp.Remove(path)
}

// Rename renames a file
func (c *SFTPClient) Rename(oldPath, newPath string) error {
	if c.closed.Load() {
		return fmt.Errorf("client is closed")
	}
	return c.sftp.Rename(oldPath, newPath)
}

// PosixRename renames a file using posix-rename@openssh.com extension.
// Unlike Rename, this supports atomic overwrite of the destination.
func (c *SFTPClient) PosixRename(oldPath, newPath string) error {
	if c.closed.Load() {
		return fmt.Errorf("client is closed")
	}
	return c.sftp.PosixRename(oldPath, newPath)
}

// Mkdir creates a directory
func (c *SFTPClient) Mkdir(path string) error {
	if c.closed.Load() {
		return fmt.Errorf("client is closed")
	}
	return c.sftp.Mkdir(path)
}

// Create creates or truncates a remote file for writing
func (c *SFTPClient) Create(path string) (*sftp.File, error) {
	if c.closed.Load() {
		return nil, fmt.Errorf("client is closed")
	}
	return c.sftp.Create(path)
}

// Open opens a remote file for reading
func (c *SFTPClient) Open(path string) (*sftp.File, error) {
	if c.closed.Load() {
		return nil, fmt.Errorf("client is closed")
	}
	return c.sftp.Open(path)
}

// OpenFile opens a remote file with the specified flags (e.g. os.O_WRONLY|os.O_APPEND)
func (c *SFTPClient) OpenFile(path string, f int) (*sftp.File, error) {
	if c.closed.Load() {
		return nil, fmt.Errorf("client is closed")
	}
	return c.sftp.OpenFile(path, f)
}

// Stat returns file information
func (c *SFTPClient) Stat(path string) (os.FileInfo, error) {
	if c.closed.Load() {
		return nil, fmt.Errorf("client is closed")
	}
	fi, err := c.sftp.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("failed to stat %s: %w", path, err)
	}
	return fi, nil
}

// SSHClient returns the underlying SSH client for exec usage.
func (c *SFTPClient) SSHClient() *ssh.Client {
	return c.sshClient
}

// Close closes the SFTP client (idempotent)
func (c *SFTPClient) Close() error {
	if c.closed.Swap(true) {
		return nil // Already closed
	}

	if c.sftp != nil {
		return c.sftp.Close()
	}
	return nil
}
