//go:build darwin

package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func New() Host {
	// Explicit development settings keep integration tests away from real media.
	if _, ok := os.LookupEnv(EnvDevVolumes); ok {
		return devHost{}
	}
	return macHost{}
}

type macHost struct{}

func (macHost) Kind() string             { return "macos" }
func (macHost) ProtectedPaths() []string { return []string{"/", "/System/Volumes/Data"} }

func macDiskInfo(root string) (macDisk, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	data, err := exec.CommandContext(ctx, "/usr/sbin/diskutil", "info", "-plist", root).Output()
	if err != nil {
		return macDisk{}, err
	}
	convert := exec.CommandContext(ctx, "/usr/bin/plutil", "-convert", "json", "-o", "-", "--", "-")
	convert.Stdin = bytes.NewReader(data)
	data, err = convert.Output()
	if err != nil {
		return macDisk{}, err
	}
	var info macDisk
	err = json.Unmarshal(data, &info)
	return info, err
}

func (macHost) Volumes(all bool) ([]Volume, error) {
	entries, err := os.ReadDir("/Volumes")
	if err != nil {
		return nil, err
	}
	out := []Volume{}
	for _, e := range entries {
		// Macintosh HD is normally a symlink to /; never follow it.
		if !e.IsDir() || e.Type()&os.ModeSymlink != 0 {
			continue
		}
		root := filepath.Join("/Volumes", e.Name())
		info, err := macDiskInfo(root)
		if err != nil {
			continue
		} // detached during enumeration, or no mounted media
		v, ok := macVolume(info, root, all)
		if !ok {
			continue
		}
		v.Total, v.Free = diskUsage(root)
		out = append(out, v)
	}
	return out, nil
}

func (macHost) PickDirectory(title string) (string, error) {
	// Pass the prompt as an argument, never as AppleScript source.
	out, err := exec.Command("/usr/bin/osascript", "-e", "on run argv", "-e",
		"return POSIX path of (choose folder with prompt (item 1 of argv))", "-e", "end run", title).CombinedOutput()
	if err != nil {
		if strings.Contains(string(out), "(-128)") {
			return "", nil
		}
		return "", fmt.Errorf("folder picker: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

func (macHost) Reveal(path string, isDir bool) error {
	if isDir {
		return exec.Command("/usr/bin/open", path).Run()
	}
	return exec.Command("/usr/bin/open", "-R", path).Run()
}

func (macHost) Eject(vol Volume) error {
	// Re-read the exact mounted root; do not eject a reused or arbitrary device ID.
	info, err := macDiskInfo(vol.Root)
	if err != nil {
		return err
	}
	current, ok := macVolume(info, vol.Root, false)
	if !ok || current.ID != vol.ID {
		return fmt.Errorf("removable volume has changed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "/usr/sbin/diskutil", "eject", current.ID).Run()
}

func (macHost) OpenURL(address string) error {
	address, err := BrowserURL(address)
	if err != nil {
		return err
	}
	return exec.Command("/usr/bin/open", address).Run()
}
