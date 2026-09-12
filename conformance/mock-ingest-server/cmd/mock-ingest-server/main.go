// Command mock-ingest-server runs the local shared-conformance ingest mock.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cekataiofficial/cekat-event-sdk/conformance/mock-ingest-server/internal/server"
	"github.com/cekataiofficial/cekat-event-sdk/conformance/mock-ingest-server/internal/state"
)

const shutdownTimeout = 5 * time.Second

type readiness struct {
	BaseURL    string `json:"base_url"`
	ControlURL string `json:"control_url"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, stdout, stderr *os.File) int {
	flags := flag.NewFlagSet("mock-ingest-server", flag.ContinueOnError)
	flags.SetOutput(stderr)
	listenAddress := flags.String("listen", "127.0.0.1:0", "TCP address to listen on")
	if err := flags.Parse(arguments); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(stderr, "mock-ingest-server: positional arguments are not supported")
		flags.Usage()
		return 2
	}

	listener, err := net.Listen("tcp", *listenAddress)
	if err != nil {
		fmt.Fprintf(stderr, "mock-ingest-server: listen on %q: %v\n", *listenAddress, err)
		return 1
	}
	defer listener.Close()

	httpServer := &http.Server{Handler: server.New(state.New())}
	signalContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	serveResult := make(chan error, 1)
	go func() { serveResult <- httpServer.Serve(listener) }()

	origin := "http://" + listener.Addr().String()
	if err := json.NewEncoder(stdout).Encode(readiness{BaseURL: origin, ControlURL: origin}); err != nil {
		fmt.Fprintf(stderr, "mock-ingest-server: write readiness: %v\n", err)
		return 1
	}

	select {
	case err := <-serveResult:
		if err == nil || errors.Is(err, http.ErrServerClosed) {
			return 0
		}
		fmt.Fprintf(stderr, "mock-ingest-server: serve: %v\n", err)
		return 1
	case <-signalContext.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		shutdownErr := httpServer.Shutdown(shutdownContext)
		cancel()
		if shutdownErr != nil {
			if !errors.Is(shutdownErr, context.DeadlineExceeded) {
				fmt.Fprintf(stderr, "mock-ingest-server: shutdown: %v\n", shutdownErr)
				return 1
			}
			// Shutdown does not cancel active request contexts. Close them after the
			// graceful bound so signal-driven termination remains bounded and clean.
			if err := httpServer.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				fmt.Fprintf(stderr, "mock-ingest-server: close: %v\n", err)
				return 1
			}
		}
		if err := <-serveResult; err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintf(stderr, "mock-ingest-server: serve: %v\n", err)
			return 1
		}
		return 0
	}
}
