package config

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"kiro-proxy/db"
)

const (
	maxAutoKeep       = 20
	defaultManualKeep = 100
	backupFormat      = "kiro-proxy-backup"
	backupVersion     = 1
)

type BackupEntry struct {
	ID                  string `json:"id"`
	CreatedAt           int64  `json:"createdAt"`
	Kind                string `json:"kind"`
	Note                string `json:"note,omitempty"`
	File                string `json:"file"`
	Size                int64  `json:"size"`
	Sha256              string `json:"sha256"`
	AccountCnt          int    `json:"accountCnt,omitempty"`
	RestoredAccountCnt  *int   `json:"restoredAccountCnt,omitempty"`
	Version             string `json:"version,omitempty"`
	Format              string `json:"format,omitempty"`
	IncludesCredentials bool   `json:"includesCredentials,omitempty"`
}

type BackupManifest struct {
	Updated int64         `json:"updated"`
	Entries []BackupEntry `json:"entries"`
}

type BackupSchedule struct {
	Enabled bool   `json:"enabled,omitempty"`
	Cadence string `json:"cadence,omitempty"`
	Keep    int    `json:"keep,omitempty"`
	LastRun int64  `json:"lastRun,omitempty"`
}

type BackupConfig struct {
	AutoEnabled bool           `json:"autoEnabled,omitempty"`
	AutoKeep    int            `json:"autoKeep,omitempty"`
	Schedule    BackupSchedule `json:"schedule,omitzero"`
}

type backupPayload struct {
	Format            string    `json:"format"`
	Version           int       `json:"version"`
	CreatedAt         int64     `json:"createdAt"`
	Config            Config    `json:"config"`
	CredentialsLoaded bool      `json:"credentialsLoaded"`
	Credentials       []Account `json:"credentials,omitempty"`
}

type parsedBackup struct {
	config            Config
	credentialsLoaded bool
	credentials       []Account
}

var backupMu sync.Mutex

func sha8(s string) string { return s[:8] }

func makeID(now time.Time, sum string) string {
	return fmt.Sprintf("%s-%09d-%s", now.UTC().Format("20060102-150405"), now.UTC().Nanosecond(), sha8(sum))
}

func backupDataFromSnapshot(configSnapshot Config, credentialsLoaded bool, credentialsSnapshot []Account, createdAt int64) ([]byte, int, string, bool, error) {
	payload := backupPayload{
		Format:            backupFormat,
		Version:           backupVersion,
		CreatedAt:         createdAt,
		Config:            configSnapshot,
		CredentialsLoaded: credentialsLoaded,
	}
	if credentialsLoaded {
		payload.Credentials = append([]Account(nil), credentialsSnapshot...)
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return nil, 0, "", false, err
	}
	accountCnt := len(configSnapshot.Accounts)
	if credentialsLoaded {
		accountCnt = len(credentialsSnapshot)
	}
	return data, accountCnt, Version, credentialsLoaded, nil
}

func currentBackupData() ([]byte, int, string, bool, int, error) {
	cfgLock.RLock()
	if cfg == nil {
		cfgLock.RUnlock()
		return nil, 0, "", false, 0, fmt.Errorf("config not initialized")
	}
	configSnapshot := *cfg
	configSnapshot.Accounts = append([]Account(nil), cfg.Accounts...)
	if configSnapshot.Accounts == nil {
		configSnapshot.Accounts = []Account{}
	}
	configSnapshot.ApiKeys = append([]ApiKeyEntry(nil), cfg.ApiKeys...)
	configSnapshot.PromptFilterRules = append([]PromptFilterRule(nil), cfg.PromptFilterRules...)
	autoKeep := maxAutoKeep
	if cfg.Backup.AutoKeep > 0 {
		autoKeep = cfg.Backup.AutoKeep
	}
	cfgLock.RUnlock()

	credentialsLoaded, credentialsSnapshot := CredentialsSnapshot()
	data, count, version, includesCredentials, err := backupDataFromSnapshot(configSnapshot, credentialsLoaded, credentialsSnapshot, time.Now().Unix())
	return data, count, version, includesCredentials, autoKeep, err
}

func CreateBackup(kind, note string) (*BackupEntry, error) {
	data, accountCnt, version, includesCredentials, autoKeep, err := currentBackupData()
	if err != nil {
		return nil, err
	}
	backupMu.Lock()
	defer backupMu.Unlock()
	return createBackupLocked(kind, note, data, accountCnt, version, includesCredentials, autoKeep)
}

