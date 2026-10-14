//go:build darwin

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"grmod/shell/internal/platform"
)

// macOS uses the local browser for the UI and native file/SD card operations.
func runPlatform(a *app) int {
	if err := a.start(platform.New()); err != nil {
		fatalMessage("GR Mod cannot start: " + err.Error())
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if os.Getenv("GRMOD_HEADLESS") == "1" {
		fmt.Printf("LISTEN %s\n", a.url)
		<-ctx.Done()
	} else {
		a.srv.Heartbeat().Restart()
		if err := exec.Command("/usr/bin/open", a.url).Run(); err != nil {
			fatalMessage("Cannot open GR Mod: " + err.Error())
			return 1
		}
		// Background browser tabs can throttle timers; allow two minutes.
		_ = a.srv.Heartbeat().Wait(ctx, 2*time.Minute, 3*time.Minute, time.Second)
	}
	a.shutdown()
	return 0
}

func fatalMessage(msg string) { fmt.Fprintln(os.Stderr, "grmod: "+msg) }
