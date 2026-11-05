//go:build linux

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLinuxProfileOwner(t *testing.T) {
	profile := filepath.Join(t.TempDir(), "browser")
	if err := os.Mkdir(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(profile, "SingletonLock")
	setLock := func(target string) {
		t.Helper()
		os.Remove(lock)
		if err := os.Symlink(target, lock); err != nil {
			t.Fatal(err)
		}
	}
	// A stand-in for the browser: a process whose command line carries the
	// profile, as an argument of its own or, like Chromium's browser
	// process, inside one string separated by spaces. ("; :" keeps the shell
	// from replacing itself with sleep.)
	start := func(arg string) *exec.Cmd {
		t.Helper()
		cmd := exec.Command("/bin/sh", "-c", "sleep 30; :", arg)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
		// Until the child has called exec, its command line is this one's.
		proc := "/proc/" + strconv.Itoa(cmd.Process.Pid) + "/cmdline"
		for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(5 * time.Millisecond) {
			if b, _ := os.ReadFile(proc); strings.Contains(string(b), "--user-data-dir=") {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the stand-in browser did not start")
			}
		}
		return cmd
	}

	if pid := linuxProfileOwner(profile); pid != 0 {
		t.Errorf("no lock: %d", pid)
	}

	for _, arg := range []string{
		"--user-data-dir=" + profile,
		"/opt/google/chrome/chrome --user-data-dir=" + profile + " --no-first-run",
	} {
		owner := start(arg)
		setLock("myhost-" + strconv.Itoa(owner.Process.Pid))
		if pid := linuxProfileOwner(profile); pid != owner.Process.Pid {
			t.Errorf("running owner %q: %d, want %d", arg, pid, owner.Process.Pid)
		}
	}

	// A process with another profile, this process itself, a process that
	// has ended and an unreadable lock are not owners.
	other := start("chrome --user-data-dir=" + profile + "-other --no-first-run")
	setLock("myhost-" + strconv.Itoa(other.Process.Pid))
	if pid := linuxProfileOwner(profile); pid != 0 {
		t.Errorf("other profile: %d", pid)
	}
	setLock("myhost-" + strconv.Itoa(os.Getpid()))
	if pid := linuxProfileOwner(profile); pid != 0 {
		t.Errorf("own pid: %d", pid)
	}
	ended := exec.Command("/bin/true")
	if err := ended.Run(); err != nil {
		t.Fatal(err)
	}
	setLock("myhost-" + strconv.Itoa(ended.Process.Pid))
	if pid := linuxProfileOwner(profile); pid != 0 {
		t.Errorf("ended process: %d", pid)
	}
	setLock("garbage")
	if pid := linuxProfileOwner(profile); pid != 0 {
		t.Errorf("malformed lock: %d", pid)
	}
}

func TestHasArg(t *testing.T) {
	const arg = "--user-data-dir=/d/browser"
	cases := map[string]bool{
		"chrome\x00--app=x\x00--user-data-dir=/d/browser\x00":           true,
		"--user-data-dir=/d/browser":                                    true,
		"/opt/chrome --user-data-dir=/d/browser --no-first-run":         true,
		"chrome --user-data-dir=/d/browser-other":                       false,
		"chrome --user-data-dir=/d/browser2 --user-data-dir=/d/browser": true,
		"chrome x--user-data-dir=/d/browser":                            false,
		"chrome\x00--user-data-dir=/d/browse\x00":                       false,
		"": false,
	}
	for cmdline, want := range cases {
		if got := hasArg(cmdline, arg); got != want {
			t.Errorf("hasArg(%q) = %v, want %v", cmdline, got, want)
		}
	}
}
