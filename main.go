package main

import (
	"fmt"
	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/logger"
	"kiro-proxy/pool"
	"kiro-proxy/proxy"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

func main() {

	dataDir := "."
	if envDir := os.Getenv("DATA_DIR"); envDir != "" {
		dataDir = envDir
	}

	if err := os.MkdirAll(dataDir, 0700); err != nil {
		log.Fatalf("Failed to create database directory: %v", err)
	}

	if err := db.Init(dataDir); err != nil {
		log.Fatalf("Failed to open db: %v", err)
	}

	if err := config.Init(filepath.Join(dataDir, "kiro.db")); err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	logger.Init(config.GetLogLevel())

	if envPassword := os.Getenv("ADMIN_PASSWORD"); envPassword != "" {
		config.SetPassword(envPassword)
	}

	pool.GetPool()

	handler := proxy.NewHandler()

	addr := fmt.Sprintf("%s:%d", config.GetHost(), config.GetPort())
	logger.Infof("Kiro Proxy starting on http://%s (log level: %s)", addr, logger.LevelName(logger.GetLevel()))
	logger.Infof("Admin panel: http://%s/admin", addr)
	logger.Infof("Claude API: http://%s/v1/messages", addr)
	logger.Infof("OpenAI API: http://%s/v1/chat/completions", addr)

	if err := http.ListenAndServe(addr, handler); err != nil {
		logger.Fatalf("Server failed: %v", err)
	}
}
