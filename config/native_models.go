package config

import "encoding/json"

// nativeModelsKey holds the model IDs of the last models listing that succeeded. It stays
// out of the config row: config.Save snapshots a backup first, and this changes with the
// account mix, not with an admin's edit.
const nativeModelsKey = "native_models"

// LoadNativeModelIDs returns the model IDs the last successful listing saved, or nil.
func LoadNativeModelIDs() ([]string, error) {
	raw, ok, err := getSetting(nativeModelsKey)
	if err != nil || !ok {
		return nil, err
	}
	var ids []string
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return nil, err
	}
	return ids, nil
}

// SaveNativeModelIDs replaces the saved model IDs.
func SaveNativeModelIDs(ids []string) error {
	if ids == nil {
		ids = []string{}
	}
	data, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	return setSetting(nativeModelsKey, string(data))
}
