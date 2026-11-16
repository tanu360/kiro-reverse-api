// Command kiro-tunnel puts a running Kiro Proxy on a public HTTPS link with Tailscale Funnel.
//
// Kiro Proxy downloads this helper when its "Public link" switch goes on and runs it as a child
// process, so the proxy binary itself stays small. The helper joins the user's tailnet as its own
// device (tsnet), opens a Funnel listener on :443 and forwards every request to the proxy's
// loopback tunnel listener. It reports its state to the parent as JSON lines on stdout (see
// status.go) and exits when its stdin closes, so it never outlives the proxy.
//
// Usage:
//
//	kiro-tunnel serve --dir <state dir> --hostname <device name> --target http://127.0.0.1:<port>
//	kiro-tunnel logout --dir <state dir>
//	kiro-tunnel version
//
// serve reads KIRO_TUNNEL_SECRET from the environment and sends it with every forwarded request,
// so the proxy can tell the helper's requests from any other local caller.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tailscale.com/logtail"
	"tailscale.com/tsnet"
)

// version is set at release build time with -ldflags "-X main.version=<version>".
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = runServe(os.Args[2:])
	case "logout":
		err = runLogout(os.Args[2:])
	case "version", "--version", "-version":
		fmt.Printf("kiro-tunnel %s (protocol %d)\n", version, protocolVersion)
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "kiro-tunnel: %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: kiro-tunnel serve --dir <dir> --hostname <name> --target <url> | logout --dir <dir> | version")
}

// newServer returns the tsnet node for dir. Log upload to Tailscale's log server stays off: the
// proxy's users did not sign up for it, and the helper keeps its own logs local.
func newServer(dir, hostname string, verbose bool) (*tsnet.Server, error) {
	if dir == "" {
		return nil, errors.New("--dir is required")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}
	logtail.Disable()
	quiet := func(string, ...any) {}
	srv := &tsnet.Server{Dir: dir, Hostname: hostname, Logf: quiet, UserLogf: quiet}
	if verbose {
		logger := log.New(os.Stderr, "", log.LstdFlags)
		srv.Logf = logger.Printf
		srv.UserLogf = logger.Printf
	}
	return srv, nil
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dir := fs.String("dir", "", "state directory")
	hostname := fs.String("hostname", "kiro-proxy", "device name in the tailnet")
	target := fs.String("target", "", "proxy URL to forward to, such as http://127.0.0.1:41234")
	verbose := fs.Bool("verbose", false, "log Tailscale internals to stderr")
	if err := fs.Parse(args); err != nil {
		return err
	}
	targetURL, err := url.Parse(*target)
	if err != nil || targetURL.Scheme != "http" || targetURL.Host == "" {
		return fmt.Errorf("--target must be an http:// URL, got %q", *target)
	}
	secret := os.Getenv(secretEnv)
	if secret == "" {
		return fmt.Errorf("%s is not set", secretEnv)
	}

	status := newStatusWriter(os.Stdout)
	status.emit(Status{State: stateStarting})

	srv, err := newServer(*dir, *hostname, *verbose)
	if err != nil {
		status.emit(Status{State: stateError, Error: err.Error()})
		return err
	}
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logout := make(chan struct{}, 1)
	go watchParent(os.Stdin, cancel, logout)
	go watchSignals(cancel)

	tunnel := &tunnel{srv: srv, status: status, target: targetURL, secret: secret, probe: newProber()}
	errc := make(chan error, 1)
	go func() { errc <- tunnel.run(ctx) }()

	select {
	case <-logout:
		cancel()
		<-errc
		return logoutServer(srv)
	case err := <-errc:
		if err != nil && ctx.Err() == nil {
			status.emit(Status{State: stateError, Error: err.Error()})
			return err
		}
		return nil
	}
}

// watchParent ends the helper when the proxy closes its stdin, which also happens when the
// proxy dies, and asks for a sign-out when the proxy writes "logout".
func watchParent(stdin io.Reader, cancel context.CancelFunc, logout chan<- struct{}) {
	scanner := bufio.NewScanner(stdin)
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) == "logout" {
			logout <- struct{}{}
			return
		}
	}
	cancel()
}

func watchSignals(cancel context.CancelFunc) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	<-ch
	cancel()
}

func runLogout(args []string) error {
	fs := flag.NewFlagSet("logout", flag.ContinueOnError)
	dir := fs.String("dir", "", "state directory")
	verbose := fs.Bool("verbose", false, "log Tailscale internals to stderr")
	if err := fs.Parse(args); err != nil {
		return err
	}
	srv, err := newServer(*dir, "", *verbose)
	if err != nil {
		return err
	}
	defer srv.Close()
	if err := srv.Start(); err != nil {
		return err
	}
	return logoutServer(srv)
}

// logoutServer signs the node out of the tailnet, which removes it from the user's device list.
// A node that never signed in has nothing to sign out of.
func logoutServer(srv *tsnet.Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	lc, err := srv.LocalClient()
	if err != nil {
		return err
	}
	st, err := lc.StatusWithoutPeers(ctx)
	if err == nil && (st.BackendState == "NeedsLogin" || st.BackendState == "NoState") && st.Self == nil {
		return nil
	}
	if err := lc.Logout(ctx); err != nil {
		return fmt.Errorf("sign out of Tailscale: %w", err)
	}
	return nil
}
