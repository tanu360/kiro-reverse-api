package proxy

import (
	"kiro-proxy/db"
)

// alertDelivery is a channel's last send: when, whether it got through, the
// last HTTP status, how many attempts it took, which event, and a scrubbed
// error when it failed.
type alertDelivery struct {
	TS       int64  `json:"ts"`
	OK       bool   `json:"ok"`
	Status   int    `json:"status"`
	Attempts int    `json:"attempts"`
	Event    string `json:"event"`
	Error    string `json:"error,omitempty"`
}

// loadAlertStates reads every alert_state row. The table holds one row per
// account plus a few pool rows, so it is read whole.
func loadAlertStates() (map[string]alertState, error) {
	d, err := db.Get()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(`SELECT key, period, level, sent_at FROM alert_state`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]alertState)
	for rows.Next() {
		var key string
		var st alertState
		if err := rows.Scan(&key, &st.Period, &st.Level, &st.SentAt); err != nil {
			return nil, err
		}
		out[key] = st
	}
	return out, rows.Err()
}

// saveAlertStates writes changed rows and deletes the keys in drop, in one
// transaction.
func saveAlertStates(changed map[string]alertState, drop []string) error {
	if len(changed) == 0 && len(drop) == 0 {
		return nil
	}
	d, err := db.Get()
	if err != nil {
		return err
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for key, st := range changed {
		if _, err := tx.Exec(`INSERT INTO alert_state (key, period, level, sent_at) VALUES (?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET period = excluded.period, level = excluded.level, sent_at = excluded.sent_at`,
			key, st.Period, st.Level, st.SentAt); err != nil {
			return err
		}
	}
	for _, key := range drop {
		if _, err := tx.Exec(`DELETE FROM alert_state WHERE key = ?`, key); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// recordAlertDelivery stores a channel's last send result.
func recordAlertDelivery(channelID string, r alertDelivery) error {
	d, err := db.Get()
	if err != nil {
		return err
	}
	ok := 0
	if r.OK {
		ok = 1
	}
	_, err = d.Exec(`INSERT INTO alert_deliveries (channel_id, ts, ok, status, attempts, event, error) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(channel_id) DO UPDATE SET ts = excluded.ts, ok = excluded.ok, status = excluded.status,
  attempts = excluded.attempts, event = excluded.event, error = excluded.error`,
		channelID, r.TS, ok, r.Status, r.Attempts, r.Event, r.Error)
	return err
}

// loadAlertDeliveries reads every channel's last send result.
func loadAlertDeliveries() (map[string]alertDelivery, error) {
	d, err := db.Get()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(`SELECT channel_id, ts, ok, status, attempts, event, error FROM alert_deliveries`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]alertDelivery)
	for rows.Next() {
		var id string
		var r alertDelivery
		var ok int
		if err := rows.Scan(&id, &r.TS, &ok, &r.Status, &r.Attempts, &r.Event, &r.Error); err != nil {
			return nil, err
		}
		r.OK = ok != 0
		out[id] = r
	}
	return out, rows.Err()
}

// pruneAlertDeliveries drops the results of channels no longer in keep.
func pruneAlertDeliveries(keep map[string]bool) error {
	all, err := loadAlertDeliveries()
	if err != nil {
		return err
	}
	d, err := db.Get()
	if err != nil {
		return err
	}
	for id := range all {
		if keep[id] {
			continue
		}
		if _, err := d.Exec(`DELETE FROM alert_deliveries WHERE channel_id = ?`, id); err != nil {
			return err
		}
	}
	return nil
}
