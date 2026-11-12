package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

const (
	alertNameMax    = 64
	alertURLMax     = 2048
	alertSecretMax  = 256
	alertChatIDMax  = 64
	alertBodyMax    = 256 << 10
	alertCooldownLo = 1
)

// A Telegram bot token is "<bot id>:<key>"; it goes into the request path, so
// nothing else may pass.
var telegramTokenPattern = regexp.MustCompile(`^[0-9]+:[A-Za-z0-9_-]+$`)

// alertChannelView is a channel as the admin API shows it: never a URL, token
// or secret, only whether each is set and a hint at the target.
type alertChannelView struct {
	ID          string         `json:"id"`
	Type        string         `json:"type"`
	Name        string         `json:"name"`
	Enabled     bool           `json:"enabled"`
	ChatID      string         `json:"chatId,omitempty"`
	TargetHint  string         `json:"targetHint"`
	URLSet      bool           `json:"urlSet"`
	BotTokenSet bool           `json:"botTokenSet"`
	SecretSet   bool           `json:"secretSet"`
	LastResult  *alertDelivery `json:"lastResult"`
}

type alertsView struct {
	AccountUsage        bool               `json:"accountUsage"`
	PoolUsage           bool               `json:"poolUsage"`
	AccountBanned       bool               `json:"accountBanned"`
	AllUnavailable      bool               `json:"allUnavailable"`
	AccountThresholds   []int              `json:"accountThresholds"`
	PoolThresholds      []int              `json:"poolThresholds"`
	PoolCooldownMinutes int                `json:"poolCooldownMinutes"`
	Channels            []alertChannelView `json:"channels"`
}

// alertChannelInput is a channel in a POST. A blank secret on a known channel
// of the same type keeps the stored one. ClearSecret removes the stored
// signing secret instead (a secret sent with it replaces it, as usual).
type alertChannelInput struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Name        string `json:"name"`
	Enabled     *bool  `json:"enabled"`
	URL         string `json:"url"`
	BotToken    string `json:"botToken"`
	ChatID      string `json:"chatId"`
	Secret      string `json:"secret"`
	ClearSecret bool   `json:"clearSecret"`
}

// alertsUpdate is a POST /alerts body: every field is optional, and channels,
// when present, is the whole new list.
type alertsUpdate struct {
	AccountUsage        *bool                `json:"accountUsage"`
	PoolUsage           *bool                `json:"poolUsage"`
	AccountBanned       *bool                `json:"accountBanned"`
	AllUnavailable      *bool                `json:"allUnavailable"`
	AccountThresholds   *[]int               `json:"accountThresholds"`
	PoolThresholds      *[]int               `json:"poolThresholds"`
	PoolCooldownMinutes *int                 `json:"poolCooldownMinutes"`
	Channels            *[]alertChannelInput `json:"channels"`
}

// alertInputError is a rejected POST /alerts: its code, and the field (and
// channel index) the UI marks.
type alertInputError struct {
	code    string
	message string
	field   string
	index   int
}

func (e *alertInputError) Error() string { return e.message }

func channelError(index int, field, message string) *alertInputError {
	return &alertInputError{code: codeAlertChannelInvalid, message: message, field: field, index: index}
}

func (h *Handler) handleAlertsAPI(w http.ResponseWriter, r *http.Request, path string) {
	switch {
	case path == "/alerts" && r.Method == http.MethodGet:
		h.apiGetAlerts(w, r)
	case path == "/alerts" && r.Method == http.MethodPost:
		h.apiUpdateAlerts(w, r)
	case path == "/alerts/test" && r.Method == http.MethodPost:
		h.apiTestAlertChannel(w, r)
	default:
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Not Found"})
	}
}

func alertsResponse() alertsView {
	cfg := config.GetAlertsConfig()
	deliveries, err := loadAlertDeliveries()
	if err != nil {
		logger.Warnf("[Alerts] Failed to load the last results: %v", err)
	}
	view := alertsView{
		AccountUsage:        cfg.AccountUsageOn(),
		PoolUsage:           cfg.PoolUsageOn(),
		AccountBanned:       cfg.AccountBannedOn(),
		AllUnavailable:      cfg.AllUnavailableOn(),
		AccountThresholds:   cfg.AccountThresholds,
		PoolThresholds:      cfg.PoolThresholds,
		PoolCooldownMinutes: cfg.PoolCooldownMinutes,
		Channels:            make([]alertChannelView, 0, len(cfg.Channels)),
	}
	for _, ch := range cfg.Channels {
		v := alertChannelView{
			ID:          ch.ID,
			Type:        ch.Type,
			Name:        ch.Name,
			Enabled:     ch.Enabled,
			TargetHint:  alertTargetHint(ch),
			URLSet:      ch.URL != "",
			BotTokenSet: ch.BotToken != "",
			SecretSet:   ch.Secret != "",
		}
		if ch.Type == config.AlertChannelTelegram {
			v.ChatID = ch.ChatID
		}
		if d, ok := deliveries[ch.ID]; ok {
			v.LastResult = &d
		}
		view.Channels = append(view.Channels, v)
	}
	return view
}

