package api

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path"
	"strconv"

	"github.com/pkg/sftp"

	"github.com/paidaxingyo666/meterm/protocol"
	"github.com/paidaxingyo666/meterm/session"
)

// downloadSignal represents a flow-control command sent from the WebSocket
// message loop to an active download goroutine.
type downloadSignal int

const (
	sigDownloadPause    downloadSignal = iota // pause sending chunks
	sigDownloadContinue                       // resume sending chunks
	sigDownloadCancel                         // abort download
)

// waitDownloadCtrl checks the control channel for pause/cancel signals.
// If paused, it blocks until continue or cancel is received.
// Returns true if the download should be cancelled.
func waitDownloadCtrl(ctrl <-chan downloadSignal) bool {
	for {
		select {
		case sig := <-ctrl:
			switch sig {
			case sigDownloadCancel:
				return true
			case sigDownloadPause:
				// Block until continue or cancel
				for s := range ctrl {
					if s == sigDownloadContinue {
						return false
					}
					if s == sigDownloadCancel {
						return true
					}
				}
				// Channel closed — treat as cancel
				return true
			case sigDownloadContinue:
				return false
			}
		default:
			// No signal pending — keep going
			return false
		}
	}
}

// toFileInfo converts os.FileInfo to protocol.FileInfo, extracting SFTP owner/group
func toFileInfo(fi os.FileInfo) protocol.FileInfo {
	pf := protocol.FileInfo{
		Name:    fi.Name(),
		Size:    fi.Size(),
		Mode:    fi.Mode().String(),
		ModTime: fi.ModTime().Unix(),
		IsDir:   fi.IsDir(),
	}

	// Check for symlink
	if fi.Mode()&os.ModeSymlink != 0 {
		pf.IsLink = true
	}

	// Extract UID/GID from SFTP FileStat
	if sys := fi.Sys(); sys != nil {
		if stat, ok := sys.(*sftp.FileStat); ok {
			pf.Owner = strconv.FormatUint(uint64(stat.UID), 10)
			pf.Group = strconv.FormatUint(uint64(stat.GID), 10)
		} else {
			debugLog("[DEBUG] Sys() type is %T, not *sftp.FileStat", sys)
		}
	} else {
		debugLog("[DEBUG] Sys() returned nil for %s", fi.Name())
	}

	return pf
}

// validatePath ensures the path is safe and within allowed boundaries
func validatePath(p string) error {
	// Clean the path to resolve .. and .
	cleaned := path.Clean(p)

	// Ensure path is absolute (starts with /)
	if !path.IsAbs(cleaned) {
		return fmt.Errorf("path must be absolute")
	}

	// Check path length
	if len(cleaned) > 4096 {
		return fmt.Errorf("path too long")
	}

	// NOTE: We cannot restrict paths to a specific root directory here
	// because we don't know the user's home directory at this point.
	// The SFTP client itself enforces permissions based on SSH user's access.
	// path.Clean() already resolves ".." so checking for ".." substring is ineffective:
	//   path.Clean("/a/../../../etc/passwd") => "/etc/passwd" (no ".." in result)
	// Additional root directory checks can be added at the Session level if needed.

	return nil
}

