package logger

import (
	"io"
	"log"
	"os"
	"strings"
	"sync/atomic"
)

type Level int32

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

var (
	currentLevel atomic.Int32

	debugLog = log.New(os.Stdout, "DEBUG ", log.LstdFlags)
	infoLog  = log.New(os.Stdout, "INFO  ", log.LstdFlags)
	warnLog  = log.New(os.Stderr, "WARN  ", log.LstdFlags)
	errorLog = log.New(os.Stderr, "ERROR ", log.LstdFlags)
)

func init() {
	currentLevel.Store(int32(LevelInfo))
}

func ParseLevel(s string) (Level, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug", "trace":
		return LevelDebug, true
	case "info":
		return LevelInfo, true
	case "warn", "warning":
		return LevelWarn, true
	case "error", "err":
		return LevelError, true
	}
	return LevelInfo, false
}

func LevelName(l Level) string {
	switch l {
	case LevelDebug:
		return "debug"
	case LevelInfo:
		return "info"
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	}
	return "info"
}

func SetLevel(l Level) {
	currentLevel.Store(int32(l))
}

func GetLevel() Level {
	return Level(currentLevel.Load())
}

func SetOutput(w io.Writer) {
	debugLog.SetOutput(w)
	infoLog.SetOutput(w)
	warnLog.SetOutput(w)
	errorLog.SetOutput(w)
}

func Init(fallback string) {
	value := fallback
	if env := os.Getenv("LOG_LEVEL"); env != "" {
		value = env
	}
	if l, ok := ParseLevel(value); ok {
		SetLevel(l)
	}
}

func enabled(l Level) bool {
	return Level(currentLevel.Load()) <= l
}

func Debugf(format string, v ...interface{}) {
	if enabled(LevelDebug) {
		debugLog.Printf(format, v...)
	}
}

func Infof(format string, v ...interface{}) {
	if enabled(LevelInfo) {
		infoLog.Printf(format, v...)
	}
}

func Warnf(format string, v ...interface{}) {
	if enabled(LevelWarn) {
		warnLog.Printf(format, v...)
	}
}

func Errorf(format string, v ...interface{}) {
	if enabled(LevelError) {
		errorLog.Printf(format, v...)
	}
}

func Fatalf(format string, v ...interface{}) {
	errorLog.Printf(format, v...)
	os.Exit(1)
}
