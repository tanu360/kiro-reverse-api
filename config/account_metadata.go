package config

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
)

// Limits of an account's operator metadata. The server clamps to them instead of rejecting,
// so an import never fails over a long note; the admin UI blocks over-limit input first.
const (
	MaxAccountNotesRunes = 2000
	MaxAccountTags       = 10
	MaxAccountTagRunes   = 24
)

// ErrAccountTagLimit is returned when a tag is added to an account that already has
// MaxAccountTags tags.
var ErrAccountTagLimit = fmt.Errorf("account already has %d tags", MaxAccountTags)

// errMetadataUnchanged lets an edit skip the save when it changed nothing.
var errMetadataUnchanged = errors.New("account metadata unchanged")

// NormalizeAccountNotes keeps free text the UI can show: CRLF and CR become LF, control
// characters other than newline and tab go, outer whitespace is trimmed, and the text is cut
// to MaxAccountNotesRunes runes.
func NormalizeAccountNotes(notes string) string {
	notes = strings.ReplaceAll(notes, "\r\n", "\n")
	notes = strings.ReplaceAll(notes, "\r", "\n")
	notes = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, notes)
	notes = strings.TrimSpace(notes)
	return strings.TrimSpace(truncateRunes(notes, MaxAccountNotesRunes))
}

// NormalizeAccountTag makes one short single-line label: control characters go, the tag
// separators the admin UI splits on (comma, full-width comma, enumeration comma) become
// spaces, whitespace runs collapse to one space, and the result is trimmed and cut to
// MaxAccountTagRunes runes. A stored tag never holds a separator, so editing the
// comma-separated list cannot split it.
func NormalizeAccountTag(tag string) string {
	tag = strings.Map(func(r rune) rune {
		if isAccountTagSeparator(r) {
			return ' '
		}
		if unicode.IsControl(r) && !unicode.IsSpace(r) {
			return -1
		}
		return r
	}, tag)
	tag = strings.Join(strings.Fields(tag), " ")
	return strings.TrimSpace(truncateRunes(tag, MaxAccountTagRunes))
}

// NormalizeAccountTags normalizes every tag, drops empty ones and case-insensitive duplicates
// (the first spelling wins) and keeps the first MaxAccountTags. It always returns a fresh
// slice, or nil when no tag is left, so a caller never shares a stored slice.
func NormalizeAccountTags(tags []string) []string {
	var out []string
	for _, raw := range tags {
		tag := NormalizeAccountTag(raw)
		if tag == "" || containsTagFold(out, tag) {
			continue
		}
		out = append(out, tag)
		if len(out) == MaxAccountTags {
			break
		}
	}
	return out
}

// AddAccountTag returns tags plus tag. A tag already there in any case is a no-op, and a
// full list returns ErrAccountTagLimit. tags itself is never modified.
func AddAccountTag(tags []string, tag string) ([]string, error) {
	tag = NormalizeAccountTag(tag)
	if tag == "" || containsTagFold(tags, tag) {
		return tags, nil
	}
	if len(tags) >= MaxAccountTags {
		return tags, ErrAccountTagLimit
	}
	out := make([]string, 0, len(tags)+1)
	out = append(out, tags...)
	return append(out, tag), nil
}

// RemoveAccountTag returns tags without tag, matched case-insensitively. tags itself is never
// modified.
func RemoveAccountTag(tags []string, tag string) []string {
	tag = NormalizeAccountTag(tag)
	var out []string
	for _, existing := range tags {
		if !strings.EqualFold(existing, tag) {
			out = append(out, existing)
		}
	}
	return out
}

// EditAccountMetadata reads an account's notes and tags, passes them to edit and stores what
// edit returns, normalized, all under the store's write lock, so two concurrent edits (two
// batch tag actions) never lose each other's change. The tags edit receives are a copy.
func EditAccountMetadata(id string, edit func(notes string, tags []string) (string, []string, error)) (err error) {
	defer func() {
		if errors.Is(err, errMetadataUnchanged) {
			err = nil
			return
		}
		if err == nil {
			notifyAccountsChanged(id)
		}
	}()

	if CredentialsLoaded() {
		credLock.Lock()
		defer credLock.Unlock()
		for i := range credentials {
			if credentials[i].ID == id {
				if err := applyMetadataEdit(&credentials[i], edit); err != nil {
					return err
				}
				return saveCredentialsLocked()
			}
		}
		return fmt.Errorf("account not found: %s", id)
	}

	cfgLock.Lock()
	defer cfgLock.Unlock()
	for i := range cfg.Accounts {
		if cfg.Accounts[i].ID == id {
			if err := applyMetadataEdit(&cfg.Accounts[i], edit); err != nil {
				return err
			}
			return Save()
		}
	}
	return fmt.Errorf("account not found: %s", id)
}

func applyMetadataEdit(account *Account, edit func(notes string, tags []string) (string, []string, error)) error {
	notes, tags, err := edit(account.Notes, append([]string(nil), account.Tags...))
	if err != nil {
		return err
	}
	notes = NormalizeAccountNotes(notes)
	tags = NormalizeAccountTags(tags)
	if notes == account.Notes && equalTags(tags, account.Tags) {
		return errMetadataUnchanged
	}
	account.Notes = notes
	account.Tags = tags
	return nil
}

// preserveAccountMetadata keeps the stored notes and tags: only EditAccountMetadata writes
// them, so a status update from an older snapshot (refresh, ban, failover) cannot wipe them.
func preserveAccountMetadata(account *Account, current Account) {
	account.Notes = current.Notes
	account.Tags = current.Tags
}

func normalizeAccountMetadata(account *Account) {
	account.Notes = NormalizeAccountNotes(account.Notes)
	account.Tags = NormalizeAccountTags(account.Tags)
}

// isAccountTagSeparator matches the UI's TAG_SEPARATOR (ui/src/features/accounts/account-metadata.ts).
func isAccountTagSeparator(r rune) bool {
	return r == ',' || r == '，' || r == '、'
}

func containsTagFold(tags []string, tag string) bool {
	for _, existing := range tags {
		if strings.EqualFold(existing, tag) {
			return true
		}
	}
	return false
}

func equalTags(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func truncateRunes(s string, max int) string {
	count := 0
	for i := range s {
		if count == max {
			return s[:i]
		}
		count++
	}
	return s
}
