package terminal

// Terminal defines the PTY abstraction used by sessions.
//
// Contract:
//   - Close must eventually close Done.
//   - After Close, Read should return an error promptly.
type Terminal interface {
	Read(buf []byte) (int, error)
	Write(data []byte) (int, error)
	Resize(cols, rows uint16) error
	Done() <-chan struct{}
	Close() error
}
