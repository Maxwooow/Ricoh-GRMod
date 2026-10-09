//go:build darwin

package platform

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ncruces/zenity"
	"golang.org/x/sys/unix"
)

// MacHost is the macOS implementation of Host.
//
// None of this file can be executed on the Linux build machine. It only
// calls statfs and the system's own command-line tools (diskutil, open,
// scutil); every decision about their output lives in maclogic.go and is
// unit-tested.
type MacHost struct {
	proxyMu   sync.Mutex
	proxyAt   time.Time
	proxyConf ProxySettings

	// diskutil takes a noticeable moment and Volumes runs on every file
	// request (to know the allowed roots), so its answer is kept per mount
	// point for as long as the same device stays mounted there.
	infoMu    sync.Mutex
	infoCache map[string]cachedInfo
}

type cachedInfo struct {
	device string
	info   MacDiskInfo
	err    error
	at     time.Time
}

const diskInfoTTL = 30 * time.Second

// New returns the macOS host.
func New() *MacHost { return &MacHost{} }

func (h *MacHost) Kind() string { return "mac" }

// ProtectedPaths: the start-up volume, also reachable as /Volumes/Macintosh
// HD (a symbolic link to /), and its data volume.
func (h *MacHost) ProtectedPaths() []string {
	return []string{"/", "/System/Volumes/Data"}
}

const diskutilTimeout = 5 * time.Second

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

func (h *MacHost) Volumes(all bool) ([]Volume, error) {
	// getfsstat with MNT_NOWAIT returns the kernel's mount table without
	// asking any file system, so a dead network mount cannot block it.
	n, err := unix.Getfsstat(nil, unix.MNT_NOWAIT)
	if err != nil {
		return nil, fmt.Errorf("getfsstat: %w", err)
	}
	mounts := make([]unix.Statfs_t, n+8)
	if n, err = unix.Getfsstat(mounts, unix.MNT_NOWAIT); err != nil {
		return nil, fmt.Errorf("getfsstat: %w", err)
	}
	mounts = mounts[:n]

	out := []Volume{}
	for i := range mounts {
		m := &mounts[i]
		root := unix.ByteSliceToString(m.Mntonname[:])
		fstype := unix.ByteSliceToString(m.Fstypename[:])
		// Cards and drives are mounted directly below /Volumes; the start-up
		// disk is mounted at / (/Volumes/Macintosh HD is only a link to it).
		if !IsVolumesMount(root) || m.Flags&unix.MNT_LOCAL == 0 || !IsLocalMacFS(fstype) {
			continue
		}
		if isDir(filepath.Join(root, "Backups.backupdb")) {
			continue // a Time Machine backup disk
		}
		// Fresh sizes; asking a local file system does not hang.
		st := *m
		if err := unix.Statfs(root, &st); err != nil {
			continue // not ready
		}
		total := st.Blocks * uint64(st.Bsize)
		free := st.Bavail * uint64(st.Bsize)

		info, derr := h.diskInfo(root, unix.ByteSliceToString(st.Mntfromname[:]))
		var include, removable bool
		visibleFS, bus := "", ""
		if derr == nil {
			include, removable = ClassifyMacVolume(info, all)
			visibleFS, bus = info.FilesystemName, MacBusName(info.BusProtocol)
		} else {
			// Without diskutil, a FAT or exFAT volume is almost certainly a
			// card or a stick.
			removable = fstype == "msdos" || fstype == "exfat"
			include = removable || all
		}
		if !include {
			continue
		}
		name := filepath.Base(root)
		label := name
		if derr == nil && info.VolumeName != "" {
			label = info.VolumeName
		}
		out = append(out, Volume{
			ID:        name,
			Root:      root,
			Label:     label,
			FS:        MacFSName(visibleFS, fstype, total),
			Total:     total,
			Free:      free,
			Removable: removable,
			Bus:       bus,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Removable != out[j].Removable {
			return out[i].Removable
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// isMountPoint reports whether root is currently a mount point.
func isMountPoint(root string) bool {
	var st unix.Statfs_t
	if err := unix.Statfs(root, &st); err != nil {
		return false
	}
	return filepath.Clean(unix.ByteSliceToString(st.Mntonname[:])) == filepath.Clean(root)
}

func (h *MacHost) diskInfo(mountPoint, device string) (MacDiskInfo, error) {
	h.infoMu.Lock()
	if c, ok := h.infoCache[mountPoint]; ok && c.device == device && time.Since(c.at) < diskInfoTTL {
		h.infoMu.Unlock()
		return c.info, c.err
	}
	h.infoMu.Unlock()

	var info MacDiskInfo
	out, err := runTool(diskutilTimeout, "/usr/sbin/diskutil", "info", "-plist", mountPoint)
	if err == nil {
		info, err = ParseDiskutilInfo(out)
	}

	h.infoMu.Lock()
	if h.infoCache == nil {
		h.infoCache = map[string]cachedInfo{}
	}
	h.infoCache[mountPoint] = cachedInfo{device: device, info: info, err: err, at: time.Now()}
	h.infoMu.Unlock()
	return info, err
}

func (h *MacHost) PickDirectory(title string) (string, error) {
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
	return strings.TrimRight(p, "/"), nil
}

// Reveal opens a folder in the Finder, or selects a file in its folder.
func (h *MacHost) Reveal(path string, isDir bool) error {
	if !strings.HasPrefix(path, "/") {
		return errors.New("not an absolute path")
	}
	// "open" on a folder whose name has an extension (X.app, Y.pkg,
	// Z.photoslibrary) would launch it; select such a folder instead.
	args := []string{"-R", path}
	if isDir && filepath.Ext(filepath.Clean(path)) == "" {
		args = []string{path}
	}
	cmd := exec.Command("/usr/bin/open", args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

// Eject writes everything out and unmounts the volume's disk with diskutil,
// which refuses (and leaves the volume mounted) while a file on it is open.
func (h *MacHost) Eject(vol Volume) error {
	if !IsVolumesMount(vol.Root) {
		return errors.New("not a volume")
	}
	unix.Sync()
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		_, err := runTool(30*time.Second, "/usr/sbin/diskutil", "eject", vol.Root)
		if err == nil || !isMountPoint(vol.Root) {
			// Unmounted is what matters; a reader that cannot "eject" the
			// medium itself is not an error (as on Windows).
			return nil
		}
		last = err
		time.Sleep(700 * time.Millisecond)
	}
	return fmt.Errorf("the volume is in use: %w", last)
}

// Proxy chooses the proxy for an outgoing request: the usual environment
// variables first, then the system proxy settings (System Settings ›
// Network › Proxies, which is also where proxy apps put themselves). The
// settings are read at most every few seconds.
func (h *MacHost) Proxy(req *http.Request) (*url.URL, error) {
	if u, err := http.ProxyFromEnvironment(req); u != nil || err != nil {
		return u, err
	}
	h.proxyMu.Lock()
	if time.Since(h.proxyAt) > 5*time.Second {
		h.proxyConf = ProxySettings{}
		if out, err := runTool(3*time.Second, "/usr/sbin/scutil", "--proxy"); err == nil {
			h.proxyConf = ParseScutilProxy(string(out))
		}
		h.proxyAt = time.Now()
	}
	conf := h.proxyConf
	h.proxyMu.Unlock()
	return conf.ProxyFor(req.URL), nil
}

// OpenURL shows a web address in the user's default browser.
func (h *MacHost) OpenURL(address string) error {
	address, err := BrowserURL(address)
	if err != nil {
		return err
	}
	cmd := exec.Command("/usr/bin/open", address)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
