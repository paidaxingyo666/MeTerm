package api

import (
	"bufio"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

const (
	// PROXY v1 header: "PROXY TCP6 ffff:...:ffff ffff:...:ffff 65535 65535\r\n" max 107 bytes
	proxyHeaderMaxLen = 107
	proxyHeaderTimeout = 500 * time.Millisecond
)

// proxyProtoListener wraps net.Listener, transparently parsing PROXY protocol v1.
// Only connections from loopback are parsed to prevent external clients from spoofing headers.
type proxyProtoListener struct {
	net.Listener
}

// NewProxyProtoListener returns a listener that transparently parses PROXY protocol v1
// headers from loopback connections, overriding RemoteAddr with the real client IP.
func NewProxyProtoListener(ln net.Listener) net.Listener {
	return &proxyProtoListener{Listener: ln}
}

func (p *proxyProtoListener) Accept() (net.Conn, error) {
	conn, err := p.Listener.Accept()
	if err != nil {
		return conn, err
	}
	if !isLoopbackConn(conn) {
		return conn, nil
	}
	return newProxyConn(conn)
}

// proxyConn wraps net.Conn with an overridden RemoteAddr.
type proxyConn struct {
	net.Conn
	reader     *bufio.Reader
	remoteAddr net.Addr
}

func (c *proxyConn) Read(b []byte) (int, error) {
	return c.reader.Read(b)
}

func (c *proxyConn) RemoteAddr() net.Addr {
	if c.remoteAddr != nil {
		return c.remoteAddr
	}
	return c.Conn.RemoteAddr()
}

func newProxyConn(conn net.Conn) (net.Conn, error) {
	// Set a short deadline to prevent slow loopback connections from blocking Accept.
	// The Rust proxy writes the header immediately, so 500ms is generous.
	if tc, ok := conn.(interface{ SetReadDeadline(time.Time) error }); ok {
		tc.SetReadDeadline(time.Now().Add(proxyHeaderTimeout))
		defer tc.SetReadDeadline(time.Time{}) // clear deadline for subsequent reads
	}

	br := bufio.NewReaderSize(conn, proxyHeaderMaxLen+1)
	header, err := br.Peek(6)
	if err != nil || string(header) != "PROXY " {
		return &proxyConn{Conn: conn, reader: br}, nil
	}
	line, err := readLimitedLine(br, proxyHeaderMaxLen)
	if err != nil {
		return &proxyConn{Conn: conn, reader: br}, nil
	}
	line = strings.TrimRight(line, "\r\n")
	addr := parseProxyLine(line)
	return &proxyConn{Conn: conn, reader: br, remoteAddr: addr}, nil
}

// readLimitedLine reads up to maxLen bytes looking for '\n'.
// Prevents unbounded memory growth from a malicious client sending endless data without a newline.
func readLimitedLine(br *bufio.Reader, maxLen int) (string, error) {
	var buf []byte
	for len(buf) < maxLen {
		b, err := br.ReadByte()
		if err != nil {
			return string(buf), err
		}
		buf = append(buf, b)
		if b == '\n' {
			return string(buf), nil
		}
	}
	return string(buf), io.ErrUnexpectedEOF
}

// parseProxyLine parses "PROXY TCP4 <src_ip> <dst_ip> <src_port> <dst_port>".
func parseProxyLine(line string) net.Addr {
	parts := strings.Split(line, " ")
	if len(parts) != 6 {
		return nil
	}
	proto := parts[1]
	if proto != "TCP4" && proto != "TCP6" {
		return nil
	}
	srcIP := net.ParseIP(parts[2])
	if srcIP == nil {
		return nil
	}
	srcPort, err := strconv.Atoi(parts[4])
	if err != nil || srcPort < 0 || srcPort > 65535 {
		return nil
	}
	return &net.TCPAddr{IP: srcIP, Port: srcPort}
}

func isLoopbackConn(conn net.Conn) bool {
	addr, ok := conn.RemoteAddr().(*net.TCPAddr)
	return ok && addr.IP.IsLoopback()
}
