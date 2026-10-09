package main

import (
	"strconv"
	"strings"
	"time"
)

// Heartbeat rule for a UI that runs in a browser window the shell does not
// own: stop when the page has been silent for heartbeatIdle after at least
// one request, or when no request arrives at all within heartbeatNever.
const (
	heartbeatIdle  = 15 * time.Second
	heartbeatNever = 60 * time.Second
	heartbeatPoll  = time.Second
)

// edgeCandidates lists the places where msedge.exe is installed, in the
// order they are tried. getenv is os.Getenv; it is a parameter so that the
// list can be tested on any system.
func edgeCandidates(getenv func(string) string) []string {
	var out []string
	for _, name := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		dir := strings.TrimRight(getenv(name), `\/`)
		if dir == "" {
			continue
		}
		out = append(out, dir+`\Microsoft\Edge\Application\msedge.exe`)
	}
	return out
}

// findEdge returns the first candidate that exists, or "".
func findEdge(getenv func(string) string, isFile func(string) bool) string {
	for _, c := range edgeCandidates(getenv) {
		if isFile(c) {
			return c
		}
	}
	return ""
}

// edgeArgs is the command line that opens url as a chromeless "app" window
// with its own profile directory.
func edgeArgs(url, userDataDir string) []string {
	return []string{
		"--app=" + url,
		"--user-data-dir=" + userDataDir,
		"--window-size=1180,800",
		"--disable-pinch",
		"--overscroll-history-navigation=0",
		"--no-first-run",
		"--no-default-browser-check",
	}
}

// chromiumLockPID extracts the process ID from the target of a Chromium
// profile's SingletonLock link, which is "<host name>-<pid>"; 0 when there
// is none.
func chromiumLockPID(target string) int {
	i := strings.LastIndexByte(target, '-')
	if i < 0 {
		return 0
	}
	pid, err := strconv.Atoi(target[i+1:])
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}