// handleFileListWithProgress processes MsgFileList with progress updates for large directories.
// sendFn must be client.SendBlocking so writes go through WritePump (single writer invariant).
func handleFileListWithProgress(s *session.Session, sendFn func([]byte) bool, payload []byte) {
	if s.SFTPClient == nil {
		sendFn(encodeError("SFTP_NOT_AVAILABLE", "SFTP is not available for this session"))
		return
	}

	var req protocol.FileListRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		sendFn(encodeError("INVALID_REQUEST", "Failed to parse request"))
		return
	}

	// Resolve relative paths (e.g. ".") to absolute via SFTP RealPath
	// so the frontend always gets an absolute currentPath for upload/download
	resolvedPath := req.Path
	if !path.IsAbs(req.Path) {
		if absPath, err := s.SFTPClient.RealPath(req.Path); err == nil {
			resolvedPath = absPath
		}
	}

	fileInfos, err := s.SFTPClient.ListDir(req.Path)
	if err != nil {
		sendFn(encodeError("LIST_FAILED", fmt.Sprintf("Failed to list directory: %v", err)))
		return
	}

	total := len(fileInfos)
	const maxFileListEntries = 50000
	if total > maxFileListEntries {
		sendFn(encodeError("TOO_MANY_FILES", fmt.Sprintf("Directory contains too many entries (%d, limit %d)", total, maxFileListEntries)))
		return
	}
	const largeDirectoryThreshold = 100
	const batchSize = 200 // 批量大小，减少更新频率

	// For large directories, send progress updates
	if total >= largeDirectoryThreshold {
		debugLog("[DEBUG] Large directory detected (%d files), sending progress updates", total)

		if !sendProgress(sendFn, 0, total) {
			return
		}

		files := make([]protocol.FileInfo, 0, total)

		for i, fi := range fileInfos {
			files = append(files, toFileInfo(fi))

			if (i+1)%batchSize == 0 || i == total-1 {
				if !sendProgress(sendFn, i+1, total) {
					return
				}
				debugLog("[DEBUG] Progress: %d/%d files processed", i+1, total)
			}
		}

		resp := protocol.FileListResponse{
			Path:  resolvedPath,
			Files: files,
		}
		respData, _ := json.Marshal(resp)
		response := protocol.EncodeMessage(protocol.MsgFileListResp, respData)

		debugLog("[DEBUG] Sending final response, size: %d bytes", len(response))
		if !sendFn(response) {
			log.Printf("[ERROR] ❌ Failed to send file list response: client disconnected")
		}
	} else {
		// Small directory: process normally without progress updates
		debugLog("[DEBUG] Small directory (%d files), sending immediately", total)

		files := make([]protocol.FileInfo, 0, total)
		for _, fi := range fileInfos {
			files = append(files, toFileInfo(fi))
		}

		resp := protocol.FileListResponse{
			Path:  resolvedPath,
			Files: files,
		}
		respData, _ := json.Marshal(resp)
		response := protocol.EncodeMessage(protocol.MsgFileListResp, respData)

		debugLog("[DEBUG] Sending response, size: %d bytes", len(response))
		if !sendFn(response) {
			log.Printf("[ERROR] ❌ Failed to send file list response: client disconnected")
		}
	}
}

// sendProgress sends a progress update message. Returns false if client disconnected.
func sendProgress(sendFn func([]byte) bool, loaded, total int) bool {
	progress := protocol.FileListProgressResponse{
		Loaded: loaded,
		Total:  total,
	}
	progressData, _ := json.Marshal(progress)
	return sendFn(protocol.EncodeMessage(protocol.MsgFileListProgress, progressData))
}

// handleFileDownloadChunked processes MsgFileDownloadStart with chunked transfer.
// Each chunk payload: [8B total_size BE][8B offset BE][chunk_data]
// The last chunk is when offset + len(chunk_data) >= total_size.
// sendFn must be client.SendBlocking — all writes go through WritePump.
func handleFileDownloadChunked(s *session.Session, sendFn func([]byte) bool, payload []byte, ctrl <-chan downloadSignal) {
	const chunkSize = 1 * 1024 * 1024 // 1MB per chunk — larger chunks mean fewer WebSocket frames

	writeErr := func(code, message string) {
		sendFn(encodeError(code, message))
	}

	if s.SFTPClient == nil {
		writeErr("SFTP_NOT_AVAILABLE", "SFTP is not available for this session")
		return
	}

	var req protocol.FileListRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		writeErr("INVALID_REQUEST", "Failed to parse request")
		return
	}

	// Get file info
	fi, err := s.SFTPClient.Stat(req.Path)
	if err != nil {
		writeErr("READ_FAILED", fmt.Sprintf("Failed to stat file: %v", err))
		return
	}

	// Directory: compress to ZIP and send
	if fi.IsDir() {
		handleDirectoryDownloadZip(s, sendFn, req.Path, ctrl)
		return
	}

	totalSize := uint64(fi.Size())

	// Open file for reading
	file, err := s.SFTPClient.Open(req.Path)
	if err != nil {
		writeErr("READ_FAILED", fmt.Sprintf("Failed to open file: %v", err))
		return
	}
	defer file.Close()

	// Read and send in chunks
	buf := make([]byte, chunkSize)
	var offset uint64

	for offset < totalSize {
		// Check for pause/cancel signals before reading next chunk
		if shouldStop := waitDownloadCtrl(ctrl); shouldStop {
			log.Printf("[INFO] Download cancelled by client")
			return
		}

		n, readErr := file.Read(buf)
		if n > 0 {
			// Build chunk: [8B total][8B offset][data]
			chunkPayload := make([]byte, 16+n)
			binary.BigEndian.PutUint64(chunkPayload[0:8], totalSize)
			binary.BigEndian.PutUint64(chunkPayload[8:16], offset)
			copy(chunkPayload[16:], buf[:n])

			if !sendFn(protocol.EncodeMessage(protocol.MsgFileDownloadChunk, chunkPayload)) {
				log.Printf("[ERROR] Download aborted: client disconnected")
				return
			}

			offset += uint64(n)
		}
		if readErr != nil {
			if readErr == io.EOF || offset >= totalSize {
				break
			}
			writeErr("READ_FAILED", fmt.Sprintf("Failed to read file: %v", readErr))
			return
		}
	}

	// If file is empty (0 bytes), send one empty chunk so client knows download is done
	if totalSize == 0 {
		chunkPayload := make([]byte, 16)
		binary.BigEndian.PutUint64(chunkPayload[0:8], 0)
		binary.BigEndian.PutUint64(chunkPayload[8:16], 0)
		sendFn(protocol.EncodeMessage(protocol.MsgFileDownloadChunk, chunkPayload))
	}
}

