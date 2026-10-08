//go:build windows

package platform

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/ncruces/zenity"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// WindowsHost is the real Windows implementation of Host.
//
// None of this file can be executed on the Linux build machine. It is kept
// to plain, documented Win32 calls; every decision that can be separated
// from a system call lives in winlogic.go and is unit-tested.
type WindowsHost struct {
	windowsDir string
	owner      atomic.Uintptr
}

// New returns the Windows host. It also switches off the "there is no disk
// in the drive" system dialogs for this process, so that probing an empty
// card reader fails quietly.
func New() *WindowsHost {
	windows.SetErrorMode(windows.SEM_FAILCRITICALERRORS | windows.SEM_NOOPENFILEERRORBOX)
	dir, err := windows.GetSystemWindowsDirectory()
	if err != nil || DriveOf(dir) == "" {
		drive := DriveOf(os.Getenv("SystemDrive"))
		if drive == "" {
			drive = "C:"
		}
		dir = drive + `\Windows`
	}
	return &WindowsHost{windowsDir: dir}
}

// SetOwnerWindow makes native dialogs modal to the given top-level window
// (an HWND). Zero detaches them again.
func (h *WindowsHost) SetOwnerWindow(hwnd uintptr) { h.owner.Store(hwnd) }

// WindowsDir returns the Windows directory, e.g. C:\Windows.
func (h *WindowsHost) WindowsDir() string { return h.windowsDir }

func (h *WindowsHost) Kind() string { return "windows" }

func (h *WindowsHost) ProtectedPaths() []string { return []string{h.windowsDir} }

