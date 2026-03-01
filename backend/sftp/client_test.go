package sftp

import (
	"testing"
	"golang.org/x/crypto/ssh"
)

func TestNewSFTPClient(t *testing.T) {
	var sshClient *ssh.Client

	_, err := NewSFTPClient(sshClient)
	if sshClient == nil && err == nil {
		t.Error("Expected error for nil SSH client")
	}
}

// 测试 Close 幂等性
func TestSFTPClient_CloseIdempotent(t *testing.T) {
	client := &SFTPClient{}

	// 多次关闭不应该 panic
	if err := client.Close(); err != nil {
		t.Errorf("First close error: %v", err)
	}

	if err := client.Close(); err != nil {
		t.Errorf("Second close error: %v", err)
	}
}
