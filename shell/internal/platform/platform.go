// Package platform holds everything that differs between the Windows build
// and the headless development build: volume enumeration, the folder picker,
// the file manager, ejecting and the location of the data directory.
//
// Logic that only interprets Windows data (drive types, bus types, IOCTL
// codes, command lines) lives in winlogic.go, is compiled everywhere and is
// unit-tested on Linux; only the system calls themselves are in windows.go.
package platform

import (
	"errors"
	"strings"
)

// Volume is one entry of GET /api/volumes.
type Volume struct {
	ID        string `json:"id"`
	Root      string `json:"root"`
	Label     string `json:"label"`
	FS        string `json:"fs"`
	Total     uint64 `json:"total"`
	Free      uint64 `json:"free"`
	Removable bool   `json:"removable"`
	Bus       string `json:"bus"`
}

// ErrUnsupported is returned by operations the running build cannot do.
var ErrUnsupported = errors.New("not supported on this platform")

// Host is the operating-system side of the API.
type Host interface {
	// Kind is "windows" or "dev"; it is reported to the page in /host.js.
	Kind() string
	// Volumes lists removable volumes, plus other fixed drives when all is
	// set. Volumes that are not ready are left out.
	Volumes(all bool) ([]Volume, error)
	// ProtectedPaths names locations whose volume must never be offered as
	// a volume (the operating system itself). The server adds the data
	// directory.
	ProtectedPaths() []string
	// PickDirectory shows a native folder dialog. It returns "" when the
	// user cancels.
	PickDirectory(title string) (string, error)
	// Reveal shows the path in the file manager.
	Reveal(path string, isDir bool) error
	// Eject flushes and dismounts a volume so that it can be unplugged.
	Eject(vol Volume) error
}

// DataDirFor computes the default data directory for an operating system
// from its environment. home is the user's home directory and is only used
// on non-Windows systems.
func DataDirFor(goos string, getenv func(string) string, home string) (string, error) {
	if goos == "windows" {
		if v := getenv("LOCALAPPDATA"); v != "" {
			return strings.TrimRight(v, `\/`) + `\GRMod`, nil
		}
		if v := getenv("USERPROFILE"); v != "" {
			return strings.TrimRight(v, `\/`) + `\AppData\Local\GRMod`, nil
		}
		return "", errors.New("neither LOCALAPPDATA nor USERPROFILE is set")
	}
	if v := getenv("XDG_DATA_HOME"); strings.HasPrefix(v, "/") {
		return strings.TrimRight(v, "/") + "/grmod", nil
	}
	if strings.HasPrefix(home, "/") {
		return strings.TrimRight(home, "/") + "/.local/share/grmod", nil
	}
	return "", errors.New("cannot determine the home directory")
}
