//go:build !windows

package updater

import (
	"os"
	"syscall"
)

// reexec replaces this process with exe. The process ID stays the same, so systemd, a shell or
// any other supervisor keeps tracking the server. It returns only on failure.
func reexec(exe string) error {
	return syscall.Exec(exe, os.Args, os.Environ())
}