func (h *WindowsHost) Volumes(all bool) ([]Volume, error) {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil, fmt.Errorf("GetLogicalDrives: %w", err)
	}
	system := DriveOf(h.windowsDir)
	out := []Volume{}
	for _, id := range DriveLetters(mask) {
		if id == system {
			continue // never probe or offer the system drive
		}
		root := id + `\`
		rootPtr, err := windows.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		driveType := windows.GetDriveType(rootPtr)
		if driveType != DriveRemovable && driveType != DriveFixed {
			continue
		}
		bus := ""
		if b, ok := queryBusType(id); ok {
			bus = BusName(b)
		}
		include, removable := ClassifyDrive(driveType, bus, all)
		if !include {
			continue
		}
		var label, fsName [windows.MAX_PATH + 1]uint16
		if err := windows.GetVolumeInformation(rootPtr,
			&label[0], uint32(len(label)), nil, nil, nil,
			&fsName[0], uint32(len(fsName))); err != nil {
			continue // not ready: empty card reader, unformatted medium, ...
		}
		var free, total, totalFree uint64
		if err := windows.GetDiskFreeSpaceEx(rootPtr, &free, &total, &totalFree); err != nil {
			free, total = 0, 0
		}
		out = append(out, Volume{
			ID:        id,
			Root:      root,
			Label:     windows.UTF16ToString(label[:]),
			FS:        windows.UTF16ToString(fsName[:]),
			Total:     total,
			Free:      free,
			Removable: removable,
			Bus:       bus,
		})
	}
	return out, nil
}

// openVolume opens \\.\X: with the given access rights.
func openVolume(id string, access uint32) (windows.Handle, error) {
	if !IsDriveID(id) {
		return windows.InvalidHandle, errors.New("not a drive letter")
	}
	name, err := windows.UTF16PtrFromString(`\\.\` + DriveOf(id))
	if err != nil {
		return windows.InvalidHandle, err
	}
	return windows.CreateFile(name, access,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil, windows.OPEN_EXISTING, 0, 0)
}

// queryBusType asks the storage stack which bus a drive is attached to. The
// volume is opened with zero access rights, which needs no privileges and
// works for drives without a medium.
func queryBusType(id string) (uint32, bool) {
	h, err := openVolume(id, 0)
	if err != nil {
		return 0, false
	}
	defer windows.CloseHandle(h)

	var query [StoragePropertyQuerySize]byte // StorageDeviceProperty, PropertyStandardQuery
	var out [1024]byte
	var n uint32
	if err := windows.DeviceIoControl(h, IoctlStorageQueryProperty,
		&query[0], uint32(len(query)), &out[0], uint32(len(out)), &n, nil); err != nil {
		return 0, false
	}
	if int(n) > len(out) {
		return 0, false
	}
	bus, _, ok := ParseStorageDeviceDescriptor(out[:n])
	return bus, ok
}

func (h *WindowsHost) PickDirectory(title string) (string, error) {
	opts := []zenity.Option{zenity.Directory()}
	if title != "" {
		opts = append(opts, zenity.Title(title))
	}
	if owner := h.owner.Load(); owner != 0 {
		opts = append(opts, zenity.Attach(owner))
	}
	path, err := zenity.SelectFile(opts...)
	if errors.Is(err, zenity.ErrCanceled) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return path, nil
}

func (h *WindowsHost) Reveal(path string, isDir bool) error {
	explorer := filepath.Join(h.windowsDir, "explorer.exe")
	line, err := ExplorerCommandLine(explorer, path, isDir)
	if err != nil {
		return err
	}
	cmd := exec.Command(explorer)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: line}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait() // Explorer's exit code carries no information
	return nil
}

// Eject follows the sequence Microsoft documents for removable media
// (KB165721): lock the volume, dismount it, allow removal, eject.
//
// Locking only succeeds when no file on the volume is open anywhere, and the
// lock is never forced, so nothing can be lost: if anything is still in use
// the call fails and the volume stays mounted. Once the volume is locked and
// dismounted every buffer has been written, which is what makes unplugging
// safe; the final "eject media" request is a courtesy that some readers do
// not implement, so its failure is not an error.
func (h *WindowsHost) Eject(vol Volume) error {
	handle, err := openVolume(vol.ID, windows.GENERIC_READ|windows.GENERIC_WRITE)
	if err != nil {
		return fmt.Errorf("open volume: %w", err)
	}
	defer windows.CloseHandle(handle)

	ioctl := func(code uint32, in []byte) error {
		var n uint32
		var inPtr *byte
		if len(in) > 0 {
			inPtr = &in[0]
		}
		return windows.DeviceIoControl(handle, code, inPtr, uint32(len(in)), nil, 0, &n, nil)
	}

	_ = windows.FlushFileBuffers(handle)

	for attempt := 0; ; attempt++ {
		if err = ioctl(FsctlLockVolume, nil); err == nil {
			break
		}
		if attempt >= 9 {
			return fmt.Errorf("the volume is in use: %w", err)
		}
		time.Sleep(300 * time.Millisecond)
	}
	if err := ioctl(FsctlDismountVolume, nil); err != nil {
		_ = ioctl(FsctlUnlockVolume, nil)
		return fmt.Errorf("dismount volume: %w", err)
	}
	_ = ioctl(IoctlStorageMediaRemoval, []byte{0}) // PREVENT_MEDIA_REMOVAL{FALSE}
	_ = ioctl(IoctlStorageEjectMedia, nil)
	return nil
}

// Proxy chooses the proxy for an outgoing request: the usual environment
// variables first, then the user's Windows proxy settings (which is where
// the common proxy programs put themselves). The registry is read on every
// call, so a change takes effect without a restart.
func (h *WindowsHost) Proxy(req *http.Request) (*url.URL, error) {
	if u, err := http.ProxyFromEnvironment(req); u != nil || err != nil {
		return u, err
	}
	return readProxySettings().ProxyFor(req.URL), nil
}

func readProxySettings() ProxySettings {
	var p ProxySettings
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return p
	}
	defer key.Close()
	if v, _, err := key.GetIntegerValue("ProxyEnable"); err == nil {
		p.Enable = v != 0
	}
	p.Server, _, _ = key.GetStringValue("ProxyServer")
	p.Override, _, _ = key.GetStringValue("ProxyOverride")
	return p
}

// OpenURL shows a web address in the user's default browser.
func (h *WindowsHost) OpenURL(address string) error {
	address, err := BrowserURL(address)
	if err != nil {
		return err
	}
	cmd := exec.Command(filepath.Join(h.windowsDir, "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", address)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
