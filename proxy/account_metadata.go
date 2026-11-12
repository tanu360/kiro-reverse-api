package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"kiro-proxy/config"
)

// accountStatusTagLimit marks a batch addTag row whose account already has the most tags.
const accountStatusTagLimit = "tag_limit"

var errInvalidMetadata = errors.New("notes must be a string and tags an array of strings")

// metadataPatch is the notes and tags part of PUT /accounts/{id}. A key left out of the
// request keeps the stored value; null or an empty array clears it.
type metadataPatch struct {
	notes    string
	tags     []string
	hasNotes bool
	hasTags  bool
}

// parseMetadataPatch reads `notes` and `tags` from a decoded PUT body. A wrong type returns
// errInvalidMetadata before anything is written.
func parseMetadataPatch(updates map[string]interface{}) (metadataPatch, error) {
	var patch metadataPatch
	if raw, ok := updates["notes"]; ok {
		patch.hasNotes = true
		switch v := raw.(type) {
		case nil:
		case string:
			patch.notes = v
		default:
			return metadataPatch{}, errInvalidMetadata
		}
	}
	if raw, ok := updates["tags"]; ok {
		patch.hasTags = true
		switch v := raw.(type) {
		case nil:
		case []interface{}:
			for _, item := range v {
				tag, ok := item.(string)
				if !ok {
					return metadataPatch{}, errInvalidMetadata
				}
				patch.tags = append(patch.tags, tag)
			}
		default:
			return metadataPatch{}, errInvalidMetadata
		}
	}
	return patch, nil
}

// apply stores the patch through config.EditAccountMetadata; an empty patch writes nothing.
func (p metadataPatch) apply(id string) error {
	if !p.hasNotes && !p.hasTags {
		return nil
	}
	return config.EditAccountMetadata(id, func(notes string, tags []string) (string, []string, error) {
		if p.hasNotes {
			notes = p.notes
		}
		if p.hasTags {
			tags = p.tags
		}
		return notes, tags, nil
	})
}

// batchTags adds or removes one tag on every requested account. A remove where the account has
// no such tag counts as done; an add to an account with the most tags fails that row only.
func (h *Handler) batchTags(w http.ResponseWriter, ids []string, add bool, rawTag string) {
	tag := config.NormalizeAccountTag(rawTag)
	if tag == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "tag is required"})
		return
	}
	matched, slots, results := matchAccounts(ids)
	for i, a := range matched {
		res := &results[slots[i]]
		err := config.EditAccountMetadata(a.ID, func(notes string, tags []string) (string, []string, error) {
			if !add {
				return notes, config.RemoveAccountTag(tags, tag), nil
			}
			next, err := config.AddAccountTag(tags, tag)
			return notes, next, err
		})
		switch {
		case errors.Is(err, config.ErrAccountTagLimit):
			res.Error = fmt.Sprintf("Account already has %d tags", config.MaxAccountTags)
			res.Status = accountStatusTagLimit
		case err != nil:
			res.fail(err)
		default:
			res.OK = true
		}
	}
	count, failed := countResults(results)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"count":   count,
		"failed":  failed,
		"results": results,
	})
}

// exportTagObjects is the export's top-level tag list in the Kiro Account Manager shape. Each
// account's `tags` holds tag ids, and a tag's id is its name. Every exact spelling gets its
// own entry, so each account's ids resolve even when two accounts spell a tag in different
// cases. Sorted case-insensitively, then by spelling.
func exportTagObjects(accounts []config.Account) []interface{} {
	seen := make(map[string]bool)
	var names []string
	for _, a := range accounts {
		for _, tag := range a.Tags {
			if tag == "" || seen[tag] {
				continue
			}
			seen[tag] = true
			names = append(names, tag)
		}
	}
	sort.Slice(names, func(i, j int) bool {
		li, lj := strings.ToLower(names[i]), strings.ToLower(names[j])
		if li != lj {
			return li < lj
		}
		return names[i] < names[j]
	})
	out := make([]interface{}, 0, len(names))
	for _, name := range names {
		out = append(out, map[string]string{"id": name, "name": name})
	}
	return out
}

// tagsOrEmpty keeps `tags` an array in JSON, never null.
func tagsOrEmpty(tags []string) []string {
	if tags == nil {
		return []string{}
	}
	return tags
}
