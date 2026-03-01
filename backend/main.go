package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/paidaxingyo666/meterm/api"
	"github.com/paidaxingyo666/meterm/session"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	port := flag.Int("port", 8080, "HTTP server port")
	bind := flag.String("bind", "127.0.0.1", "Bind address (use 0.0.0.0 for remote access)")
	ttl := flag.Duration("ttl", 5*time.Minute, "Session TTL after last client disconnects (0 = infinite)")
	grace := flag.Duration("grace", 60*time.Second, "Reconnect grace period for disconnected clients")
	ringBuffer := flag.Int("ring-buffer", 256*1024, "Ring buffer size in bytes while draining")
	logDir := flag.String("log-dir", "", "Session recording directory (empty disables recording)")
	parentPID := flag.Int("parent-pid", 0, "Parent process PID to bind lifecycle")
	verbose := flag.Bool("verbose", false, "Enable verbose debug logging")
	flag.Parse()

	api.SetVerbose(*verbose)

	token, err := api.GenerateToken()
	if err != nil {
		return fmt.Errorf("failed to generate token: %w", err)
	}

	config := session.SessionConfig{
		SessionTTL:     *ttl,
		ReconnectGrace: *grace,
		RingBufferSize: *ringBuffer,
		LogDir:         *logDir,
	}
	sm := session.NewSessionManager(config)
	defer sm.Stop()

	// Persist ban list alongside session logs (if log-dir is set)
	var banFile string
	if *logDir != "" {
		banFile = *logDir + "/banned-ips.json"
	}
	bm := api.NewBanManager(banFile)
	auth := api.NewAuthenticator(token)
	auth.SetBanManager(bm)

	mux := http.NewServeMux()
	api.RegisterRoutes(mux, sm, auth, bm, *port)

	addr := fmt.Sprintf("%s:%d", *bind, *port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	ln = api.NewProxyProtoListener(ln)
	server := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	fmt.Printf("METERM_READY token=%s\n", token)

	shutdownReason := make(chan string, 1)
	var shutdownOnce sync.Once
	requestShutdown := func(reason string) {
		shutdownOnce.Do(func() {
			shutdownReason <- reason
		})
	}

	go func() {
		log.Printf("Starting meterm server on %s", addr)
		if serveErr := server.Serve(ln); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Printf("Server error: %v", serveErr)
			requestShutdown("server_error")
		}
	}()

	sigChan := make(chan os.Signal, 1)
	registerTerminationSignals(sigChan)
	go func() {
		sig := <-sigChan
		requestShutdown(sig.String())
	}()

	trackedParentPID := os.Getppid()
	if *parentPID > 1 {
		trackedParentPID = *parentPID
	}
	if trackedParentPID > 1 {
		go monitorParent(trackedParentPID, 2*time.Second, func() {
			requestShutdown("parent_exit")
		})
	}

	reason := <-shutdownReason

	log.Printf("Shutting down server (%s)...", reason)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("Server shutdown error: %v", err)
	}
	sm.Stop()

	log.Println("Server stopped")
	return nil
}

func monitorParent(parentPID int, interval time.Duration, onExit func()) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		currentPPID := os.Getppid()
		if currentPPID != parentPID || !parentAlive(parentPID) {
			onExit()
			return
		}
	}
}

func parentAlive(pid int) bool {
	return parentProcessAlive(pid)
}
