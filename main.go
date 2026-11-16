package main

import (
	"context"
	"errors"
	"fmt"
	"kiro-proxy/config"
	"kiro-proxy/db"
	"kiro-proxy/logger"
	"kiro-proxy/pool"
	"kiro-proxy/proxy"
	"kiro-proxy/tunnel"
	"kiro-proxy/updater"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// restartSessionsFile carries the admin's sign-ins from a server that restarts into an update to
// the new process, in the data folder; restartUserSessionsFile carries the key holders'.
// restartHandoffMaxAge is how fresh each must be to count.
const (
	restartSessionsFile     = ".restart-sessions.json"
	restartUserSessionsFile = ".restart-user-sessions.json"
	restartHandoffMaxAge    = 2 * time.Minute
)

// restartGrace is how long a restart waits for open requests; longer streams are cut off.
const restartGrace = 30 * time.Second

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
	handoff := filepath.Join(dataDir, restartSessionsFile)
	if data := updater.TakeHandoff(handoff, restartHandoffMaxAge); data != nil {
		if n := handler.ImportAdminSessions(data); n > 0 {
			logger.Infof("[Update] Kept %d admin sign-in(s) across the restart", n)
		}
	}
	userHandoff := filepath.Join(dataDir, restartUserSessionsFile)
	if data := updater.TakeHandoff(userHandoff, restartHandoffMaxAge); data != nil {
		if n := handler.ImportUserSessions(data); n > 0 {
			logger.Infof("[Update] Kept %d key holder sign-in(s) across the restart", n)
		}
	}

	tunnelManager := tunnel.New(tunnel.Options{
		DataDir:  dataDir,
		Version:  config.Version,
		Handler:  handler,
		OnChange: proxy.TunnelChanged,
		Logf:     logger.Infof,
		Debugf:   logger.Debugf,
	})
	handler.SetTunnel(tunnelManager)

	upd := updater.New(updater.Options{
		Version:  config.Version,
		OnChange: proxy.UpdateChanged,
		Logf:     logger.Infof,
	})

	addr := fmt.Sprintf("%s:%d", config.GetHost(), config.GetPort())
	srv := &http.Server{Addr: addr, Handler: handler}
	srv.RegisterOnShutdown(handler.CloseEventStreams)
	handler.SetUpdater(upd, func() {
		restartIntoUpdate(srv, tunnelManager, handler, upd, handoff, userHandoff)
	})

	if raw, ignored := config.IgnoredPortEnv(); ignored {
		logger.Warnf("PORT=%q is not a port from 1 to 65535 and is ignored", raw)
	}
	logger.Infof("Kiro Proxy starting on http://%s (log level: %s)", addr, logger.LevelName(logger.GetLevel()))
	logger.Infof("Admin panel: http://%s/", addr)
	logger.Infof("Claude API: http://%s/v1/messages", addr)
	logger.Infof("OpenAI API: http://%s/v1/chat/completions", addr)
	if config.GetHost() == config.DefaultHost {
		logger.Infof("Only this machine can connect. Set LISTEN_HOST=0.0.0.0 to accept other machines.")
	}

	err := srv.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		// Only a restart shuts the server down, and it replaces or ends this process once the
		// open requests are done; returning here would end the process before that.
		select {}
	}
	logger.Fatalf("Server failed: %v", err)
}

// restartIntoUpdate stops this server and runs the installed update in its place. It does not
// return: the process becomes the new version, or exits with an error for a supervisor to
// restart it (the new program is already at the executable's path).
func restartIntoUpdate(srv *http.Server, tun *tunnel.Manager, handler *proxy.Handler, upd *updater.Manager, handoff, userHandoff string) {
	logger.Infof("[Update] Restarting: waiting up to %s for open requests", restartGrace)
	ctx, cancel := context.WithTimeout(context.Background(), restartGrace)
	if err := srv.Shutdown(ctx); err != nil {
		logger.Warnf("[Update] Requests still open after %s are cut off", restartGrace)
	}
	cancel()
	// The new process starts its own Tailscale helper; two at once would fight over the device.
	tun.Close()
	if data := handler.ExportAdminSessions(); data != nil {
		if err := updater.SaveHandoff(handoff, data); err != nil {
			logger.Warnf("[Update] Could not keep the admin sign-ins: %v", err)
		}
	}
	if data := handler.ExportUserSessions(); data != nil {
		if err := updater.SaveHandoff(userHandoff, data); err != nil {
			logger.Warnf("[Update] Could not keep the key holders' sign-ins: %v", err)
		}
	}
	if err := db.Close(); err != nil {
		logger.Warnf("[Update] Close the database: %v", err)
	}
	if err := upd.Restart(); err != nil {
		logger.Errorf("[Update] Could not start the new version: %v", err)
		os.Exit(1)
	}
}
