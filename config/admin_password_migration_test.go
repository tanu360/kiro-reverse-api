package config

import (
	"bytes"
	"log"
	"path/filepath"
	"strings"
	"testing"
)

func seedStoredPassword(t *testing.T, password string) {
	t.Helper()
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.Password = password
	if err := saveLocked(); err != nil {
		t.Fatal(err)
	}
}

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var output bytes.Buffer
	old := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(old) })
	return &output
}

func TestShippedDefaultPasswordIsRotatedOnUpgrade(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	seedStoredPassword(t, "changeme")

	output := captureLog(t)
	if err := Load(); err != nil {
		t.Fatal(err)
	}

	rotated := GetPassword()
	if rotated == "changeme" {
		t.Fatal("upgrade kept the shipped default password")
	}
	if len(rotated) < 32 {
		t.Fatalf("rotated password is not a random credential: %d chars", len(rotated))
	}
	if !AdminPasswordRotated() {
		t.Fatal("rotation was not reported to the UI")
	}
	if !strings.Contains(output.String(), rotated) {
		t.Fatal("rotated password was never disclosed to the operator")
	}

	output.Reset()
	if err := Load(); err != nil {
		t.Fatal(err)
	}
	if GetPassword() != rotated {
		t.Fatal("a second boot rotated an already strong password")
	}
	if AdminPasswordRotated() || output.Len() != 0 {
		t.Fatal("a second boot re-reported the rotation")
	}
}

func TestOperatorChosenShortPasswordIsWarnedNotRotated(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	seedStoredPassword(t, "hunter2")

	output := captureLog(t)
	if err := Load(); err != nil {
		t.Fatal(err)
	}

	//! Rotating a credential the operator picked would lock them out of their own install.
	if GetPassword() != "hunter2" {
		t.Fatal("an operator-chosen password was rotated away")
	}
	if AdminPasswordRotated() {
		t.Fatal("an operator-chosen password was reported as rotated")
	}
	if !AdminPasswordWeak() {
		t.Fatal("a short password did not raise the weak-credential warning")
	}
	if output.Len() != 0 {
		t.Fatal("an operator-chosen password was written to the log")
	}
}

func TestExplicitEnvPasswordSuppressesRotation(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	seedStoredPassword(t, "changeme")

	t.Setenv("ADMIN_PASSWORD", "operator-supplied-password")
	output := captureLog(t)
	if err := Load(); err != nil {
		t.Fatal(err)
	}

	//! main applies ADMIN_PASSWORD after Load, so rotating here would fight the operator.
	if GetPassword() != "changeme" {
		t.Fatal("rotation ran even though ADMIN_PASSWORD was set")
	}
	if AdminPasswordRotated() || output.Len() != 0 {
		t.Fatal("rotation was reported even though ADMIN_PASSWORD was set")
	}
}

func TestStrongPasswordIsNeitherRotatedNorFlagged(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	strong := GetPassword()
	if err := Load(); err != nil {
		t.Fatal(err)
	}
	if GetPassword() != strong {
		t.Fatal("a generated password was rotated on the next boot")
	}
	if AdminPasswordRotated() || AdminPasswordWeak() {
		t.Fatal("a generated password was flagged")
	}
}
