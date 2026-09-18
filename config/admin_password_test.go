package config

import (
	"bytes"
	"log"
	"path/filepath"
	"strings"
	"testing"
)

func TestFreshAdminPasswordIsRandomPersistedAndPrintedOnce(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	var output bytes.Buffer
	old := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(old)
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	first := GetPassword()
	if len(first) < 32 || first == "changeme" {
		t.Fatal("fresh password is not a random credential")
	}
	if !strings.Contains(output.String(), first) {
		t.Fatal("first-run password was not disclosed")
	}
	output.Reset()
	if err := Load(); err != nil {
		t.Fatal(err)
	}
	if GetPassword() != first || output.Len() != 0 {
		t.Fatal("reload regenerated or logged password")
	}
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	if GetPassword() == first {
		t.Fatal("independent installs reused password")
	}
}

func TestFreshAdminPasswordUsesExplicitEnvironment(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "chosen-admin-password")
	var output bytes.Buffer
	old := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(old)
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	if GetPassword() != "chosen-admin-password" || output.Len() != 0 {
		t.Fatal("explicit password was ignored or disclosed")
	}
	if err := Load(); err != nil {
		t.Fatal(err)
	}
	if GetPassword() != "chosen-admin-password" {
		t.Fatal("explicit first-run password did not persist")
	}
}
