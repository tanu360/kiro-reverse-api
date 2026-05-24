package main

import (
	"fmt"
	"kiro-proxy/config"
	"kiro-proxy/logger"
	"kiro-proxy/pool"
	"kiro-proxy/proxy"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

func main() {

	configPath := "data/config.json"
	if envPath := os.Getenv("CONFIG_PATH"); envPath != "" {
		configPath = envPath
	}

	if err := os.MkdirAll(filepath.Dir(configPath), 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	if err := config.Init(configPath); err != nil {
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