func (h *Handler) apiGetAlerts(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(alertsResponse())
}

func (h *Handler) apiUpdateAlerts(w http.ResponseWriter, r *http.Request) {
	var req alertsUpdate
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, alertBodyMax)).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	if err := validateAlertRules(req); err != nil {
		writeAlertInputError(w, err)
		return
	}
	if req.Channels != nil && len(*req.Channels) > config.MaxAlertChannels {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{
			"error": fmt.Sprintf("At most %d alert channels", config.MaxAlertChannels),
			"code":  codeAlertChannelLimit,
			"max":   config.MaxAlertChannels,
		})
		return
	}

	err := config.UpdateAlertsConfig(func(c *config.AlertsConfig) error {
		applyAlertRules(c, req)
		if req.Channels == nil {
			return nil
		}
		incoming, err := normalizeAlertChannels(*req.Channels)
		if err != nil {
			return err
		}
		merged := config.MergeAlertChannels(c.Channels, incoming)
		for i, ch := range merged {
			//! merged, incoming and the request list share their order, one entry each.
			if (*req.Channels)[i].ClearSecret {
				merged[i].Secret = incoming[i].Secret
			}
			if err := validateAlertChannelSecrets(i, ch); err != nil {
				return err
			}
		}
		c.Channels = merged
		return nil
	})
	if err != nil {
		var inputErr *alertInputError
		if errors.As(err, &inputErr) {
			writeAlertInputError(w, inputErr)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	if req.Channels != nil {
		keep := make(map[string]bool)
		for _, ch := range config.GetAlertsConfig().Channels {
			keep[ch.ID] = true
		}
		if err := pruneAlertDeliveries(keep); err != nil {
			logger.Warnf("[Alerts] Failed to prune the last results: %v", err)
		}
	}
	publishEvent(eventSettingsChanged, "alerts")
	kickAlerts()
	json.NewEncoder(w).Encode(alertsResponse())
}

func writeAlertInputError(w http.ResponseWriter, err *alertInputError) {
	body := map[string]any{"error": err.message, "code": err.code}
	if err.field != "" {
		body["field"] = err.field
	}
	if err.code == codeAlertChannelInvalid {
		body["index"] = err.index
	}
	if err.code == codeAlertCooldownRange {
		body["min"] = alertCooldownLo
		body["max"] = config.MaxAlertCooldownMinutes
	}
	w.WriteHeader(http.StatusBadRequest)
	json.NewEncoder(w).Encode(body)
}

func validateAlertRules(req alertsUpdate) *alertInputError {
	if req.AccountThresholds != nil {
		if err := config.ValidateAlertThresholds(*req.AccountThresholds); err != nil {
			return &alertInputError{code: codeAlertThresholdsInvalid, message: err.Error(), field: "accountThresholds"}
		}
	}
	if req.PoolThresholds != nil {
		if err := config.ValidateAlertThresholds(*req.PoolThresholds); err != nil {
			return &alertInputError{code: codeAlertThresholdsInvalid, message: err.Error(), field: "poolThresholds"}
		}
	}
	if req.PoolCooldownMinutes != nil {
		if v := *req.PoolCooldownMinutes; v < alertCooldownLo || v > config.MaxAlertCooldownMinutes {
			return &alertInputError{
				code:    codeAlertCooldownRange,
				message: fmt.Sprintf("poolCooldownMinutes must be %d to %d", alertCooldownLo, config.MaxAlertCooldownMinutes),
				field:   "poolCooldownMinutes",
			}
		}
	}
	return nil
}

func applyAlertRules(c *config.AlertsConfig, req alertsUpdate) {
	set := func(dst **bool, v *bool) {
		if v != nil {
			on := *v
			*dst = &on
		}
	}
	set(&c.AccountUsage, req.AccountUsage)
	set(&c.PoolUsage, req.PoolUsage)
	set(&c.AccountBanned, req.AccountBanned)
	set(&c.AllUnavailable, req.AllUnavailable)
	if req.AccountThresholds != nil {
		c.AccountThresholds = append([]int(nil), *req.AccountThresholds...)
	}
	if req.PoolThresholds != nil {
		c.PoolThresholds = append([]int(nil), *req.PoolThresholds...)
	}
	if req.PoolCooldownMinutes != nil {
		c.PoolCooldownMinutes = *req.PoolCooldownMinutes
	}
}

// normalizeAlertChannels trims and checks the fields that do not depend on the
// stored channel: the type, the name and the shape of anything given.
func normalizeAlertChannels(in []alertChannelInput) ([]config.AlertChannel, error) {
	out := make([]config.AlertChannel, 0, len(in))
	for i, raw := range in {
		ch := config.AlertChannel{
			ID:       strings.TrimSpace(raw.ID),
			Type:     strings.TrimSpace(raw.Type),
			Name:     strings.TrimSpace(raw.Name),
			Enabled:  raw.Enabled == nil || *raw.Enabled,
			URL:      strings.TrimSpace(raw.URL),
			BotToken: strings.TrimSpace(raw.BotToken),
			ChatID:   strings.TrimSpace(raw.ChatID),
			Secret:   strings.TrimSpace(raw.Secret),
		}
		switch ch.Type {
		case config.AlertChannelWebhook, config.AlertChannelTelegram, config.AlertChannelDiscord, config.AlertChannelSlack:
		default:
			return nil, channelError(i, "type", "type must be webhook, telegram, discord or slack")
		}
		if utf8.RuneCountInString(ch.Name) > alertNameMax {
			return nil, channelError(i, "name", fmt.Sprintf("name must be at most %d characters", alertNameMax))
		}
		if ch.Type == config.AlertChannelTelegram {
			ch.URL, ch.Secret = "", ""
		} else {
			ch.BotToken, ch.ChatID = "", ""
		}
		if ch.Type != config.AlertChannelWebhook {
			ch.Secret = ""
		}
		if ch.URL != "" && !validAlertURL(ch.URL) {
			return nil, channelError(i, "url", "url must be an http or https URL")
		}
		if ch.BotToken != "" && (len(ch.BotToken) > alertSecretMax || !telegramTokenPattern.MatchString(ch.BotToken)) {
			return nil, channelError(i, "botToken", "botToken must look like 123456:ABC-DEF")
		}
		if len(ch.ChatID) > alertChatIDMax || strings.ContainsAny(ch.ChatID, " \t\r\n") {
			return nil, channelError(i, "chatId", "chatId must be a chat id or @channel name")
		}
		if len(ch.Secret) > alertSecretMax {
			return nil, channelError(i, "secret", fmt.Sprintf("secret must be at most %d characters", alertSecretMax))
		}
		out = append(out, ch)
	}
	return out, nil
}

// validateAlertChannelSecrets checks what each type needs, after the stored
// secrets were merged in.
func validateAlertChannelSecrets(i int, ch config.AlertChannel) error {
	if ch.Type == config.AlertChannelTelegram {
		if ch.BotToken == "" {
			return channelError(i, "botToken", "botToken is required")
		}
		if ch.ChatID == "" {
			return channelError(i, "chatId", "chatId is required")
		}
		return nil
	}
	if ch.URL == "" {
		return channelError(i, "url", "url is required")
	}
	return nil
}

func validAlertURL(raw string) bool {
	if len(raw) > alertURLMax {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

func (h *Handler) apiTestAlertChannel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChannelID string `json:"channelId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeAdminError(w, http.StatusBadRequest, codeInvalidJSON, "Invalid JSON")
		return
	}
	ch, ok := config.GetAlertsConfig().Channel(strings.TrimSpace(req.ChannelID))
	if !ok {
		writeAdminError(w, http.StatusNotFound, codeAlertChannelNotFound, "Alert channel not found")
		return
	}
	//! One attempt, no retries: the admin is waiting on the button, and the result says what failed.
	result := getAlerter().deliver(r.Context(), alertHTTPClient(), ch, testAlertMessage(time.Now().Unix()), 0)
	publishEvent(eventSettingsChanged, "alerts")
	json.NewEncoder(w).Encode(result)
}
