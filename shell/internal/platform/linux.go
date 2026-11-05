//go:build linux && desktop

package platform

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ncruces/zenity"
)

// LinuxHost is the Linux implementation of Host, compiled with the build tag
// "desktop" (./build.sh linux). Without the tag, Linux gets the headless
// development host of dev.go.
//
// Volumes are read from /proc/self/mountinfo, sysfs and the udev database
// (linuxsys.go, decisions in linuxlogic.go, both unit-tested). Everything
// else calls the desktop's own tools: udisksctl to unmount, kdialog or
// zenity for the folder dialog, the file manager over D-Bus and xdg-open.
type LinuxHost struct {
	sys LinuxSystem
}

// New returns the Linux host.
func New() *LinuxHost { return &LinuxHost{sys: DefaultLinuxSystem()} }

func (h *LinuxHost) Kind() string { return "linux" }

func (h *LinuxHost) ProtectedPaths() []string { return []string{"/"} }

func (h *LinuxHost) Volumes(all bool) ([]Volume, error) { return h.sys.Volumes(all) }

func runTool(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(string(out))
		}
		if msg != "" {
			return out, fmt.Errorf("%s: %w: %s", name, err, msg)
		}
		return out, fmt.Errorf("%s: %w", name, err)
	}
	return out, nil
}

// startTool starts a program and does not wait for it.
func startTool(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

func installed(tool string) bool {
	_, err := exec.LookPath(tool)
	return err == nil
}

func dialogTool() string {
	return LinuxDialogTool(os.Getenv("XDG_CURRENT_DESKTOP"), installed)
}

func (h *LinuxHost) PickDirectory(title string) (string, error) {
	switch dialogTool() {
	case "":
		return "", errors.New("no folder dialog: install kdialog or zenity")
	case "kdialog":
		home, _ := os.UserHomeDir()
		args := []string{"--getexistingdirectory", home}
		if title != "" {
			args = append([]string{"--title", title}, args...)
		}
		out, err := exec.Command("kdialog", args...).Output()
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 {
			return "", nil // cancelled
		}
		if err != nil {
			return "", fmt.Errorf("kdialog: %w", err)
		}
		return cleanPicked(string(out)), nil
	}
	opts := []zenity.Option{zenity.Directory()}
	if title != "" {
		opts = append(opts, zenity.Title(title))
	}
	p, err := zenity.SelectFile(opts...)
	if errors.Is(err, zenity.ErrCanceled) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return cleanPicked(p), nil
}

func cleanPicked(p string) string {
	p = strings.TrimSuffix(p, "\n")
	if p == "/" {
		return p
	}
	return strings.TrimRight(p, "/")
}

// Reveal opens a folder in the file manager, or selects a file in its
// folder through the file manager's D-Bus interface (Dolphin, Nautilus,
// Nemo, ...). Without one, the file's folder is opened.
func (h *LinuxHost) Reveal(path string, isDir bool) error {
	if !strings.HasPrefix(path, "/") {
		return errors.New("not an absolute path")
	}
	if !isDir {
		_, err := runTool(10*time.Second, "dbus-send", "--session", "--print-reply",
			"--dest=org.freedesktop.FileManager1", "/org/freedesktop/FileManager1",
			"org.freedesktop.FileManager1.ShowItems", "array:string:"+FileURI(path), "string:")
		if err == nil {
			return nil
		}
		path = filepath.Dir(path)
	}
	return startTool("xdg-open", path)
}

// Eject writes everything out and unmounts the volume with udisksctl (the
// same service the file manager uses), which refuses (and leaves the
// volume mounted) while a file on it is open. After that the card can be
// taken out; the reader itself is left switched on.
func (h *LinuxHost) Eject(vol Volume) error {
	m, ok := h.sys.MountAt(vol.Root)
	if !ok {
		return errors.New("not mounted")
	}
	d, err := h.sys.BlockOfSource(m.Source)
	if err != nil {
		return err
	}
	syscall.Sync()
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		_, err := runTool(30*time.Second, "udisksctl", "unmount", "--no-user-interaction", "--block-device", "/dev/"+d.Name)
		if err == nil {
			return nil
		}
		if _, still := h.sys.MountAt(vol.Root); !still {
			return nil
		}
		last = err
		time.Sleep(700 * time.Millisecond)
	}
	return fmt.Errorf("the volume is in use: %w", last)
}

// OpenURL shows a web address in the user's default browser.
func (h *LinuxHost) OpenURL(address string) error {
	address, err := BrowserURL(address)
	if err != nil {
		return err
	}
	return startTool("xdg-open", address)
}

// ErrorDialog shows a message in an error dialog, if the desktop has a tool
// for one.
func ErrorDialog(title, msg string) {
	switch dialogTool() {
	case "":
	case "kdialog":
		_ = exec.Command("kdialog", "--title", title, "--error", msg).Run()
	default:
		_ = zenity.Error(msg, zenity.Title(title), zenity.ErrorIcon)
	}
}
