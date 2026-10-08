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
	// EnvDevOpened names a file that receives every address the page asks
	// to show in the browser, one per line.
	EnvDevOpened = "GRMOD_DEV_OPENED"
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

// OpenURL has no browser to show anything in; tests read what was asked for
// from the file named by EnvDevOpened.
func (devHost) OpenURL(address string) error {
	address, err := BrowserURL(address)
	if err != nil {
		return err
	}
	file := os.Getenv(EnvDevOpened)
	if file == "" {
		return nil
	}
	f, err := os.OpenFile(file, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(address + "\n")
	return err
}
