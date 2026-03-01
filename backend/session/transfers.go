package session

import (
	"io"
	"time"
)

// UploadSession tracks an active file upload
type UploadSession struct {
	ID             uint64
	Hash           string
	TargetPath     string
	TotalSize      int64
	TempFile       string
	UploadedChunks map[int]bool
	Writer         io.WriteCloser
	LastActivity   time.Time
}

// DownloadSession tracks an active file download
type DownloadSession struct {
	ID           uint64
	SourcePath   string
	TotalSize    int64
	Sent         int64
	Reader       io.ReadCloser
	LastActivity time.Time
}
