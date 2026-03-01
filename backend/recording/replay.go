package recording

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

type ReplayReader struct {
	file *os.File
	r    *bufio.Reader
}

func NewReplayReader(path string) (*ReplayReader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open replay file: %w", err)
	}

	return &ReplayReader{
		file: f,
		r:    bufio.NewReaderSize(f, 64*1024),
	}, nil
}

func (r *ReplayReader) Next() (LogEntry, error) {
	var ts int64
	if err := binary.Read(r.r, binary.LittleEndian, &ts); err != nil {
		if err == io.EOF {
			return LogEntry{}, io.EOF
		}
		return LogEntry{}, err
	}

	dir, err := r.r.ReadByte()
	if err != nil {
		if err == io.EOF {
			return LogEntry{}, io.EOF
		}
		return LogEntry{}, err
	}

	var length uint32
	if err := binary.Read(r.r, binary.LittleEndian, &length); err != nil {
		if err == io.EOF {
			return LogEntry{}, io.EOF
		}
		return LogEntry{}, err
	}

	data := make([]byte, length)
	if length > 0 {
		if _, err := io.ReadFull(r.r, data); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return LogEntry{}, io.EOF
			}
			return LogEntry{}, err
		}
	}

	return LogEntry{
		Timestamp: ts,
		Direction: dir,
		Data:      data,
	}, nil
}

func (r *ReplayReader) Close() error {
	if r.file == nil {
		return nil
	}
	err := r.file.Close()
	r.file = nil
	return err
}
