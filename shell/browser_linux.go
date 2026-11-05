//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// linuxProfileOwner returns the process that holds a Chromium profile, from
// the SingletonLock link Chromium keeps in it ("host-PID"), but only while
// that process is still a browser started with this profile; otherwise 0.
func linuxProfileOwner(profile string) int {
	target, err := os.Readlink(filepath.Join(profile, "SingletonLock"))
	if err != nil {
		return 0
	}
	pid := chromiumLockPID(target)
	if pid <= 0 || pid == os.Getpid() {
		return 0
	}
	cmdline, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil || !hasArg(string(cmdline), "--user-data-dir="+profile) {
		return 0
	}
	return pid
}

// hasArg reports whether a /proc/PID/cmdline holds arg as one whole
// argument. The arguments are separated by NUL bytes, except in Chromium's
// browser process, which rewrites its command line as one string separated
// by spaces (so that ps shows it in full).
func hasArg(cmdline, arg string) bool {
	sep := func(c byte) bool { return c == 0 || c == ' ' }
	for i := 0; i < len(cmdline); {
		j := strings.Index(cmdline[i:], arg)
		if j < 0 {
			return false
		}
		start, end := i+j, i+j+len(arg)
		if (start == 0 || sep(cmdline[start-1])) && (end == len(cmdline) || sep(cmdline[end])) {
			return true
		}
		i = start + 1
	}
	return false
}
