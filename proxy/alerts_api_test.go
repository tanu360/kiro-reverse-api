package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kiro-proxy/config"
)

func alertsCall(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, "/admin/api"+path, nil)
	} else {
		req = httptest.NewRequest(method, "/admin/api"+path, strings.NewReader(body))
	}
	(&Handler{}).handleAlertsAPI(rec, req, path)
	return rec
}

func decodeAlerts(t *testing.T, rec *httptest.ResponseRecorder) alertsView {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var view alertsView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return view
}

const alertsSecretsBody = `{"channels":[
  {"type":"webhook","name":"Ops hook","url":"https://hooks.example.test/p/WEBHOOK-PATH-SECRET?k=QUERY-SECRET","secret":"SIGNING-SECRET"},
  {"type":"telegram","name":"Phone","botToken":"123456:TELEGRAM-KEY-SECRET","chatId":"-100200"},
  {"type":"discord","name":"Discord","url":"https://discord.com/api/webhooks/1/DISCORD-SECRET","enabled":false},
  {"type":"slack","url":"https://hooks.slack.com/services/T/B/SLACK-SECRET"}
]}`

var alertsSecretValues = []string{"WEBHOOK-PATH-SECRET", "QUERY-SECRET", "SIGNING-SECRET", "TELEGRAM-KEY-SECRET", "DISCORD-SECRET", "SLACK-SECRET"}

