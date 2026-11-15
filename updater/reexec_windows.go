//go:build windows

package updater

import (
	"os"
	"os/exec"
)

// reexec starts exe as a new process with this one's arguments, environment, folder and console,
// then exits: Windows has no exec that keeps the process.
func reexec(exe string) error {
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env = os.Environ()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if wd, err := os.Getwd(); err == nil {
		cmd.Dir = wd
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	os.Exit(0)
	return nil
}
