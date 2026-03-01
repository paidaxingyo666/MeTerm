package protocol

import "testing"

func TestFileMessageConstants(t *testing.T) {
	tests := []struct {
		name     string
		msgType  byte
		expected byte
	}{
		{"MsgFileList", MsgFileList, 0x0A},
		{"MsgFileListResp", MsgFileListResp, 0x0B},
		{"MsgFileUploadStart", MsgFileUploadStart, 0x0C},
		{"MsgFileUploadChunk", MsgFileUploadChunk, 0x0D},
		{"MsgFileDownloadStart", MsgFileDownloadStart, 0x0E},
		{"MsgFileDownloadChunk", MsgFileDownloadChunk, 0x0F},
		{"MsgFileOperation", MsgFileOperation, 0x10},
		{"MsgFileOperationResp", MsgFileOperationResp, 0x11},
		{"MsgServerInfo", MsgServerInfo, 0x12},
		{"MsgTransferProgress", MsgTransferProgress, 0x13},
		{"MsgFileUploadResume", MsgFileUploadResume, 0x14},
		{"MsgFileDownloadResume", MsgFileDownloadResume, 0x15},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.msgType != tt.expected {
				t.Errorf("%s = 0x%02X, want 0x%02X", tt.name, tt.msgType, tt.expected)
			}
		})
	}
}