// handleDirectoryDownloadZip compresses a directory into ZIP via temp file and sends via chunked protocol.
// Uses disk instead of memory to avoid OOM on large directories.
// sendFn must be client.SendBlocking — all writes go through WritePump.
func handleDirectoryDownloadZip(s *session.Session, sendFn func([]byte) bool, dirPath string, ctrl <-chan downloadSignal) {
	const chunkSize = 1 * 1024 * 1024 // 1MB per chunk

	debugLog("[DEBUG] Creating ZIP for directory: %s", dirPath)

	// Create temp file for ZIP to avoid memory buffering
	tmpFile, err := os.CreateTemp("", "meterm-zip-*.zip")
	if err != nil {
		sendFn(encodeError("READ_FAILED", "Failed to create temp file for ZIP"))
		return
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)

	// Build ZIP into temp file with resource limits
	zipWriter := zip.NewWriter(tmpFile)

	ctx := &zipBuildCtx{
		maxBytes: 10 * 1024 * 1024 * 1024, // 10GB
		maxCount: 50000,
		maxDepth: 30,
	}

	dirName := path.Base(dirPath)
	if err := walkAndZip(s, zipWriter, dirPath, dirName, ctx, 0); err != nil {
		zipWriter.Close()
		tmpFile.Close()
		sendFn(encodeError("READ_FAILED", fmt.Sprintf("Failed to create ZIP: %v", err)))
		return
	}

	if err := zipWriter.Close(); err != nil {
		tmpFile.Close()
		sendFn(encodeError("READ_FAILED", fmt.Sprintf("Failed to finalize ZIP: %v", err)))
		return
	}

	// Get ZIP size and seek to beginning for reading
	fi, err := tmpFile.Stat()
	if err != nil {
		tmpFile.Close()
		sendFn(encodeError("READ_FAILED", "Failed to stat temp ZIP file"))
		return
	}
	totalSize := uint64(fi.Size())

	if _, err := tmpFile.Seek(0, 0); err != nil {
		tmpFile.Close()
		sendFn(encodeError("READ_FAILED", "Failed to seek temp ZIP file"))
		return
	}

	debugLog("[DEBUG] ZIP created on disk, size: %d bytes, sending chunks...", totalSize)

	// Stream temp file in chunks
	buf := make([]byte, chunkSize)
	var offset uint64

	for offset < totalSize {
		if shouldStop := waitDownloadCtrl(ctrl); shouldStop {
			log.Printf("[INFO] ZIP download cancelled by client")
			tmpFile.Close()
			return
		}

		n, readErr := tmpFile.Read(buf)
		if n > 0 {
			chunkPayload := make([]byte, 16+n)
			binary.BigEndian.PutUint64(chunkPayload[0:8], totalSize)
			binary.BigEndian.PutUint64(chunkPayload[8:16], offset)
			copy(chunkPayload[16:], buf[:n])

			if !sendFn(protocol.EncodeMessage(protocol.MsgFileDownloadChunk, chunkPayload)) {
				log.Printf("[ERROR] ZIP download aborted: client disconnected")
				tmpFile.Close()
				return
			}

			offset += uint64(n)
		}
		if readErr != nil {
			if readErr == io.EOF || offset >= totalSize {
				break
			}
			log.Printf("[ERROR] Failed to read temp ZIP file: %v", readErr)
			tmpFile.Close()
			return
		}
	}

	tmpFile.Close()

	// Handle empty ZIP (shouldn't happen, but be safe)
	if totalSize == 0 {
		chunkPayload := make([]byte, 16)
		sendFn(protocol.EncodeMessage(protocol.MsgFileDownloadChunk, chunkPayload))
	}

	debugLog("[DEBUG] Directory ZIP download complete: %s (%d bytes)", dirPath, totalSize)
}

