//go:build !windows

package platform

import (
	"os"
	"path/filepath"
)

// Environment variables that drive the development build.
const (
	EnvDevVolumes = "GRMOD_DEV_VOLUMES"
	EnvDevPick    = "GRMOD_DEV_PICK"
)

// New returns the host for the headless development build: volumes and the
// "picked" folder come from environment variables, which are read on every
// call so that tests can change them while the server runs.
func New() Host { return devHost{} }

type devHost struct{}

func (devHost) Kind() string { return "dev" }

func (devHost) Volumes(all bool) ([]Volume, error) {
	out := []Volume{}
	seen := map[string]bool{}
	for _, dir := range filepath.SplitList(os.Getenv(EnvDevVolumes)) {
		if dir == "" {
			continue
		}
		abs, err := filepath.Abs(dir)
		if err != nil || seen[abs] {
			continue
		}
		if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
			continue // like a drive without media
		}
		seen[abs] = true
		total, free := diskUsage(abs)
		name := filepath.Base(abs)
		out = append(out, Volume{
			ID: name, Root: abs, Label: name, FS: "DEV",
			Total: total, Free: free, Removable: true, Bus: "DEV",
		})
	}
	return out, nil
}

func (devHost) ProtectedPaths() []string { return []string{"/"} }

func (devHost) PickDirectory(title string) (string, error) {
	dir := os.Getenv(EnvDevPick)
	if dir == "" {
		return "", nil
	}
	return filepath.Abs(dir)
}

func (devHost) Reveal(path string, isDir bool) error { return nil }

func (devHost) Eject(vol Volume) error { return ErrUnsupported }
