package recording

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"os"
	"sync"
	"time"
)

type FileRecorder struct {
	file *os.File
	bw   *bufio.Writer

	mu      sync.Mutex
	closed  bool
	closeCh chan struct{}
	wg      sync.WaitGroup
}

var _ Recorder = (*FileRecorder)(nil)

func NewFileRecorder(path string) (*FileRecorder, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, fmt.Errorf("create recorder file: %w", err)
	}

	r := &FileRecorder{
		file:    f,
		bw:      bufio.NewWriterSize(f, 64*1024),
		closeCh: make(chan struct{}),
	}

	r.wg.Add(1)
	go r.flushLoop()
	return r, nil
}

func (r *FileRecorder) Record(entry LogEntry) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.closed {
		return fmt.Errorf("recorder closed")
	}

	if err := binary.Write(r.bw, binary.LittleEndian, entry.Timestamp); err != nil {
		return err
	}
	if err := r.bw.WriteByte(entry.Direction); err != nil {
		return err
	}
	length := uint32(len(entry.Data))
	if err := binary.Write(r.bw, binary.LittleEndian, length); err != nil {
		return err
	}
	if length > 0 {
		if _, err := r.bw.Write(entry.Data); err != nil {
			return err
		}
	}

	return nil
}

func (r *FileRecorder) Close() error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	r.mu.Unlock()

	close(r.closeCh)
	r.wg.Wait()

	r.mu.Lock()
	defer r.mu.Unlock()

	flushErr := r.bw.Flush()
	closeErr := r.file.Close()
	if flushErr != nil {
		return flushErr
	}
	return closeErr
}

func (r *FileRecorder) flushLoop() {
	defer r.wg.Done()

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-r.closeCh:
			r.flush()
			return
		case <-ticker.C:
			r.flush()
		}
	}
}

func (r *FileRecorder) flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.bw != nil {
		_ = r.bw.Flush()
	}
}
