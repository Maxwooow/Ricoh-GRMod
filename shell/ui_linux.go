//go:build linux && desktop

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"grmod/shell/internal/platform"
	"grmod/shell/internal/update"
)

// runPlatform shows the UI on Linux (the build with the tag "desktop").
//
// As on macOS, the program has no window of its own. It serves the UI and
// opens it as a chromeless "app" window of a Chromium-based browser found in
// PATH (Chrome, Chromium, Edge, Brave, Vivaldi) with a profile of its own,
// or in the default browser when none is installed. It stops when the page
// has stopped sending heartbeats, or at once when the browser it started
// has ended while no other instance holds the profile: on Linux that
// browser ends with its last window, so the window has been closed.
func runPlatform(a *app) int {
	host := platform.New()
	if err := a.start(host); err != nil {
		a.log.Printf("startup failed: %v", err)
		fatalMessage("GR Mod cannot start: " + err.Error())
		return 1
	}
	heartbeat := a.srv.Heartbeat()
	heartbeat.Restart()

	// Installed before the browser is started, so that a request to quit
	// at any moment still closes it.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	// An installed update or a closed window ends this run like a request
	// to quit.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-a.restart.requested():
			cancel()
		case <-ctx.Done():
		}
	}()

	profile := filepath.Join(a.dataDir, "browser")
	var browser *exec.Cmd
	browserDone := make(chan struct{})
	for _, name := range platform.LinuxBrowsers() {
		exe, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		cmd := exec.Command(exe, edgeArgs(a.url, profile)...)
		if err := cmd.Start(); err != nil {
			a.log.Printf("browser: cannot start %s: %v", exe, err)
			continue
		}
		a.log.Printf("browser: started %s in app mode", name)
		browser = cmd
		go func() { _ = cmd.Wait(); close(browserDone) }()
		break
	}
	openDefault := func() {
		if err := exec.Command("xdg-open", a.url).Run(); err != nil {
			a.log.Printf("browser: cannot open the default browser: %v", err)
			fatalMessage("GR Mod could not open a browser window.\n\nOpen this address in a browser within a minute to use it:\n\n" + a.url)
		} else {
			a.log.Printf("browser: opened the default browser")
		}
		heartbeat.Restart()
	}
	var windowClosed atomic.Bool
	if browser != nil {
		// When an instance with this profile was already running (left over
		// from an earlier run), the one started here hands the window over
		// to it and ends at once; then the heartbeat decides.
		go func() {
			select {
			case <-browserDone:
				switch {
				case linuxProfileOwner(profile) != 0:
				case heartbeat.Seen():
					windowClosed.Store(true)
					cancel()
				default:
					a.log.Printf("browser: ended before the page connected, using the default browser")
					openDefault()
				}
			case <-ctx.Done():
			}
		}()
	} else {
		a.log.Printf("browser: no Chromium-based browser found, using the default browser")
		openDefault()
	}

	_ = heartbeat.Wait(ctx, linuxHeartbeatIdle, heartbeatNever, heartbeatPoll)
	switch {
	case a.restart.pending():
		a.log.Printf("closing for the update")
	case windowClosed.Load():
		a.log.Printf("browser: the window was closed")
	case ctx.Err() != nil:
		a.log.Printf("received a signal to quit")
	case heartbeat.Seen():
		a.log.Printf("browser: the page stopped sending heartbeats")
	default:
		a.log.Printf("browser: no page ever connected")
	}
	a.shutdown()

	// The browser was started with a profile of its own, only for GR Mod;
	// leave nothing of it behind.
	if browser != nil {
		select {
		case <-browserDone:
			if pid := linuxProfileOwner(profile); pid > 0 {
				a.log.Printf("browser: quitting the instance that took over the window (pid %d)", pid)
				_ = syscall.Kill(pid, syscall.SIGTERM)
				if a.restart.pending() {
					// The new program opens a window with the same profile;
					// it must not hand it to this browser on its way out.
					update.WaitExit(pid, 5*time.Second)
				}
			}
		default:
			_ = browser.Process.Signal(syscall.SIGTERM)
			select {
			case <-browserDone:
			case <-time.After(5 * time.Second):
			}
		}
	}
	return 0
}

// linuxHeartbeatIdle is as long as on macOS: a window in the background can
// be slow to send its next ping.
const linuxHeartbeatIdle = 20 * time.Second

// fatalMessage reports a fatal problem in a dialog, since a program started
// from the desktop's menu has no terminal.
func fatalMessage(msg string) {
	fmt.Fprintln(os.Stderr, "grmod: "+msg)
	platform.ErrorDialog(windowTitle, msg)
}
