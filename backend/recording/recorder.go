package recording

const (
	DirInput  byte = 'i'
	DirOutput byte = 'o'
	DirResize byte = 'r'
	DirEvent  byte = 'e'
)

type LogEntry struct {
	Timestamp int64
	Direction byte
	Data      []byte
}

type Recorder interface {
	Record(entry LogEntry) error
	Close() error
}
