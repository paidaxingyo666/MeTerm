package api

import (
	"testing"
	"github.com/paidaxingyo666/meterm/protocol"
)

func TestHandleFileList(t *testing.T) {
	// 简单的结构测试
	req := protocol.FileListRequest{Path: "/test"}
	if req.Path != "/test" {
		t.Error("FileListRequest path mismatch")
	}
}