// zipBuildCtx tracks resource limits during ZIP construction to prevent DoS
type zipBuildCtx struct {
	maxBytes  int64 // maximum total uncompressed size (default 10GB)
	maxCount  int   // maximum total file count (default 50000)
	maxDepth  int   // maximum directory recursion depth (default 20)
	usedBytes int64 // current total bytes written
	count     int   // current file count
}

// walkAndZip recursively adds directory contents to a ZIP writer via SFTP
func walkAndZip(s *session.Session, zw *zip.Writer, sftpPath, zipPath string, ctx *zipBuildCtx, depth int) error {
	if depth > ctx.maxDepth {
		return fmt.Errorf("directory depth exceeds limit (%d)", ctx.maxDepth)
	}

	entries, err := s.SFTPClient.ListDir(sftpPath)
	if err != nil {
		return fmt.Errorf("failed to list %s: %w", sftpPath, err)
	}

	// Add directory entry
	if _, err := zw.Create(zipPath + "/"); err != nil {
		return fmt.Errorf("failed to create dir entry %s: %w", zipPath, err)
	}

	for _, entry := range entries {
		entryZipPath := zipPath + "/" + entry.Name()
		entrySftpPath := sftpPath + "/" + entry.Name()

		if entry.IsDir() {
			if err := walkAndZip(s, zw, entrySftpPath, entryZipPath, ctx, depth+1); err != nil {
				return err
			}
		} else {
			ctx.count++
			if ctx.count > ctx.maxCount {
				return fmt.Errorf("file count exceeds limit (%d)", ctx.maxCount)
			}

			// Create ZIP entry with file metadata
			header, err := zip.FileInfoHeader(entry)
			if err != nil {
				return fmt.Errorf("failed to create header for %s: %w", entryZipPath, err)
			}
			header.Name = entryZipPath
			header.Method = zip.Deflate

			writer, err := zw.CreateHeader(header)
			if err != nil {
				return fmt.Errorf("failed to create entry %s: %w", entryZipPath, err)
			}

			file, err := s.SFTPClient.Open(entrySftpPath)
			if err != nil {
				return fmt.Errorf("failed to open %s: %w", entrySftpPath, err)
			}

			remaining := ctx.maxBytes - ctx.usedBytes
			n, err := io.Copy(writer, io.LimitReader(file, remaining+1))
			file.Close()
			if err != nil {
				return fmt.Errorf("failed to read %s: %w", entrySftpPath, err)
			}
			ctx.usedBytes += n
			if ctx.usedBytes > ctx.maxBytes {
				return fmt.Errorf("ZIP total size exceeds limit (%d bytes)", ctx.maxBytes)
			}
		}
	}

	return nil
}

// uploadState tracks an in-progress chunked upload with streaming SFTP write.
// Each chunk is written directly to the remote file — no in-memory buffering.
// Uploads go to a .meterm.part temp file first, then rename on completion.
type uploadState struct {
	path      string
	partPath  string         // path + ".meterm.part"
	totalSize int64
	received  int64
	file      io.WriteCloser // remote SFTP file handle
}

// Close cleans up the upload state by closing the file handle.
func (u *uploadState) Close() {
	if u.file != nil {
		u.file.Close()
		u.file = nil
	}
}

