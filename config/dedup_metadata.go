package config

import "strings"

// Notes and tags are the operator's, so neither a repeat login nor a duplicate merge loses them.

// hasAccountMetadata reports whether an account carries notes or tags.
func hasAccountMetadata(account Account) bool {
	return strings.TrimSpace(account.Notes) != "" || len(account.Tags) > 0
}

// absorbIncomingMetadata adds a repeat login's or import's tags after the stored ones and fills
// empty notes. Stored notes win, so importing one file twice never doubles them.
func absorbIncomingMetadata(dst *Account, src Account) {
	if strings.TrimSpace(dst.Notes) == "" {
		dst.Notes = NormalizeAccountNotes(src.Notes)
	}
	dst.Tags = joinAccountTags(dst.Tags, src.Tags)
}

// absorbDonorMetadata keeps a merged-away copy's notes after the keeper's (a text already there
// is not repeated) and its tags after the keeper's, within the usual limits.
func absorbDonorMetadata(keeper *Account, donor Account) {
	notes := strings.TrimSpace(donor.Notes)
	switch {
	case notes == "" || strings.Contains(keeper.Notes, notes):
	case strings.TrimSpace(keeper.Notes) == "":
		keeper.Notes = NormalizeAccountNotes(notes)
	default:
		keeper.Notes = NormalizeAccountNotes(keeper.Notes + "\n\n" + notes)
	}
	keeper.Tags = joinAccountTags(keeper.Tags, donor.Tags)
}

// joinAccountTags is first then second, normalized: case-insensitive duplicates and anything past
// MaxAccountTags drop out. Neither input is modified.
func joinAccountTags(first, second []string) []string {
	joined := make([]string, 0, len(first)+len(second))
	joined = append(append(joined, first...), second...)
	return NormalizeAccountTags(joined)
}
