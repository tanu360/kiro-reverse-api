//go:build !unix

package proxy

import (
	"net"
	"testing"
)

// poolClosedPort is the address of a proxy that is down: a port freed by closing its listener.
func poolClosedPort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}
