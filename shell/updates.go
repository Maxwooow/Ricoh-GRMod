package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"grmod/shell/internal/server"
	"grmod/shell/internal/update"
)

// updatePublicKey verifies release manifests (tools/updatesign signs them
// with the matching private key, which is not part of the source).
const updatePublicKey = "SmDyXQIIsZYfZ06bPIdeuzDMvpT4FbELxGu9BuCVx+I="

// updateSources are where releases are looked for, in order: this line's own
// channel first (a release tagged fw1.11 whose files are replaced by every
// 0.8.x release), then the newest release (which a GR Mod for camera firmware
// 1.20 will be one day; its manifest is then only reported, see updateBelow).
var updateSources = []string{
	"https://github.com/Maxwooow/Ricoh-GRMod/releases/download/fw1.11/",
	"https://github.com/Maxwooow/Ricoh-GRMod/releases/latest/download/",
}

// updateBelow ends this line: GR Mod 0.8.x is for GR IV camera firmware 1.11 (and, from 0.8.5,
// GR III 2.10 / GR IIIx 1.60); 0.9 and later are for GR IV 1.20 (a camera updated to 1.20 cannot go
// back), so they are never installed over this copy, only reported.
const updateBelow = "0.9"

// releaseNotesAPI lists the published releases with their text (what's new).
const releaseNotesAPI = "https://api.github.com/repos/Maxwooow/Ricoh-GRMod/releases?per_page=30"

// envReleaseNotes replaces releaseNotesAPI together with envUpdateSource (testing).
const envReleaseNotes = "GRMOD_RELEASE_NOTES"

// envUpdateSource replaces updateSources (testing an update before it is
// published). The signature is still required, so this cannot be used to
// install anything not signed with the project's key.
const envUpdateSource = "GRMOD_UPDATE_SOURCE"

// Command-line flags of the program started by an update.
const (
	afterUpdateFlag = "after-update"
	updatedFromFlag = "updated-from"
)

// updatePlatform names this build's package in a release manifest.
func updatePlatform() string {
	if runtime.GOOS == "darwin" {
		return update.PlatformMac // one universal bundle
	}
	return runtime.GOOS + "-" + runtime.GOARCH
}

// updateTarget is the program as installed, or nil when it cannot be
// replaced (a macOS executable outside a bundle).
func updateTarget() update.Target {
	exe, err := os.Executable()
	if err != nil {
		return nil
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	if runtime.GOOS == "darwin" {
		if b := update.BundleOf(exe); b != "" {
			return &update.BundleTarget{Bundle: b}
		}
		return nil
	}
	return &update.FileTarget{Exe: exe}
}

// experimental reports a test build (a version such as 0.8.0-gr3exp.1). It keeps a data folder
// of its own and never updates itself, so it can neither replace the released GR Mod nor be
// replaced by it.
func experimental() bool { return strings.Contains(version, "exp") }

// experimentalDataSuffix is appended to the default data folder of an experimental build (the
// GR III test builds' folder; a release takes their GR III work over once, migrate.go).
const experimentalDataSuffix = gr3TestDataSuffix

func updateOptions(target update.Target) *server.UpdateOptions {
	if experimental() {
		return nil
	}
	key, err := base64.StdEncoding.DecodeString(updatePublicKey)
	if err != nil {
		return nil
	}
	sources, latest, notes := updateSources, server.DefaultReleasePage, releaseNotesAPI
	if s := strings.TrimSpace(os.Getenv(envUpdateSource)); s != "" {
		sources, latest = []string{s}, ""
		if n := strings.TrimSpace(os.Getenv(envReleaseNotes)); n != "" {
			notes = n
		}
	}
	return &server.UpdateOptions{Key: key, Sources: sources, Platform: updatePlatform(), Target: target, LatestPage: latest, ReleaseNotes: notes, Below: updateBelow}
}

// afterUpdate runs at the start of the program an update has launched: it
// waits until the old program has ended (it still held the window and the
// port) and removes what the update left behind.
func afterUpdate(pid int, target update.Target) {
	if pid <= 0 {
		return
	}
	update.WaitExit(pid, 20*time.Second)
	if target != nil {
		target.Cleanup()
	}
}

// restarter remembers that an update asked for a restart.
type restarter struct {
	once sync.Once
	ch   chan struct{}
}

func newRestarter() *restarter { return &restarter{ch: make(chan struct{})} }

// request is server.Options.Restart.
func (r *restarter) request() { r.once.Do(func() { close(r.ch) }) }

// requested is closed once a restart has been requested.
func (r *restarter) requested() <-chan struct{} { return r.ch }

func (r *restarter) pending() bool {
	select {
	case <-r.ch:
		return true
	default:
		return false
	}
}

// relaunchArgs is the command line of the new program: this one's own
// arguments without the internal ones, plus who to wait for.
func relaunchArgs(args []string, pid int, from string) []string {
	var out []string
	for _, a := range args {
		name := strings.TrimLeft(a, "-")
		if i := strings.IndexByte(name, '='); i >= 0 {
			name = name[:i]
		}
		if strings.HasPrefix(a, "-") && (name == workerFlag || name == afterUpdateFlag || name == updatedFromFlag) {
			continue
		}
		if strings.HasPrefix(a, "-psn_") { // added by old macOS launchers
			continue
		}
		out = append(out, a)
	}
	return append(out, "--"+afterUpdateFlag+"="+strconv.Itoa(pid), "--"+updatedFromFlag+"="+from)
}
