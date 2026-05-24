package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	backupDirName     = "backups"
	autoSubDirName    = ".auto"
	manifestName      = "manifest.json"
	maxAutoKeep       = 20
	defaultManualKeep = 100
	backupFormat      = "kiro-go-backup"
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
	envelope          bool
}

var (
	backupMu sync.Mutex
)

func backupDir() string {
	return filepath.Join(filepath.Dir(getConfigPath()), backupDirName)
}

func autoDir() string      { return filepath.Join(backupDir(), autoSubDirName) }
func manifestPath() string { return filepath.Join(backupDir(), manifestName) }

func ensureBackupDirs() error {
	if err := os.MkdirAll(backupDir(), 0700); err != nil {
		return err
	}
	return os.MkdirAll(autoDir(), 0700)
}

func loadManifest() (*BackupManifest, error) {
	m := &BackupManifest{}
	data, err := os.ReadFile(manifestPath())
	if err != nil {
		if os.IsNotExist(err) {
			return m, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, m); err != nil {
		return nil, err
	}
	return m, nil
}

func saveManifest(m *BackupManifest) error {
	m.Updated = time.Now().Unix()
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(manifestPath(), data, 0600)
}

func sha8(s string) string { return s[:8] }

func makeID(now time.Time, sum string) string {
	return fmt.Sprintf("%s-%s", now.UTC().Format("20060102-150405"), sha8(sum))
}

func computeSha256File(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func countFromBytes(data []byte) (accounts int, version string) {
	var payload backupPayload
	if err := json.Unmarshal(data, &payload); err == nil && payload.Format == backupFormat {
		if payload.CredentialsLoaded {
			return len(payload.Credentials), Version
		}
		return len(payload.Config.Accounts), Version
	}
	var c struct {
		Accounts []struct{} `json:"accounts"`
		Version  string     `json:"version"`
	}
	_ = json.Unmarshal(data, &c)
	return len(c.Accounts), c.Version
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
	if getConfigPath() == "" {
		return nil, fmt.Errorf("config path not initialized")
	}
	if err := ensureBackupDirs(); err != nil {
		return nil, err
	}
	now := time.Now()
	sum := sha256.Sum256(srcData)
	sumHex := hex.EncodeToString(sum[:])
	id := makeID(now, sumHex)
	fileName := "config-" + id + ".json"
	var fullPath string
	if kind == "auto" {
		fullPath = filepath.Join(autoDir(), fileName)
	} else {
		fullPath = filepath.Join(backupDir(), fileName)
	}
	if err := os.WriteFile(fullPath, srcData, 0600); err != nil {
		return nil, err
	}
	entry := BackupEntry{
		ID:                  id,
		CreatedAt:           now.Unix(),
		Kind:                kind,
		Note:                note,
		File:                relFile(kind, fileName),
		Size:                int64(len(srcData)),
		Sha256:              sumHex,
		AccountCnt:          accountCnt,
		Version:             version,
		Format:              backupFormat,
		IncludesCredentials: includesCredentials,
	}
	if kind != "auto" {
		m, err := loadManifest()
		if err != nil {
			return nil, err
		}
		m.Entries = append(m.Entries, entry)
		sort.Slice(m.Entries, func(i, j int) bool { return m.Entries[i].CreatedAt > m.Entries[j].CreatedAt })
		if err := saveManifest(m); err != nil {
			return nil, err
		}
	}
	pruneAutoBackups(autoKeep)
	return &entry, nil
}

func setRestoredAccountCnt(id string, count int) error {
	backupMu.Lock()
	defer backupMu.Unlock()
	m, err := loadManifest()
	if err != nil {
		return err
	}
	for i := range m.Entries {
		if m.Entries[i].ID == id {
			m.Entries[i].RestoredAccountCnt = &count
			return saveManifest(m)
		}
	}
	return fmt.Errorf("backup not found: %s", id)
}

func relFile(kind, fileName string) string {
	if kind == "auto" {
		return filepath.Join(autoSubDirName, fileName)
	}
	return fileName
}

func pruneAutoBackups(keep int) {
	if keep <= 0 {
		keep = maxAutoKeep
	}
	files, err := os.ReadDir(autoDir())
	if err != nil {
		return
	}
	type ent struct {
		name string
		ts   int64
	}
	var entries []ent
	for _, f := range files {
		if f.IsDir() {
			continue
		}
		info, err := f.Info()
		if err != nil {
			continue
		}
		entries = append(entries, ent{name: f.Name(), ts: info.ModTime().Unix()})
	}
	if len(entries) <= keep {
		return
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].ts > entries[j].ts })
	for _, e := range entries[keep:] {
		_ = os.Remove(filepath.Join(autoDir(), e.name))
	}
}

func pruneKindLocked(kind string, keep int) error {
	if keep <= 0 {
		return nil
	}
	m, err := loadManifest()
	if err != nil {
		return err
	}
	var kept []BackupEntry
	var ofKind []BackupEntry
	for _, e := range m.Entries {
		if e.Kind == kind {
			ofKind = append(ofKind, e)
		} else {
			kept = append(kept, e)
		}
	}
	sort.Slice(ofKind, func(i, j int) bool { return ofKind[i].CreatedAt > ofKind[j].CreatedAt })
	for i, e := range ofKind {
		if i < keep {
			kept = append(kept, e)
		} else {
			_ = os.Remove(filepath.Join(backupDir(), e.File))
		}
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].CreatedAt > kept[j].CreatedAt })
	m.Entries = kept
	return saveManifest(m)
}