// handleFileUploadStart processes MsgFileUploadStart request.
// Returns (response, uploadState). uploadState is nil for empty files or errors.
func handleFileUploadStart(s *session.Session, payload []byte) ([]byte, *uploadState) {
	if s.SFTPClient == nil {
		return encodeError("SFTP_NOT_AVAILABLE", "SFTP is not available for this session"), nil
	}

	var req struct {
		Path string `json:"path"`
		Size int64  `json:"size"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return encodeError("INVALID_REQUEST", "Failed to parse upload request"), nil
	}

	// Validate upload size (max 10GB)
	const maxUploadSize int64 = 10 * 1024 * 1024 * 1024
	if req.Size < 0 || req.Size > maxUploadSize {
		return encodeError("FILE_TOO_LARGE", fmt.Sprintf("File size exceeds maximum allowed (%d bytes)", maxUploadSize)), nil
	}

	// Validate path
	if err := validatePath(req.Path); err != nil {
		return encodeError("INVALID_PATH", "Invalid upload path"), nil
	}

	// Empty file: create immediately, no chunk phase needed
	if req.Size == 0 {
		err := s.SFTPClient.WriteFile(req.Path, bytes.NewReader([]byte{}))
		if err != nil {
			return encodeError("WRITE_FAILED", "Failed to write file"), nil
		}
		resp := map[string]bool{"success": true}
		respData, _ := json.Marshal(resp)
		return protocol.EncodeMessage(protocol.MsgFileOperationResp, respData), nil
	}

	// Open remote .part file for streaming write (atomic: rename on completion)
	partPath := req.Path + ".meterm.part"
	file, err := s.SFTPClient.Create(partPath)
	if err != nil {
		return encodeError("WRITE_FAILED", "Failed to create remote file"), nil
	}

	state := &uploadState{
		path:      req.Path,
		partPath:  partPath,
		totalSize: req.Size,
		file:      file,
	}
	return protocol.EncodeMessage(protocol.MsgFileUploadChunk, []byte{}), state
}

// handleFileUploadChunk processes MsgFileUploadChunk with chunked transfer.
// Chunk payload format: [8B totalSize BE][8B offset BE][chunk_data]
// Returns (response, updatedState). State is nil when upload completes or on error.
func handleFileUploadChunk(s *session.Session, client *session.Client, payload []byte, state *uploadState) ([]byte, *uploadState) {
	if s.SFTPClient == nil {
		return encodeError("SFTP_NOT_AVAILABLE", "SFTP is not available for this session"), nil
	}

	// Only the master can upload files
	if client.Role != session.RoleMaster {
		return encodeError("PERMISSION_DENIED", "Only master can upload files"), nil
	}

	if state == nil {
		return encodeError("INVALID_STATE", "No upload in progress"), nil
	}

	// Parse chunk: [8B totalSize][8B offset][data]
	if len(payload) < 16 {
		state.Close()
		return encodeError("INVALID_DATA", "Invalid upload chunk: too short"), nil
	}

	totalSize := int64(binary.BigEndian.Uint64(payload[0:8]))
	offset := int64(binary.BigEndian.Uint64(payload[8:16]))
	chunkData := payload[16:]

	// Validate offset matches expected position
	if offset != state.received {
		state.Close()
		return encodeError("INVALID_OFFSET", fmt.Sprintf("Expected offset %d, got %d", state.received, offset)), nil
	}

	// Validate totalSize matches
	if totalSize != state.totalSize {
		state.Close()
		return encodeError("INVALID_DATA", "Total size mismatch"), nil
	}

	// Reject chunk that would exceed declared totalSize
	if state.received+int64(len(chunkData)) > state.totalSize {
		state.Close()
		return encodeError("SIZE_EXCEEDED", "Upload data exceeds declared file size"), nil
	}

	// Stream chunk directly to remote SFTP file
	_, err := state.file.Write(chunkData)
	if err != nil {
		state.Close()
		return encodeError("WRITE_FAILED", "Failed to write chunk to remote file"), nil
	}
	state.received += int64(len(chunkData))

	// Check if upload is complete
	if state.received >= state.totalSize {
		state.Close()
		// Rename .meterm.part → final path
		// PosixRename supports atomic overwrite; fall back to Remove+Rename
		// for servers without the posix-rename@openssh.com extension.
		if state.partPath != "" {
			if err := s.SFTPClient.PosixRename(state.partPath, state.path); err != nil {
				_ = s.SFTPClient.Remove(state.path)
				if err := s.SFTPClient.Rename(state.partPath, state.path); err != nil {
					_ = s.SFTPClient.Remove(state.partPath)
					return encodeError("WRITE_FAILED", "Failed to finalize upload"), nil
				}
			}
		}
		resp := map[string]bool{"success": true}
		respData, _ := json.Marshal(resp)
		return protocol.EncodeMessage(protocol.MsgFileOperationResp, respData), nil
	}

	// More chunks expected, send ACK
	return protocol.EncodeMessage(protocol.MsgFileUploadChunk, []byte{}), state
}

// handleFileUploadResume processes MsgFileUploadResume for resuming an interrupted upload.
// Client sends JSON {path, size}. Server checks for existing .meterm.part file and returns
// the resume offset via MsgFileUploadChunk with 8-byte payload, or MsgError if no partial file.
func handleFileUploadResume(s *session.Session, payload []byte) ([]byte, *uploadState) {
	if s.SFTPClient == nil {
		return encodeError("SFTP_NOT_AVAILABLE", "SFTP is not available for this session"), nil
	}

	var req struct {
		Path string `json:"path"`
		Size int64  `json:"size"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return encodeError("INVALID_REQUEST", "Failed to parse resume request"), nil
	}

	// Validate upload size (same limit as handleFileUploadStart)
	const maxResumeUploadSize int64 = 10 * 1024 * 1024 * 1024
	if req.Size < 0 || req.Size > maxResumeUploadSize {
		return encodeError("FILE_TOO_LARGE", fmt.Sprintf("File size exceeds maximum allowed (%d bytes)", maxResumeUploadSize)), nil
	}

	if err := validatePath(req.Path); err != nil {
		return encodeError("INVALID_PATH", "Invalid upload path"), nil
	}

	partPath := req.Path + ".meterm.part"
	fi, err := s.SFTPClient.Stat(partPath)
	if err != nil {
		return encodeError("NO_PARTIAL_UPLOAD", "No partial upload found"), nil
	}

	partSize := fi.Size()
	// Part file must be smaller than declared total size
	if partSize >= req.Size {
		// Part file is already complete or larger — remove stale .part and reject
		_ = s.SFTPClient.Remove(partPath)
		return encodeError("NO_PARTIAL_UPLOAD", "Partial file is already complete or corrupted"), nil
	}

	// Open .part file for appending
	file, err := s.SFTPClient.OpenFile(partPath, os.O_WRONLY|os.O_APPEND)
	if err != nil {
		return encodeError("WRITE_FAILED", "Failed to open partial file for resume"), nil
	}

	state := &uploadState{
		path:      req.Path,
		partPath:  partPath,
		totalSize: req.Size,
		received:  partSize,
		file:      file,
	}

	// Send resume ACK: MsgFileUploadChunk with 8-byte offset payload
	offsetPayload := make([]byte, 8)
	binary.BigEndian.PutUint64(offsetPayload, uint64(partSize))
	return protocol.EncodeMessage(protocol.MsgFileUploadChunk, offsetPayload), state
}

