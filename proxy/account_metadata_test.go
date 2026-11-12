package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"kiro-proxy/config"
)

func addMetadataTestAccount(t *testing.T, account config.Account) {
	t.Helper()
	if err := config.AddAccount(account); err != nil {
		t.Fatalf("add account %s: %v", account.ID, err)
	}
}

func metadataAccount(t *testing.T, id string) config.Account {
	t.Helper()
	for _, a := range config.GetAccounts() {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("account %s not stored", id)
	return config.Account{}
}

func TestUpdateAccountSetsNotesAndTags(t *testing.T) {
	h := newRegionTestAdmin(t)
	addMetadataTestAccount(t, config.Account{ID: "acc", Nickname: "nick", Enabled: true})

	put := func(body string) *httptest.ResponseRecorder {
		return serveRegionTestAdmin(h, http.MethodPut, "/admin/api/accounts/acc", body)
	}

	if rec := put(`{"notes":" owner: ops@example.com\r\nrotate monthly ","tags":["Team-A"," team-a ","backup",""]}`); rec.Code != http.StatusOK {
		t.Fatalf("put metadata: %d %s", rec.Code, rec.Body.String())
	}
	got := metadataAccount(t, "acc")
	if got.Notes != "owner: ops@example.com\nrotate monthly" || !reflect.DeepEqual(got.Tags, []string{"Team-A", "backup"}) {
		t.Fatalf("metadata not normalized: notes=%q tags=%q", got.Notes, got.Tags)
	}

	// Other fields leave the metadata alone, and the metadata leaves them alone.
	if rec := put(`{"nickname":"renamed","weight":3}`); rec.Code != http.StatusOK {
		t.Fatalf("put nickname: %d %s", rec.Code, rec.Body.String())
	}
	got = metadataAccount(t, "acc")
	if got.Nickname != "renamed" || got.Weight != 3 || got.Notes == "" || len(got.Tags) != 2 {
		t.Fatalf("a nickname edit touched the metadata: %+v", got)
	}
	if rec := put(`{"notes":"only notes"}`); rec.Code != http.StatusOK {
		t.Fatalf("put notes: %d", rec.Code)
	}
	if got = metadataAccount(t, "acc"); got.Notes != "only notes" || len(got.Tags) != 2 || got.Nickname != "renamed" {
		t.Fatalf("a notes edit touched other fields: %+v", got)
	}

	if rec := put(`{"tags":[],"notes":""}`); rec.Code != http.StatusOK {
		t.Fatalf("clear: %d", rec.Code)
	}
	if got = metadataAccount(t, "acc"); got.Notes != "" || got.Tags != nil {
		t.Fatalf("empty values must clear: notes=%q tags=%#v", got.Notes, got.Tags)
	}

	for _, body := range []string{`{"tags":"a"}`, `{"tags":[1]}`, `{"notes":5}`, `{"notes":"x","tags":{"a":1}}`} {
		rec := put(body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), codeInvalidJSON) {
			t.Fatalf("%s: expected 400 invalid_json, got %d %s", body, rec.Code, rec.Body.String())
		}
	}
	if got = metadataAccount(t, "acc"); got.Notes != "" {
		t.Fatalf("a rejected body was written: %+v", got)
	}

	if rec := serveRegionTestAdmin(h, http.MethodPut, "/admin/api/accounts/missing", `{"notes":"x"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown id: %d", rec.Code)
	}
}

func TestGetAccountsReturnsNotesAndEmptyTagsArray(t *testing.T) {
	h := newRegionTestAdmin(t)
	addMetadataTestAccount(t, config.Account{ID: "plain", Enabled: true})
	addMetadataTestAccount(t, config.Account{ID: "tagged", Notes: "hello", Tags: []string{"x"}, Enabled: true})

	rec := serveRegionTestAdmin(h, http.MethodGet, "/admin/api/accounts", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d", rec.Code)
	}
	var list []map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	byID := map[string]map[string]json.RawMessage{}
	for _, item := range list {
		var id string
		_ = json.Unmarshal(item["id"], &id)
		byID[id] = item
	}
	if string(byID["plain"]["tags"]) != "[]" || string(byID["plain"]["notes"]) != `""` {
		t.Fatalf("an account without metadata must send notes \"\" and tags [], got %s %s", byID["plain"]["notes"], byID["plain"]["tags"])
	}
	if string(byID["tagged"]["tags"]) != `["x"]` || string(byID["tagged"]["notes"]) != `"hello"` {
		t.Fatalf("tagged account = %s %s", byID["tagged"]["notes"], byID["tagged"]["tags"])
	}

	rec = serveRegionTestAdmin(h, http.MethodGet, "/admin/api/accounts/plain/full", "")
	if !strings.Contains(rec.Body.String(), `"tags":[]`) {
		t.Fatalf("full account must send tags [], got %s", rec.Body.String())
	}
}

func TestBatchAddRemoveTag(t *testing.T) {
	h := newRegionTestAdmin(t)
	var full []string
	for i := 0; i < config.MaxAccountTags; i++ {
		full = append(full, fmt.Sprintf("t%d", i))
	}
	addMetadataTestAccount(t, config.Account{ID: "a", Tags: []string{"Team"}})
	addMetadataTestAccount(t, config.Account{ID: "b"})
	addMetadataTestAccount(t, config.Account{ID: "full", Tags: full})

	got := runBatch(t, h, `{"ids":["a","b","full","missing","a"],"action":"addTag","tag":"  team "}`)
	if got.Count != 2 || got.Failed != 2 || len(got.Results) != 4 {
		t.Fatalf("addTag counts = %+v", got)
	}
	if res := got.Results[2]; res.ID != "full" || res.OK || res.Status != accountStatusTagLimit {
		t.Fatalf("full account result = %+v", res)
	}
	if res := got.Results[3]; res.Status != accountStatusNotFound {
		t.Fatalf("missing id result = %+v", res)
	}
	if tags := metadataAccount(t, "a").Tags; !reflect.DeepEqual(tags, []string{"Team"}) {
		t.Fatalf("an existing tag in another case must not be added twice: %q", tags)
	}
	if tags := metadataAccount(t, "b").Tags; !reflect.DeepEqual(tags, []string{"team"}) {
		t.Fatalf("b tags = %q", tags)
	}
	if tags := metadataAccount(t, "full").Tags; !reflect.DeepEqual(tags, full) {
		t.Fatalf("a full account changed: %q", tags)
	}

	got = runBatch(t, h, `{"ids":["a","b","full"],"action":"removeTag","tag":"TEAM"}`)
	if got.Count != 3 || got.Failed != 0 {
		t.Fatalf("removeTag counts = %+v", got)
	}
	for _, id := range []string{"a", "b"} {
		if tags := metadataAccount(t, id).Tags; tags != nil {
			t.Fatalf("%s kept the tag: %q", id, tags)
		}
	}

	rec := httptest.NewRecorder()
	h.apiBatchAccounts(rec, httptest.NewRequest(http.MethodPost, "/admin/api/accounts/batch",
		strings.NewReader(`{"ids":["a"],"action":"addTag","tag":"  \n "}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("an empty tag must be rejected, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestStaleAccountWritesKeepNotesAndTags(t *testing.T) {
	h := newRegionTestAdmin(t)
	// No access token: re-enabling it then starts no background model refresh.
	addMetadataTestAccount(t, config.Account{ID: "acc", Enabled: true})
	stale := metadataAccount(t, "acc")

	if rec := serveRegionTestAdmin(h, http.MethodPut, "/admin/api/accounts/acc", `{"notes":"keep","tags":["keep"]}`); rec.Code != http.StatusOK {
		t.Fatalf("put: %d", rec.Code)
	}
	// The failover path disables an account from the copy it was routing with.
	h.disableAccount(&stale, "BANNED", "test")
	runBatch(t, h, `{"ids":["acc"],"action":"enable"}`)

	got := metadataAccount(t, "acc")
	if got.Notes != "keep" || !reflect.DeepEqual(got.Tags, []string{"keep"}) {
		t.Fatalf("stale writes wiped the metadata: notes=%q tags=%q", got.Notes, got.Tags)
	}
	if !got.Enabled {
		t.Fatalf("batch enable did not land: %+v", got)
	}
}

func TestExportImportRoundTripKeepsNotesAndTags(t *testing.T) {
	h := newRegionTestAdmin(t)
	modelCalls := stubImportNetwork(t)

	rec := serveRegionTestAdmin(h, http.MethodPost, "/admin/api/auth/credentials",
		`{"kiroApiKey":"ksk_meta|us-east-1","authMethod":"api_key","nickname":"cli","notes":" first line\nops@example.com ","tags":["Team-A","team-a","backup"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("seed import: %d %s", rec.Code, rec.Body.String())
	}
	waitForModelRefresh(t, modelCalls, "Bearer ksk_meta")
	seeded := config.GetAccounts()[0]
	if seeded.Notes != "first line\nops@example.com" || !reflect.DeepEqual(seeded.Tags, []string{"Team-A", "backup"}) {
		t.Fatalf("import did not store normalized metadata: notes=%q tags=%q", seeded.Notes, seeded.Tags)
	}

	rec = serveRegionTestAdmin(h, http.MethodPost, "/admin/api/export", `{"ids":["`+seeded.ID+`"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
	}
	var exported struct {
		Accounts []struct {
			Nickname    string          `json:"nickname"`
			Notes       string          `json:"notes"`
			Tags        []string        `json:"tags"`
			Credentials json.RawMessage `json:"credentials"`
		} `json:"accounts"`
		Tags []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"tags"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &exported); err != nil || len(exported.Accounts) != 1 {
		t.Fatalf("decode export (%v): %s", err, rec.Body.String())
	}
	account := exported.Accounts[0]
	if account.Notes != seeded.Notes || !reflect.DeepEqual(account.Tags, []string{"Team-A", "backup"}) {
		t.Fatalf("export lost metadata: %+v", account)
	}
	if len(exported.Tags) != 2 || exported.Tags[0].ID != "backup" || exported.Tags[0].Name != "backup" || exported.Tags[1].Name != "Team-A" {
		t.Fatalf("top-level tags = %+v", exported.Tags)
	}

	// Re-import the way the UI maps an export entry: credentials plus nickname, notes and tags.
	var body map[string]interface{}
	if err := json.Unmarshal(account.Credentials, &body); err != nil {
		t.Fatal(err)
	}
	body["nickname"] = account.Nickname
	body["notes"] = account.Notes
	body["tags"] = account.Tags
	payload, _ := json.Marshal(body)

	if err := config.Init(t.TempDir() + "/kiro.db"); err != nil {
		t.Fatalf("config.Init: %v", err)
	}
	config.SetPassword("admin-password")
	rec = serveRegionTestAdmin(h, http.MethodPost, "/admin/api/auth/credentials", string(payload))
	if rec.Code != http.StatusOK {
		t.Fatalf("re-import: %d %s", rec.Code, rec.Body.String())
	}
	waitForModelRefresh(t, modelCalls, "Bearer ksk_meta")
	accounts := config.GetAccounts()
	if len(accounts) != 1 {
		t.Fatalf("expected one re-imported account, got %d", len(accounts))
	}
	if got := accounts[0]; got.Notes != seeded.Notes || !reflect.DeepEqual(got.Tags, seeded.Tags) || got.Nickname != "cli" {
		t.Fatalf("round trip lost metadata: notes=%q tags=%q nickname=%q", got.Notes, got.Tags, got.Nickname)
	}
}

func TestExportTagObjectsCoversEveryAccountsIDs(t *testing.T) {
	accounts := []config.Account{
		{Tags: []string{"zeta", "Alpha"}},
		{Tags: []string{"alpha", "beta"}},
		{Tags: []string{"beta"}},
		{},
	}
	got := exportTagObjects(accounts)
	want := []interface{}{
		map[string]string{"id": "Alpha", "name": "Alpha"},
		map[string]string{"id": "alpha", "name": "alpha"},
		map[string]string{"id": "beta", "name": "beta"},
		map[string]string{"id": "zeta", "name": "zeta"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("exportTagObjects = %v", got)
	}
	// Every per-account id must resolve through the top-level list, as a Kiro Account
	// Manager style importer resolves them.
	ids := make(map[string]bool)
	for _, obj := range got {
		ids[obj.(map[string]string)["id"]] = true
	}
	for _, a := range accounts {
		for _, tag := range a.Tags {
			if !ids[tag] {
				t.Fatalf("account tag %q has no top-level entry in %v", tag, got)
			}
		}
	}
	if empty := exportTagObjects(nil); empty == nil || len(empty) != 0 {
		t.Fatalf("no tags must export [], got %#v", empty)
	}
}