func ListBackups(autoInclude bool) ([]BackupEntry, error) {
	backupMu.Lock()
	defer backupMu.Unlock()
	if err := ensureBackupDirs(); err != nil {
		return nil, err
	}
	m, err := loadManifest()
	if err != nil {
		return nil, err
	}
	out := append([]BackupEntry(nil), m.Entries...)
	if autoInclude {
		auto, err := scanAuto()
		if err == nil {
			out = append(out, auto...)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

func scanAuto() ([]BackupEntry, error) {
	files, err := os.ReadDir(autoDir())
	if err != nil {
		return nil, err
	}
	var out []BackupEntry
	for _, f := range files {
		if f.IsDir() {
			continue
		}
		fullPath := filepath.Join(autoDir(), f.Name())
		sum, size, err := computeSha256File(fullPath)
		if err != nil {
			continue
		}
		info, err := f.Info()
		if err != nil {
			continue
		}
		id := info.ModTime().UTC().Format("20060102-150405") + "-" + sha8(sum)
		out = append(out, BackupEntry{
			ID:        id,
			CreatedAt: info.ModTime().Unix(),
			Kind:      "auto",
			File:      filepath.Join(autoSubDirName, f.Name()),
			Size:      size,
			Sha256:    sum,
		})
	}
	return out, nil
}

func FindBackup(id string) (*BackupEntry, error) {
	all, err := ListBackups(true)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, fmt.Errorf("backup not found: %s", id)
}

func ReadBackupBytes(id string) (*BackupEntry, []byte, error) {
	e, err := FindBackup(id)
	if err != nil {
		return nil, nil, err
	}
	data, err := os.ReadFile(filepath.Join(backupDir(), e.File))
	if err != nil {
		return nil, nil, err
	}
	return e, data, nil
}

func DeleteBackup(id string) error {
	backupMu.Lock()
	defer backupMu.Unlock()
	m, err := loadManifest()
	if err != nil {
		return err
	}
	idx := -1
	var target BackupEntry
	for i, e := range m.Entries {
		if e.ID == id {
			idx = i
			target = e
			break
		}
	}
	if idx < 0 {

		auto, _ := scanAuto()
		for _, e := range auto {
			if e.ID == id {
				return os.Remove(filepath.Join(backupDir(), e.File))
			}
		}
		return fmt.Errorf("backup not found: %s", id)
	}
	if err := os.Remove(filepath.Join(backupDir(), target.File)); err != nil && !os.IsNotExist(err) {
		return err
	}
	m.Entries = append(m.Entries[:idx], m.Entries[idx+1:]...)
	return saveManifest(m)
}

func parseBackupData(data []byte, rejectLegacyWhenCredentialsLoaded bool) (*parsedBackup, error) {
	if !json.Valid(data) {
		return nil, fmt.Errorf("backup content is not valid JSON")
	}

	var envelope struct {
		Format string `json:"format"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, fmt.Errorf("backup JSON parse failed: %w", err)
	}

	if envelope.Format == backupFormat {
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
			envelope:          true,
		}, nil
	}

	var legacy Config
	if err := json.Unmarshal(data, &legacy); err != nil {
		return nil, fmt.Errorf("backup schema mismatch: %w", err)
	}
	if err := validateRestoredConfig(legacy); err != nil {
		return nil, err
	}
	if rejectLegacyWhenCredentialsLoaded && CredentialsLoaded() {
		return nil, fmt.Errorf("legacy config-only backup does not include credentials.json; use a full kiro-go backup")
	}
	return &parsedBackup{config: legacy}, nil
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
	configData, err := json.MarshalIndent(parsed.config, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(getConfigPath(), configData, 0600); err != nil {
		return err
	}
	if parsed.envelope {
		if err := ReplaceCredentials(parsed.credentialsLoaded, parsed.credentials); err != nil {
			return err
		}
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
	parsed, err := parseBackupData(data, true)
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

	m, err := loadManifest()
	if err != nil {
		return nil, nil, err
	}
	for _, e := range m.Entries {
		if e.ID == id {
			data, err := os.ReadFile(filepath.Join(backupDir(), e.File))
			if err != nil {
				return nil, nil, err
			}
			return &e, data, nil
		}
	}

	auto, _ := scanAuto()
	for _, e := range auto {
		if e.ID == id {
			data, err := os.ReadFile(filepath.Join(backupDir(), e.File))
			if err != nil {
				return nil, nil, err
			}
			return &e, data, nil
		}
	}
	return nil, nil, fmt.Errorf("backup not found: %s", id)
}

func reloadFromDisk() error {
	data, err := os.ReadFile(getConfigPath())
	if err != nil {
		return err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return err
	}
	cfgLock.Lock()
	cfg = &c
	cfgLock.Unlock()
	return LoadCredentials()
}

func RestoreFromBytes(data []byte, note string) error {
	parsed, err := parseBackupData(data, true)
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
	return Save()
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
	return Save()
}

func MarkScheduleRan(now int64) error {
	cfgLock.Lock()
	cfg.Backup.Schedule.LastRun = now
	defer cfgLock.Unlock()
	return saveConfigFile()
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