func TestAlertsAPIMasksSecrets(t *testing.T) {
	initAlertsTest(t)
	post := alertsCall(t, http.MethodPost, "/alerts", alertsSecretsBody)
	get := alertsCall(t, http.MethodGet, "/alerts", "")
	for _, rec := range []*httptest.ResponseRecorder{post, get} {
		for _, secret := range alertsSecretValues {
			if strings.Contains(rec.Body.String(), secret) {
				t.Fatalf("response leaks %q: %s", secret, rec.Body.String())
			}
		}
	}
	view := decodeAlerts(t, get)
	if !view.AccountUsage || !view.PoolUsage || !view.AccountBanned || !view.AllUnavailable || view.PoolCooldownMinutes != 60 || len(view.AccountThresholds) != 3 {
		t.Fatalf("defaults = %+v", view)
	}
	if len(view.Channels) != 4 {
		t.Fatalf("channels = %+v", view.Channels)
	}
	hook, tg, dc, sl := view.Channels[0], view.Channels[1], view.Channels[2], view.Channels[3]
	if !strings.HasPrefix(hook.ID, "ch_") || hook.TargetHint != "https://hooks.example.test/…" || !hook.URLSet || !hook.SecretSet || hook.BotTokenSet || !hook.Enabled || hook.LastResult != nil {
		t.Fatalf("webhook = %+v", hook)
	}
	if tg.TargetHint != "bot 123456" || !tg.BotTokenSet || tg.URLSet || tg.ChatID != "-100200" {
		t.Fatalf("telegram = %+v", tg)
	}
	if dc.Enabled || dc.TargetHint != "https://discord.com/…" {
		t.Fatalf("discord = %+v", dc)
	}
	if sl.Name != "" || sl.Type != config.AlertChannelSlack || !sl.URLSet {
		t.Fatalf("slack = %+v", sl)
	}
	//! The stored config keeps the real values.
	stored := config.GetAlertsConfig().Channels
	if stored[1].BotToken != "123456:TELEGRAM-KEY-SECRET" || stored[0].Secret != "SIGNING-SECRET" {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestAlertsAPIValidates(t *testing.T) {
	initAlertsTest(t)
	for _, tc := range []struct {
		body  string
		code  string
		field string
		index float64
	}{
		{`{"accountThresholds":[]}`, codeAlertThresholdsInvalid, "accountThresholds", -1},
		{`{"poolThresholds":[90,80]}`, codeAlertThresholdsInvalid, "poolThresholds", -1},
		{`{"accountThresholds":[0,50]}`, codeAlertThresholdsInvalid, "accountThresholds", -1},
		{`{"poolCooldownMinutes":0}`, codeAlertCooldownRange, "poolCooldownMinutes", -1},
		{`{"poolCooldownMinutes":1441}`, codeAlertCooldownRange, "poolCooldownMinutes", -1},
		{`{"channels":[{"type":"email","url":"https://x.test"}]}`, codeAlertChannelInvalid, "type", 0},
		{`{"channels":[{"type":"slack","url":"https://x.test/a"},{"type":"slack","url":"ftp://x.test"}]}`, codeAlertChannelInvalid, "url", 1},
		{`{"channels":[{"type":"slack","url":"https://"}]}`, codeAlertChannelInvalid, "url", 0},
		{`{"channels":[{"type":"discord"}]}`, codeAlertChannelInvalid, "url", 0},
		{`{"channels":[{"type":"webhook","name":"` + strings.Repeat("n", 65) + `","url":"https://x.test"}]}`, codeAlertChannelInvalid, "name", 0},
		{`{"channels":[{"type":"telegram","chatId":"1"}]}`, codeAlertChannelInvalid, "botToken", 0},
		{`{"channels":[{"type":"telegram","botToken":"1:a/../b","chatId":"1"}]}`, codeAlertChannelInvalid, "botToken", 0},
		{`{"channels":[{"type":"telegram","botToken":"1:abc"}]}`, codeAlertChannelInvalid, "chatId", 0},
		{`{"channels":[` + strings.Repeat(`{"type":"slack","url":"https://x.test/a"},`, 20) + `{"type":"slack","url":"https://x.test/a"}]}`, codeAlertChannelLimit, "", -1},
		{`not json`, codeInvalidJSON, "", -1},
	} {
		rec := alertsCall(t, http.MethodPost, "/alerts", tc.body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%.60s: status=%d body=%s", tc.body, rec.Code, rec.Body.String())
		}
		body := decodeJSON(t, rec)
		if body["code"] != tc.code {
			t.Fatalf("%.60s: body=%v", tc.body, body)
		}
		if tc.field != "" && body["field"] != tc.field {
			t.Fatalf("%.60s: field=%v", tc.body, body["field"])
		}
		if tc.index >= 0 && body["index"] != tc.index {
			t.Fatalf("%.60s: index=%v", tc.body, body["index"])
		}
	}
	//! Nothing invalid was stored.
	if got := config.GetAlertsConfig(); len(got.Channels) != 0 || got.PoolCooldownMinutes != 60 || got.AccountThresholds[0] != 80 {
		t.Fatalf("stored after rejects = %+v", got)
	}

	// A valid patch changes only what it names.
	view := decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", `{"poolUsage":false,"accountThresholds":[50,75],"poolCooldownMinutes":15}`))
	if view.PoolUsage || !view.AccountUsage || view.PoolCooldownMinutes != 15 || len(view.AccountThresholds) != 2 || len(view.PoolThresholds) != 3 {
		t.Fatalf("patched = %+v", view)
	}
	if rec := alertsCall(t, http.MethodDelete, "/alerts", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("DELETE status = %d", rec.Code)
	}
}

func TestAlertsAPIKeepsSecretsOnBlankUpdate(t *testing.T) {
	initAlertsTest(t)
	view := decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", alertsSecretsBody))
	hookID, tgID := view.Channels[0].ID, view.Channels[1].ID

	// The UI sends saved channels back with blank secrets.
	body := `{"channels":[
	  {"id":"` + hookID + `","type":"webhook","name":"Renamed","url":"","secret":"","enabled":false},
	  {"id":"` + tgID + `","type":"telegram","name":"Phone","botToken":"","chatId":"-100999"}
	]}`
	view = decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", body))
	if len(view.Channels) != 2 || view.Channels[0].ID != hookID || view.Channels[0].Name != "Renamed" || view.Channels[0].Enabled || !view.Channels[0].URLSet || !view.Channels[0].SecretSet {
		t.Fatalf("after blank update = %+v", view.Channels)
	}
	stored := config.GetAlertsConfig().Channels
	if stored[0].URL != "https://hooks.example.test/p/WEBHOOK-PATH-SECRET?k=QUERY-SECRET" || stored[0].Secret != "SIGNING-SECRET" {
		t.Fatalf("webhook secrets lost: %+v", stored[0])
	}
	if stored[1].BotToken != "123456:TELEGRAM-KEY-SECRET" || stored[1].ChatID != "-100999" {
		t.Fatalf("telegram = %+v", stored[1])
	}

	// A type change needs the new type's secret: the old one does not carry over.
	rec := alertsCall(t, http.MethodPost, "/alerts", `{"channels":[{"id":"`+hookID+`","type":"discord","url":""}]}`)
	if rec.Code != http.StatusBadRequest || decodeJSON(t, rec)["field"] != "url" {
		t.Fatalf("retype without url: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAlertsAPIClearsSigningSecret(t *testing.T) {
	initAlertsTest(t)
	view := decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", alertsSecretsBody))
	hookID := view.Channels[0].ID
	webhook := func(extra string) string {
		return `{"channels":[{"id":"` + hookID + `","type":"webhook","name":"Ops hook"` + extra + `}]}`
	}

	// clearSecret with a new secret replaces it, as a plain secret would.
	view = decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", webhook(`,"secret":"NEW-SECRET","clearSecret":true`)))
	if !view.Channels[0].SecretSet || config.GetAlertsConfig().Channels[0].Secret != "NEW-SECRET" {
		t.Fatalf("replaced = %+v", config.GetAlertsConfig().Channels[0])
	}
	//! clearSecret with a blank secret removes it; the URL is kept.
	view = decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", webhook(`,"clearSecret":true`)))
	stored := config.GetAlertsConfig().Channels[0]
	if view.Channels[0].SecretSet || stored.Secret != "" || stored.URL == "" || !view.Channels[0].URLSet {
		t.Fatalf("cleared = %+v / %+v", view.Channels[0], stored)
	}
	// Without the flag, a blank secret still keeps what is stored.
	decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", webhook(`,"secret":"KEPT"`)))
	decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", webhook(`,"secret":""`)))
	if got := config.GetAlertsConfig().Channels[0].Secret; got != "KEPT" {
		t.Fatalf("blank update secret = %q", got)
	}
}

func TestAlertsAPIRemovedChannelDropsLastResult(t *testing.T) {
	initAlertsTest(t)
	view := decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", alertsSecretsBody))
	keepID, dropID := view.Channels[0].ID, view.Channels[3].ID
	for _, id := range []string{keepID, dropID} {
		if err := recordAlertDelivery(id, alertDelivery{TS: 1, OK: true, Status: 200, Attempts: 1, Event: alertEventTest}); err != nil {
			t.Fatal(err)
		}
	}
	view = decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", `{"channels":[{"id":"`+keepID+`","type":"webhook","name":"Ops hook"}]}`))
	if len(view.Channels) != 1 || view.Channels[0].LastResult == nil || !view.Channels[0].LastResult.OK {
		t.Fatalf("kept channel = %+v", view.Channels)
	}
	deliveries, err := loadAlertDeliveries()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := deliveries[dropID]; ok || len(deliveries) != 1 {
		t.Fatalf("deliveries = %+v", deliveries)
	}
}

func TestAlertsAPISendTestRecordsResult(t *testing.T) {
	initAlertsTest(t)
	srv, received := alertReceiver(t)
	body := `{"channels":[{"type":"webhook","name":"Local","url":"` + srv.URL + `/hook","secret":"abcd1234"},{"type":"slack","url":"` + srv.URL + `/down","enabled":false}]}`
	view := decodeAlerts(t, alertsCall(t, http.MethodPost, "/alerts", body))
	id := view.Channels[0].ID

	rec := alertsCall(t, http.MethodPost, "/alerts/test", `{"channelId":"`+id+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("test: %d %s", rec.Code, rec.Body.String())
	}
	var result alertDelivery
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil || !result.OK || result.Attempts != 1 || result.Status != 200 || result.TS == 0 || result.Event != alertEventTest {
		t.Fatalf("result = %+v (%v)", result, err)
	}
	got := received()
	if len(got) != 1 || got[0].header.Get(alertSignatureHeader) == "" {
		t.Fatalf("receiver = %+v", got)
	}
	view = decodeAlerts(t, alertsCall(t, http.MethodGet, "/alerts", ""))
	if last := view.Channels[0].LastResult; last == nil || !last.OK || last.Event != alertEventTest {
		t.Fatalf("lastResult = %+v", last)
	}
	if view.Channels[1].LastResult != nil {
		t.Fatalf("untested channel has a result: %+v", view.Channels[1].LastResult)
	}

	rec = alertsCall(t, http.MethodPost, "/alerts/test", `{"channelId":"ch_missing"}`)
	if rec.Code != http.StatusNotFound || decodeJSON(t, rec)["code"] != codeAlertChannelNotFound {
		t.Fatalf("unknown id: %d %s", rec.Code, rec.Body.String())
	}
}
