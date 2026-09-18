package config

import (
	"bytes"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"kiro-proxy/logger"
)

func TestFreshAdminPasswordIsRandomPersistedAndPrintedOnce(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	var output bytes.Buffer
	logger.SetOutput(&output)
	defer logger.ResetOutput()
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatal(err)
	}
	first := GetPassword()
	if !regexp.MustCompile(`^[0-9]{8}$`).MatchString(first) {
		t.Fatal("fresh password must contain exactly eight ASCII digits")
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
	logger.SetOutput(&output)
	defer logger.ResetOutput()
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

func TestPendingLegacyAdminPasswordIsShortenedOnce(t *testing.T) {
	for _, tc := range []struct {
		name    string
		pending bool
		env     string
		shorten bool
	}{
		{"unclaimed", true, "", true},
		{"claimed", false, "", false},
		{"environment override", true, "operator-password", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ADMIN_PASSWORD", "")
			if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
				t.Fatal(err)
			}
			legacy := strings.Repeat("ab", 24)
			cfgLock.Lock()
			cfg.Password = legacy
			cfg.FirstRunPasswordPending = tc.pending
			err := saveLocked()
			cfgLock.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			t.Setenv("ADMIN_PASSWORD", tc.env)
			if err := Load(); err != nil {
				t.Fatal(err)
			}
			password := GetPassword()
			if tc.shorten {
				if !regexp.MustCompile(`^[0-9]{8}$`).MatchString(password) {
					t.Fatal("pending legacy password was not shortened")
				}
				if FirstRunPassword() != password {
					t.Fatal("shortened password unavailable on first-run page")
				}
			} else if password != legacy {
				t.Fatal("existing credential unexpectedly changed")
			}
			if err := Load(); err != nil {
				t.Fatal(err)
			}
			if GetPassword() != password {
				t.Fatal("password changed again on reload")
			}
		})
	}
}