// handleFileDownloadResume processes MsgFileDownloadResume for resuming an interrupted download.
// Client sends JSON {path, offset}. Server opens the file, seeks to offset, and sends remaining chunks.
// sendFn must be client.SendBlocking — all writes go through WritePump.
func handleFileDownloadResume(s *session.Session, sendFn func([]byte) bool, payload []byte, ctrl <-chan downloadSignal) {
	const chunkSize = 1 * 1024 * 1024 // 1MB per chunk

	writeErr := func(code, message string) {
		sendFn(encodeError(code, message))
	}

	if s.SFTPClient == nil {
		writeErr("SFTP_NOT_AVAILABLE", "SFTP is not available for this session")
		return
	}

	var req struct {
		Path   string `json:"path"`
		Offset int64  `json:"offset"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		writeErr("INVALID_REQUEST", "Failed to parse resume request")
		return
	}

	if err := validatePath(req.Path); err != nil {
		writeErr("INVALID_PATH", "Invalid download path")
		return
	}

	fi, err := s.SFTPClient.Stat(req.Path)
	if err != nil {
		writeErr("READ_FAILED", fmt.Sprintf("Failed to stat file: %v", err))
		return
	}

	if fi.IsDir() {
		writeErr("INVALID_REQUEST", "Cannot resume directory download")
		return
	}

	totalSize := uint64(fi.Size())
	resumeOffset := uint64(req.Offset)

	if resumeOffset > totalSize {
		writeErr("INVALID_OFFSET", "Resume offset exceeds file size")
		return
	}

	file, err := s.SFTPClient.Open(req.Path)
	if err != nil {
		writeErr("READ_FAILED", fmt.Sprintf("Failed to open file: %v", err))
		return
	}
	defer file.Close()

	// Seek to resume offset
	if resumeOffset > 0 {
		if _, err := file.Seek(int64(resumeOffset), io.SeekStart); err != nil {
			writeErr("READ_FAILED", fmt.Sprintf("Failed to seek file: %v", err))
			return
		}
	}

	// Send chunks from offset
	buf := make([]byte, chunkSize)
	offset := resumeOffset

	for offset < totalSize {
		if shouldStop := waitDownloadCtrl(ctrl); shouldStop {
			log.Printf("[INFO] Resume download cancelled by client")
			return
		}

		n, readErr := file.Read(buf)
		if n > 0 {
			chunkPayload := make([]byte, 16+n)
			binary.BigEndian.PutUint64(chunkPayload[0:8], totalSize)
			binary.BigEndian.PutUint64(chunkPayload[8:16], offset)
			copy(chunkPayload[16:], buf[:n])

			if !sendFn(protocol.EncodeMessage(protocol.MsgFileDownloadChunk, chunkPayload)) {
				log.Printf("[ERROR] Resume download aborted: client disconnected")
				return
			}

			offset += uint64(n)
		}
		if readErr != nil {
			if readErr == io.EOF || offset >= totalSize {
				break
			}
			writeErr("READ_FAILED", fmt.Sprintf("Failed to read file: %v", readErr))
			return
		}
	}
}

// FileOperationRequest represents a file operation request
type FileOperationRequest struct {
	Operation string `json:"operation"` // "delete", "rename", "mkdir", "touch"
	Path      string `json:"path"`
	NewPath   string `json:"new_path,omitempty"` // for rename
}

// handleFileOperation processes MsgFileOperation request
func handleFileOperation(s *session.Session, client *session.Client, payload []byte) []byte {
	if s.SFTPClient == nil {
		return encodeError("SFTP_NOT_AVAILABLE", "SFTP is not available for this session")
	}

	var req FileOperationRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		return encodeError("INVALID_REQUEST", "Failed to parse request")
	}

	// Validate paths before any operation
	if err := validatePath(req.Path); err != nil {
		return encodeError("INVALID_PATH", "Invalid path")
	}

	// stat is a read-only operation, handle it before permission check
	if req.Operation == "stat" {
		fi, err := s.SFTPClient.Stat(req.Path)
		if err != nil {
			return encodeError("NOT_FOUND", "File not found")
		}
		resp := map[string]interface{}{
			"success":   true,
			"operation": "stat",
			"exists":    true,
			"is_dir":    fi.IsDir(),
			"size":      fi.Size(),
		}
		respData, _ := json.Marshal(resp)
		return protocol.EncodeMessage(protocol.MsgFileOperationResp, respData)
	}

	// Only the master can perform mutating file operations
	if client.Role != session.RoleMaster {
		return encodeError("PERMISSION_DENIED", "Only master can modify files")
	}

	if req.Operation == "rename" && req.NewPath != "" {
		if err := validatePath(req.NewPath); err != nil {
			return encodeError("INVALID_PATH", "Invalid new path")
		}
	}

	var err error
	switch req.Operation {
	case "delete":
		err = s.SFTPClient.Remove(req.Path)
		if err != nil {
			return encodeError("DELETE_FAILED", "Failed to delete file or directory")
		}
	case "rename":
		if req.NewPath == "" {
			return encodeError("INVALID_REQUEST", "new_path is required for rename operation")
		}
		err = s.SFTPClient.Rename(req.Path, req.NewPath)
		if err != nil {
			return encodeError("RENAME_FAILED", "Failed to rename file or directory")
		}
	case "mkdir":
		err = s.SFTPClient.Mkdir(req.Path)
		if err != nil {
			return encodeError("MKDIR_FAILED", "Failed to create directory")
		}
	case "touch":
		err = s.SFTPClient.WriteFile(req.Path, bytes.NewReader([]byte{}))
		if err != nil {
			return encodeError("TOUCH_FAILED", "Failed to create file")
		}
	default:
		return encodeError("INVALID_OPERATION", "Unknown operation")
	}

	resp := map[string]interface{}{
		"success":   true,
		"operation": req.Operation,
	}
	respData, _ := json.Marshal(resp)
	return protocol.EncodeMessage(protocol.MsgFileOperationResp, respData)
}

func encodeError(code, message string) []byte {
	errResp := protocol.ErrorResponse{
		Code:    code,
		Message: message,
	}
	errData, _ := json.Marshal(errResp)
	return protocol.EncodeMessage(protocol.MsgError, errData)
}