func createBackupLocked(kind, note string, srcData []byte, accountCnt int, version string, includesCredentials bool, autoKeep int) (*BackupEntry, error) {
	now := time.Now()
	sum := sha256.Sum256(srcData)
	sumHex := hex.EncodeToString(sum[:])
	id := makeID(now, sumHex)

	includesInt := 0
	if includesCredentials {
		includesInt = 1
	}

	d, err := db.Get()
	if err != nil {
		return nil, err
	}
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`INSERT INTO backup_entries
(id, created_at, kind, note, size, sha256, account_cnt, version, format, includes_credentials)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, now.Unix(), kind, note, int64(len(srcData)), sumHex, accountCnt, version, backupFormat, includesInt); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`INSERT INTO backup_blobs(id, data) VALUES(?, ?)`, id, srcData); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}

	entry := BackupEntry{
		ID:                  id,
		CreatedAt:           now.Unix(),
		Kind:                kind,
		Note:                note,
		File:                id + ".json",
		Size:                int64(len(srcData)),
		Sha256:              sumHex,
		AccountCnt:          accountCnt,
		Version:             version,
		Format:              backupFormat,
		IncludesCredentials: includesCredentials,
	}
	pruneAutoBackups(autoKeep)
	return &entry, nil
}

func setRestoredAccountCnt(id string, count int) error {
	backupMu.Lock()
	defer backupMu.Unlock()
	d, err := db.Get()
	if err != nil {
		return err
	}
	res, err := d.Exec(`UPDATE backup_entries SET restored_account_cnt=? WHERE id=?`, count, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("backup not found: %s", id)
	}
	return nil
}

func pruneAutoBackups(keep int) {
	if keep <= 0 {
		keep = maxAutoKeep
	}
	d, err := db.Get()
	if err != nil {
		return
	}
	rows, err := d.Query(`SELECT id FROM backup_entries WHERE kind='auto'
		ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`, keep)
	if err != nil {
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		_, _ = d.Exec(`DELETE FROM backup_entries WHERE id=?`, id)
	}
}

func pruneKindLocked(kind string, keep int) error {
	if keep <= 0 {
		return nil
	}
	d, err := db.Get()
	if err != nil {
		return err
	}
	rows, err := d.Query(`SELECT id FROM backup_entries WHERE kind=?
		ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`, kind, keep)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		if _, err := d.Exec(`DELETE FROM backup_entries WHERE id=?`, id); err != nil {
			return err
		}
	}
	return nil
}

func ListBackups(autoInclude bool) ([]BackupEntry, error) {
	backupMu.Lock()
	defer backupMu.Unlock()
	d, err := db.Get()
	if err != nil {
		return nil, err
	}
	q := `SELECT id, created_at, kind, note, size, sha256, account_cnt, restored_account_cnt, version, format, includes_credentials
FROM backup_entries`
	if !autoInclude {
		q += ` WHERE kind != 'auto'`
	}
	q += ` ORDER BY created_at DESC, id DESC`
	rows, err := d.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BackupEntry
	for rows.Next() {
		e, err := scanBackupEntry(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

func scanBackupEntry(rows *sql.Rows) (*BackupEntry, error) {
	var e BackupEntry
	var note sql.NullString
	var restored sql.NullInt64
	var includes int
	if err := rows.Scan(&e.ID, &e.CreatedAt, &e.Kind, &note, &e.Size, &e.Sha256, &e.AccountCnt, &restored, &e.Version, &e.Format, &includes); err != nil {
		return nil, err
	}
	if note.Valid {
		e.Note = note.String
	}
	if restored.Valid {
		v := int(restored.Int64)
		e.RestoredAccountCnt = &v
	}
	e.IncludesCredentials = includes != 0
	e.File = e.ID + ".json"
	return &e, nil
}

func FindBackup(id string) (*BackupEntry, error) {
	d, err := db.Get()
	if err != nil {
		return nil, err
	}
	row := d.QueryRow(`SELECT id, created_at, kind, note, size, sha256, account_cnt, restored_account_cnt, version, format, includes_credentials
FROM backup_entries WHERE id=?`, id)
	var e BackupEntry
	var note sql.NullString
	var restored sql.NullInt64
	var includes int
	err = row.Scan(&e.ID, &e.CreatedAt, &e.Kind, &note, &e.Size, &e.Sha256, &e.AccountCnt, &restored, &e.Version, &e.Format, &includes)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("backup not found: %s", id)
	}
	if err != nil {
		return nil, err
	}
	if note.Valid {
		e.Note = note.String
	}
	if restored.Valid {
		v := int(restored.Int64)
		e.RestoredAccountCnt = &v
	}
	e.IncludesCredentials = includes != 0
	e.File = e.ID + ".json"
	return &e, nil
}

func ReadBackupBytes(id string) (*BackupEntry, []byte, error) {
	e, err := FindBackup(id)
	if err != nil {
		return nil, nil, err
	}
	d, err := db.Get()
	if err != nil {
		return nil, nil, err
	}
	var data []byte
	if err := d.QueryRow(`SELECT data FROM backup_blobs WHERE id=?`, id).Scan(&data); err != nil {
		return nil, nil, err
	}
	return e, data, nil
}

func DeleteBackup(id string) error {
	backupMu.Lock()
	defer backupMu.Unlock()
	d, err := db.Get()
	if err != nil {
		return err
	}
	res, err := d.Exec(`DELETE FROM backup_entries WHERE id=?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("backup not found: %s", id)
	}
	return nil
}

