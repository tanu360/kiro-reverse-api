//go:build unix

package proxy

import (
	"net"
	"strconv"
	"syscall"
	"testing"
)

// poolClosedPort is the address of a proxy that is down: connections to it are refused. The port
// is bound without listening, so the kernel refuses every connection and never hands the port to
// another listener while the test runs. A listener closed to free its port could see a later
// test's listener take it and answer.
func poolClosedPort(t *testing.T) string {
	t.Helper()
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { syscall.Close(fd) })
	if err := syscall.Bind(fd, &syscall.SockaddrInet4{Addr: [4]byte{127, 0, 0, 1}}); err != nil {
		t.Fatal(err)
	}
	sa, err := syscall.Getsockname(fd)
	if err != nil {
		t.Fatal(err)
	}
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(sa.(*syscall.SockaddrInet4).Port))
}
