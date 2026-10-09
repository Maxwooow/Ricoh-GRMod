//go:build darwin

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ncruces/zenity"

	"grmod/shell/internal/platform"
)

// runPlatform shows the UI on macOS.
//
// The program is pure Go, so it has no window of its own. It serves the UI
// and opens it as a chromeless "app" window of a Chromium-based browser
// (Chrome, Edge, Brave, Chromium, Vivaldi) with a profile of its own, or in
// the default browser when none is installed. Like the Windows browser
// fallback it stops when the page has stopped sending heartbeats, i.e. when
// the window has been closed.
//
// The bundle is an agent (LSUIElement), so it has no Dock icon of its own:
// the browser window is the application.
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

	profile := filepath.Join(a.dataDir, "browser")
	var browser *exec.Cmd
	var browserExe string
	browserDone := make(chan struct{})
	home, _ := os.UserHomeDir()
	for _, exe := range platform.MacBrowsers(home) {
		if !isFile(exe) {
			continue
		}
		cmd := exec.Command(exe, edgeArgs(a.url, profile)...)
		if err := cmd.Start(); err != nil {
			a.log.Printf("browser: cannot start %s: %v", exe, err)
			continue
		}
		a.log.Printf("browser: started %s in app mode", filepath.Base(exe))
		browser, browserExe = cmd, exe
		go func() { _ = cmd.Wait(); close(browserDone) }()
		break
	}
	if browser == nil {
		a.log.Printf("browser: no Chromium-based browser found, using the default browser")
		cmd := exec.Command("/usr/bin/open", a.url)
		if err := cmd.Run(); err != nil {
			a.log.Printf("browser: cannot open the default browser: %v", err)
			fatalMessage("GR Mod could not open a browser window.\n\nOpen this address in a browser within a minute to use it:\n\n" + a.url)
			heartbeat.Restart()
		} else {
			a.log.Printf("browser: opened the default browser")
		}
	}

	_ = heartbeat.Wait(ctx, macHeartbeatIdle, heartbeatNever, heartbeatPoll)
	switch {
	case ctx.Err() != nil:
		a.log.Printf("received a signal to quit")
	case heartbeat.Seen():
		a.log.Printf("browser: the page stopped sending heartbeats")
	default:
		a.log.Printf("browser: no page ever connected")
	}
	a.shutdown()

	// The browser was started with a profile of its own, only for GR Mod.
	// On macOS closing its last window leaves it running in the Dock; quit
	// it so that nothing is left behind. When an instance with this profile
	// was already running (left over from an earlier run), the one started
	// here handed the window over to it and exited at once; that instance is
	// found through the profile's lock and quit instead.
	if browser != nil {
		select {
		case <-browserDone:
			if pid := profileOwner(profile, browserExe); pid > 0 {
				a.log.Printf("browser: quitting the instance that took over the window (pid %d)", pid)
				_ = syscall.Kill(pid, syscall.SIGTERM)
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

// macHeartbeatIdle is a little longer than on Windows: here the browser
// window is the normal way of running, and a window in the background can be
// slow to send its next ping. (Sleep does not count: Go's monotonic clock
// stands still while the Mac sleeps.) Opening GR Mod again within this time
// after closing its window does nothing, since the old instance is still
// quitting.
const macHeartbeatIdle = 20 * time.Second

// profileOwner returns the process that holds a Chromium profile, from the
// SingletonLock link Chromium keeps in it ("host-PID"), but only when that
// process is still the browser given by exe; otherwise 0.
func profileOwner(profile, exe string) int {
	target, err := os.Readlink(filepath.Join(profile, "SingletonLock"))
	if err != nil {
		return 0
	}
	pid := chromiumLockPID(target)
	if pid <= 0 || pid == os.Getpid() {
		return 0
	}
	out, err := exec.Command("/bin/ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
	if err != nil || strings.TrimSpace(string(out)) != exe {
		return 0
	}
	return pid
}

func isFile(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
}

// fatalMessage reports a fatal problem in a dialog, since a program started
// from the Finder has no terminal.
func fatalMessage(msg string) {
	fmt.Fprintln(os.Stderr, "grmod: "+msg)
	_ = zenity.Error(msg, zenity.Title(windowTitle), zenity.ErrorIcon)
}