func parseBackupData(data []byte) (*parsedBackup, error) {
	if !json.Valid(data) {
		return nil, fmt.Errorf("backup content is not valid JSON")
	}

	var envelope struct {
		Format string `json:"format"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, fmt.Errorf("backup JSON parse failed: %w", err)
	}

	if envelope.Format != backupFormat {
		return nil, fmt.Errorf("unsupported backup format: expected %s", backupFormat)
	}

	var payload backupPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, fmt.Errorf("backup envelope parse failed: %w", err)
	}
	if payload.Version != backupVersion {
		return nil, fmt.Errorf("unsupported backup version: %d", payload.Version)
	}
	if payload.Config.Accounts == nil {
		payload.Config.Accounts = []Account{}
	}
	if err := validateRestoredConfig(payload.Config); err != nil {
		return nil, err
	}
	if payload.CredentialsLoaded {
		for i, acc := range payload.Credentials {
			if acc.ID == "" {
				return nil, fmt.Errorf("credential %d missing id", i)
			}
		}
	}
	return &parsedBackup{
		config:            payload.Config,
		credentialsLoaded: payload.CredentialsLoaded,
		credentials:       append([]Account(nil), payload.Credentials...),
	}, nil
}

func validateRestoredConfig(c Config) error {
	if c.Password == "" {
		return fmt.Errorf("backup schema mismatch: missing password")
	}
	if c.Port <= 0 || c.Port > 65535 {
		return fmt.Errorf("backup schema mismatch: invalid port")
	}
	if c.Host == "" {
		return fmt.Errorf("backup schema mismatch: missing host")
	}
	if c.Accounts == nil {
		return fmt.Errorf("backup schema mismatch: missing accounts")
	}
	return nil
}

func writeRestoredConfig(parsed *parsedBackup) error {
	configData, err := json.Marshal(parsed.config)
	if err != nil {
		return err
	}
	if err := setSetting("config", string(configData)); err != nil {
		return err
	}
	if err := ReplaceCredentials(parsed.credentialsLoaded, parsed.credentials); err != nil {
		return err
	}
	return reloadFromDisk()
}

func restoredAccountCount(parsed *parsedBackup) int {
	if parsed == nil {
		return 0
	}
	if parsed.credentialsLoaded {
		return len(parsed.credentials)
	}
	return len(parsed.config.Accounts)
}

func RestoreBackup(id string) error {
	backupMu.Lock()
	target, data, err := readBackupBytesLocked(id)
	backupMu.Unlock()
	if err != nil {
		return err
	}
	parsed, err := parseBackupData(data)
	if err != nil {
		return err
	}

	preRestore, err := CreateBackup("pre-restore", "auto before restore "+target.ID)
	if err != nil {
		return fmt.Errorf("pre-restore snapshot failed: %v", err)
	}
	if err := setRestoredAccountCnt(preRestore.ID, restoredAccountCount(parsed)); err != nil {
		return fmt.Errorf("pre-restore restore count failed: %v", err)
	}
	return writeRestoredConfig(parsed)
}

func readBackupBytesLocked(id string) (*BackupEntry, []byte, error) {
	d, err := db.Get()
	if err != nil {
		return nil, nil, err
	}
	row := d.QueryRow(`SELECT id, created_at, kind, note, size, sha256, account_cnt, restored_account_cnt, version, format, includes_credentials
FROM backup_entries WHERE id=?`, id)
	var e BackupEntry
	var note sql.NullString
	var restored sql.NullInt64
	var includes int
	err = row.Scan(&e.ID, &e.CreatedAt, &e.Kind, &note, &e.Size, &e.Sha256, &e.AccountCnt, &restored, &e.Version, &e.Format, &includes)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, fmt.Errorf("backup not found: %s", id)
	}
	if err != nil {
		return nil, nil, err
	}
	if note.Valid {
		e.Note = note.String
	}
	if restored.Valid {
		v := int(restored.Int64)
		e.RestoredAccountCnt = &v
	}
	e.IncludesCredentials = includes != 0
	e.File = e.ID + ".json"

	var data []byte
	if err := d.QueryRow(`SELECT data FROM backup_blobs WHERE id=?`, id).Scan(&data); err != nil {
		return nil, nil, err
	}
	return &e, data, nil
}

func reloadFromDisk() error {
	raw, ok, err := getSetting("config")
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("config setting missing after restore")
	}
	var c Config
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return err
	}
	cfgLock.Lock()
	cfg = &c
	cfgLock.Unlock()
	return LoadCredentials()
}

func RestoreFromBytes(data []byte, note string) error {
	parsed, err := parseBackupData(data)
	if err != nil {
		return err
	}
	preRestore, err := CreateBackup("pre-restore", "upload "+note)
	if err != nil {
		return fmt.Errorf("pre-restore snapshot failed: %v", err)
	}
	if err := setRestoredAccountCnt(preRestore.ID, restoredAccountCount(parsed)); err != nil {
		return fmt.Errorf("pre-restore restore count failed: %v", err)
	}
	return writeRestoredConfig(parsed)
}

func AutoSnapshotBeforeSave() {
	if cfg == nil || !cfg.Backup.AutoEnabled {
		return
	}
	configSnapshot := *cfg
	configSnapshot.Accounts = append([]Account(nil), cfg.Accounts...)
	if configSnapshot.Accounts == nil {
		configSnapshot.Accounts = []Account{}
	}
	configSnapshot.ApiKeys = append([]ApiKeyEntry(nil), cfg.ApiKeys...)
	configSnapshot.PromptFilterRules = append([]PromptFilterRule(nil), cfg.PromptFilterRules...)
	autoKeep := cfg.Backup.AutoKeep
	credentialsLoaded, credentialsSnapshot := CredentialsSnapshot()
	data, accountCnt, version, includesCredentials, err := backupDataFromSnapshot(configSnapshot, credentialsLoaded, credentialsSnapshot, time.Now().Unix())
	if err != nil {
		return
	}

	backupMu.Lock()
	_, _ = createBackupLocked("auto", "", data, accountCnt, version, includesCredentials, autoKeep)
	backupMu.Unlock()
}

func GetBackupConfig() BackupConfig {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return cfg.Backup
}

func UpdateBackupConfig(bc BackupConfig) error {
	cfgLock.Lock()
	cfg.Backup = bc
	defer cfgLock.Unlock()
	return saveLocked()
}

func GetBackupSchedule() BackupSchedule {
	cfgLock.RLock()
	defer cfgLock.RUnlock()
	return cfg.Backup.Schedule
}

func UpdateBackupSchedule(s BackupSchedule) error {
	cfgLock.Lock()
	defer cfgLock.Unlock()
	cfg.Backup.Schedule.Enabled = s.Enabled
	cfg.Backup.Schedule.Cadence = s.Cadence
	cfg.Backup.Schedule.Keep = s.Keep
	return saveLocked()
}

func MarkScheduleRan(now int64) error {
	cfgLock.Lock()
	cfg.Backup.Schedule.LastRun = now
	defer cfgLock.Unlock()
	return saveLocked()
}

func PruneScheduled() error {
	sched := GetBackupSchedule()
	keep := 50
	if sched.Keep > 0 {
		keep = sched.Keep
	}
	backupMu.Lock()
	defer backupMu.Unlock()
	return pruneKindLocked("scheduled", keep)
}
