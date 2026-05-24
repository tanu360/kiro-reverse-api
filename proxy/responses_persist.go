// Package proxy: persisted OpenAI Responses API state.
package proxy

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"kiro-proxy/config"

	_ "modernc.org/sqlite"
)

const responsesDBFileName = "responses.sqlite"
const responsesRetention = 30 * 24 * time.Hour

var (
	responsesDBOnce sync.Once
	responsesDB     *sql.DB
	responsesDBErr  error
)

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

func responsesDir() string {
	return filepath.Join(config.GetDataDir(), "responses")
}

func responsesDBPath() string {
	return filepath.Join(responsesDir(), responsesDBFileName)
}

func getResponsesDB() (*sql.DB, error) {
	responsesDBOnce.Do(func() {
		if err := os.MkdirAll(responsesDir(), 0700); err != nil {
			responsesDBErr = err
			return
		}
		db, err := sql.Open("sqlite", responsesDBPath())
		if err != nil {
			responsesDBErr = err
			return
		}
		db.SetMaxOpenConns(1)
		if _, err = db.Exec(`PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  previous_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT NOT NULL,
  messages_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_created_at ON responses(created_at);`); err != nil {
			_ = db.Close()
			responsesDBErr = err
			return
		}
		responsesDB = db
	})
	if responsesDBErr != nil {
		return nil, responsesDBErr
	}
	if responsesDB == nil {
		return nil, fmt.Errorf("responses database unavailable")
	}
	return responsesDB, nil
}

func closeResponsesDB() {
	if responsesDB != nil {
		_ = responsesDB.Close()
		responsesDB = nil
	}
	responsesDBOnce = sync.Once{}
	responsesDBErr = nil
}

func saveResponseState(state responseState) error {
	db, err := getResponsesDB()
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

	_, err = db.Exec(`INSERT OR REPLACE INTO responses
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
	db, err := getResponsesDB()
	if err != nil {
		return nil, err
	}

	var state responseState
	var metadataJSON, responseJSON, messagesJSON string
	err = db.QueryRow(`SELECT id, created_at, previous_id, model, status, metadata_json, response_json, messages_json
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
	db, err := getResponsesDB()
	if err != nil {
		return false, err
	}
	res, err := db.Exec(`DELETE FROM responses WHERE id = ?`, id)
	if err != nil {
		return false, err
	}
	affected, _ := res.RowsAffected()
	return affected > 0, nil
}

func pruneResponseStates(beforeUnix int64) error {
	db, err := getResponsesDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM responses WHERE created_at < ?`, beforeUnix)
	return err
}

func defaultMap(value map[string]interface{}) map[string]interface{} {
	if value == nil {
		return map[string]interface{}{}
	}
	return value
}
