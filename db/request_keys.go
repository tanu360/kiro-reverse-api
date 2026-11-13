package db

// MaskRequestKeys masks the client keys that versions before 3.3.0 stored in full
// in requests.api_key. keys maps the raw value of each configured client key to
// its id. A row with no key id that names one of these values gets that id
// first, so usage by key still counts the row under its key once the value is
// masked. The mask is config.MaskApiKey's, counted in bytes like Go: a value of
// 10 bytes or fewer becomes "****", a longer one keeps its first 6 and last 4
// bytes around "****". A masked value is left alone, so a second run changes
// nothing. It returns the number of rows it masked.
func MaskRequestKeys(keys map[string]string) (int64, error) {
	d, err := Get()
	if err != nil {
		return 0, err
	}
	tx, err := d.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	for raw, id := range keys {
		if raw == "" || id == "" {
			continue
		}
		if _, err := tx.Exec(`UPDATE requests SET api_key_id = ? WHERE api_key_id = '' AND api_key = ?`, id, raw); err != nil {
			return 0, err
		}
	}
	res, err := tx.Exec(`UPDATE requests SET api_key = CASE
 WHEN length(CAST(api_key AS BLOB)) <= 10 THEN '****'
 ELSE CAST(substr(CAST(api_key AS BLOB), 1, 6) AS TEXT) || '****' || CAST(substr(CAST(api_key AS BLOB), -4) AS TEXT)
END
WHERE api_key <> '' AND api_key <> '****'
 AND NOT (length(CAST(api_key AS BLOB)) = 14 AND substr(CAST(api_key AS BLOB), 7, 4) = CAST('****' AS BLOB))`)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return n, tx.Commit()
}
