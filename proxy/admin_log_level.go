package proxy

import (
	"os"
	"strings"

	"kiro-proxy/config"
	"kiro-proxy/logger"
)

// codeLogLevelInvalid: POST /settings logLevel is not debug, info, warn or error. Same
// contract as the codes in admin_errors.go.
const codeLogLevelInvalid = "log_level_invalid"

// currentLogLevel is the server log level in effect now, and whether LOG_LEVEL is set: that
// variable picks the level again at each start, over the saved one.
func currentLogLevel() (string, bool) {
	return logger.LevelName(logger.GetLevel()), strings.TrimSpace(os.Getenv("LOG_LEVEL")) != ""
}

// parseLogLevelPatch returns the level name a settings patch asks for ("" when it has none),
// or ok=false for a name the logger does not know.
func parseLogLevelPatch(level *string) (name string, ok bool) {
	if level == nil {
		return "", true
	}
	parsed, known := logger.ParseLevel(*level)
	if !known {
		return "", false
	}
	return logger.LevelName(parsed), true
}

// applyLogLevel saves the level and switches the logger at once, with no restart. The change
// is logged at the more verbose of the two levels, so it shows when either one is info.
func applyLogLevel(name string) error {
	if name == "" {
		return nil
	}
	if err := config.UpdateLogLevel(name); err != nil {
		return err
	}
	next, _ := logger.ParseLevel(name)
	if next < logger.GetLevel() {
		logger.SetLevel(next)
		logger.Infof("[Settings] Log level is now %s", name)
		return nil
	}
	logger.Infof("[Settings] Log level is now %s", name)
	logger.SetLevel(next)
	return nil
}

// applyRestoredLogLevel switches the logger to the level a restored backup saved, as a start
// would (LOG_LEVEL still wins). Without it Settings showed the old level until the next start,
// which then switched to the restored one, debug included.
func applyRestoredLogLevel() {
	before := logger.GetLevel()
	logger.Init(config.GetLogLevel())
	if after := logger.GetLevel(); after != before {
		logger.Infof("[Settings] Log level is now %s, from the restored backup", logger.LevelName(after))
	}
}
