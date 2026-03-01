package recording

import (
	"encoding/binary"
	"time"

	"github.com/paidaxingyo666/meterm/terminal"
)

type RecordingTerminal struct {
	inner terminal.Terminal
	rec   Recorder
}

var _ terminal.Terminal = (*RecordingTerminal)(nil)

func NewRecordingTerminal(inner terminal.Terminal, rec Recorder) *RecordingTerminal {
	return &RecordingTerminal{inner: inner, rec: rec}
}

func (t *RecordingTerminal) Read(buf []byte) (int, error) {
	n, err := t.inner.Read(buf)
	if n > 0 && t.rec != nil {
		cp := make([]byte, n)
		copy(cp, buf[:n])
		_ = t.rec.Record(LogEntry{
			Timestamp: time.Now().UnixMicro(),
			Direction: DirOutput,
			Data:      cp,
		})
	}
	return n, err
}

func (t *RecordingTerminal) Write(data []byte) (int, error) {
	if t.rec != nil {
		cp := make([]byte, len(data))
		copy(cp, data)
		_ = t.rec.Record(LogEntry{
			Timestamp: time.Now().UnixMicro(),
			Direction: DirInput,
			Data:      cp,
		})
	}
	return t.inner.Write(data)
}

func (t *RecordingTerminal) Resize(cols, rows uint16) error {
	if t.rec != nil {
		data := make([]byte, 4)
		binary.BigEndian.PutUint16(data[0:2], cols)
		binary.BigEndian.PutUint16(data[2:4], rows)
		_ = t.rec.Record(LogEntry{
			Timestamp: time.Now().UnixMicro(),
			Direction: DirResize,
			Data:      data,
		})
	}
	return t.inner.Resize(cols, rows)
}

func (t *RecordingTerminal) Done() <-chan struct{} {
	return t.inner.Done()
}

func (t *RecordingTerminal) Close() error {
	return t.inner.Close()
}
