package config

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpdateModelMappingsRejectsInvalidEntries(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	tooMany := make([]ModelMappingRule, maxModelMappings+1)
	for i := range tooMany {
		tooMany[i] = ModelMappingRule{Key: fmt.Sprintf("alias-%d", i), Value: "claude-sonnet-5"}
	}
	cases := []struct {
		name      string
		mappings  []ModelMappingRule
		wantIndex int
	}{
		{"empty source", []ModelMappingRule{{Key: " ", Value: "claude-opus-5"}}, 0},
		{"empty target", []ModelMappingRule{{Key: "gpt-5", Value: "claude-opus-5"}, {Key: "alias", Value: ""}}, 1},
		{"whitespace in source", []ModelMappingRule{{Key: "gpt 5", Value: "claude-opus-5"}}, 0},
		{"control char in target", []ModelMappingRule{{Key: "gpt-5", Value: "claude\x00opus"}}, 0},
		{"self mapping", []ModelMappingRule{{Key: "claude-opus-5", Value: "CLAUDE-OPUS-5"}}, 0},
		{"duplicate source", []ModelMappingRule{{Key: "gpt-5", Value: "claude-opus-5"}, {Key: "GPT-5", Value: "claude-sonnet-5"}}, 1},
		{"mapping chain", []ModelMappingRule{{Key: "cursor-opus", Value: "kiro-opus"}, {Key: "kiro-opus", Value: "claude-opus-5"}}, 0},
		{"source too long", []ModelMappingRule{{Key: strings.Repeat("a", maxModelIDBytes+1), Value: "claude-opus-5"}}, 0},
		{"target too long", []ModelMappingRule{{Key: "gpt-5", Value: strings.Repeat("a", maxModelIDBytes+1)}}, 0},
		{"too many", tooMany, -1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := GetModelMappings()
			err := UpdateModelMappings(tc.mappings)
			if !errors.Is(err, ErrInvalidModelMapping) {
				t.Fatalf("expected ErrInvalidModelMapping, got %v", err)
			}
			var mappingErr *ModelMappingError
			if !errors.As(err, &mappingErr) || mappingErr.Index != tc.wantIndex {
				t.Fatalf("expected error at index %d, got %#v", tc.wantIndex, err)
			}
			if got := GetModelMappings(); len(got) != len(before) {
				t.Fatalf("a rejected save must not change mappings: before=%d after=%d", len(before), len(got))
			}
		})
	}
}

func TestUpdateModelMappingsAcceptsLimitsAndDefaults(t *testing.T) {
	if err := Init(filepath.Join(t.TempDir(), "kiro.db")); err != nil {
		t.Fatalf("init config: %v", err)
	}
	if err := UpdateModelMappings(DefaultModelMappings()); err != nil {
		t.Fatalf("defaults must stay valid: %v", err)
	}
	full := make([]ModelMappingRule, maxModelMappings)
	for i := range full {
		full[i] = ModelMappingRule{Key: fmt.Sprintf("alias-%d", i), Value: "claude-sonnet-5"}
	}
	full[0] = ModelMappingRule{Key: strings.Repeat("a", maxModelIDBytes), Value: strings.Repeat("b", maxModelIDBytes)}
	if err := UpdateModelMappings(full); err != nil {
		t.Fatalf("limits are inclusive: %v", err)
	}
	if got := len(GetModelMappings()); got != maxModelMappings {
		t.Fatalf("expected %d mappings, got %d", maxModelMappings, got)
	}
}
