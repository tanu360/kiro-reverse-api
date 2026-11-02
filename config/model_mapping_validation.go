package config

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
)

const (
	maxModelMappings = 200
	maxModelIDBytes  = 256
)

var ErrInvalidModelMapping = errors.New("invalid model mapping")

// ModelMappingError names the rejected entry; Index is -1 when the list as a whole is invalid.
type ModelMappingError struct {
	Index  int
	Reason string
}

func (e *ModelMappingError) Error() string { return e.Reason }

func (e *ModelMappingError) Unwrap() error { return ErrInvalidModelMapping }

func invalidModelMapping(index int, format string, args ...interface{}) error {
	return &ModelMappingError{Index: index, Reason: fmt.Sprintf(format, args...)}
}

func normalizeModelMappings(mappings []ModelMappingRule) ([]ModelMappingRule, error) {
	if len(mappings) > maxModelMappings {
		return nil, invalidModelMapping(-1, "at most %d model mappings are allowed", maxModelMappings)
	}
	cleaned := make([]ModelMappingRule, 0, len(mappings))
	for i, mapping := range mappings {
		key := strings.ToLower(strings.TrimSpace(mapping.Key))
		value := strings.TrimSpace(mapping.Value)
		switch {
		case key == "" && value == "":
			return nil, invalidModelMapping(i, "model mapping %d is empty", i+1)
		case key == "":
			return nil, invalidModelMapping(i, "mapping to %q has no source model", value)
		case value == "":
			return nil, invalidModelMapping(i, "mapping %q has no target model", key)
		}
		for _, id := range []string{key, value} {
			if err := validateModelMappingID(id); err != "" {
				return nil, invalidModelMapping(i, "%s", err)
			}
		}
		if strings.EqualFold(key, value) {
			return nil, invalidModelMapping(i, "mapping %q points to itself", key)
		}
		for _, previous := range cleaned {
			if strings.EqualFold(previous.Key, key) {
				return nil, invalidModelMapping(i, "source %q is mapped more than once", key)
			}
		}
		cleaned = append(cleaned, ModelMappingRule{Key: key, Value: value})
	}
	//! Mappings resolve in one hop, so a target that is itself a source would silently never be followed.
	for i, mapping := range cleaned {
		for _, other := range cleaned {
			if strings.EqualFold(other.Key, mapping.Value) {
				return nil, invalidModelMapping(i, "target %q is also a mapping source; mappings resolve in one hop", mapping.Value)
			}
		}
	}
	return cleaned, nil
}

func validateModelMappingID(id string) string {
	if len(id) > maxModelIDBytes {
		return fmt.Sprintf("model ID %q... is longer than %d bytes", id[:32], maxModelIDBytes)
	}
	for _, r := range id {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return fmt.Sprintf("model ID %q contains whitespace or control characters", id)
		}
	}
	return ""
}
