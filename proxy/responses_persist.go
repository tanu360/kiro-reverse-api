package proxy

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"kiro-proxy/db"
)

const responsesRetention = 30 * 24 * time.Hour

type responseState struct {
	ID                 string
	CreatedAt          int64
	PreviousResponseID string
	Model              string
	Status             string
	Metadata           map[string]interface{}
	Response           map[string]interface{}
	Messages           []OpenAIMessage
}

func saveResponseState(state responseState) error {
	d, err := db.Get()
	if err != nil {
		return err
	}

	metadataJSON, err := json.Marshal(defaultMap(state.Metadata))
	if err != nil {
		return err
	}
	responseJSON, err := json.Marshal(state.Response)
	if err != nil {
		return err
	}
	messagesJSON, err := json.Marshal(state.Messages)
	if err != nil {
		return err
	}

	_, err = d.Exec(`INSERT OR REPLACE INTO responses
(id, created_at, previous_id, model, status, metadata_json, response_json, messages_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		state.ID, state.CreatedAt, state.PreviousResponseID, state.Model, state.Status,
		string(metadataJSON), string(responseJSON), string(messagesJSON))
	if err != nil {
		return err
	}
	return pruneResponseStates(time.Now().Add(-responsesRetention).Unix())
}

func loadResponseState(id string) (*responseState, error) {
	d, err := db.Get()
	if err != nil {
		return nil, err
	}

	var state responseState
	var metadataJSON, responseJSON, messagesJSON string
	err = d.QueryRow(`SELECT id, created_at, previous_id, model, status, metadata_json, response_json, messages_json
FROM responses WHERE id = ?`, id).Scan(&state.ID, &state.CreatedAt, &state.PreviousResponseID, &state.Model,
		&state.Status, &metadataJSON, &responseJSON, &messagesJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, sql.ErrNoRows
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(metadataJSON), &state.Metadata); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(responseJSON), &state.Response); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(messagesJSON), &state.Messages); err != nil {
		return nil, err
	}
	return &state, nil
}

func deleteResponseState(id string) (bool, error) {
	d, err := db.Get()
	if err != nil {
		return false, err
	}
	res, err := d.Exec(`DELETE FROM responses WHERE id = ?`, id)
	if err != nil {
		return false, err
	}
	affected, _ := res.RowsAffected()
	return affected > 0, nil
}

func pruneResponseStates(beforeUnix int64) error {
	d, err := db.Get()
	if err != nil {
		return err
	}
	_, err = d.Exec(`DELETE FROM responses WHERE created_at < ?`, beforeUnix)
	return err
}

func defaultMap(value map[string]interface{}) map[string]interface{} {
	if value == nil {
		return map[string]interface{}{}
	}
	return value
}
