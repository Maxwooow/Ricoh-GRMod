package platform

import (
	"net/url"
	"strconv"
	"strings"
)

// This file interprets what Linux reports about mounts and block devices
// (/proc/self/mountinfo, sysfs, the udev database) and decides which volumes
// are offered. It is compiled everywhere and unit-tested; the files are read
// in linuxsys.go.

// LinuxMount is one line of /proc/self/mountinfo.
type LinuxMount struct {
	Dev        string // "major:minor" of the mounted file system
	Root       string // directory of the file system mounted here ("/" unless a bind or subvolume mount)
	MountPoint string
	FSType     string // "vfat", "exfat", "ext4", "fuseblk", ...
	Source     string // "/dev/sdb1", or whatever a virtual file system names
}

// ParseMountinfo reads /proc/self/mountinfo (proc(5)). Malformed lines are
// skipped.
func ParseMountinfo(data string) []LinuxMount {
	var out []LinuxMount
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		// ID, parent, major:minor, root, mount point, options, optional
		// fields ending with "-", type, source, super options.
		sep := -1
		for i := 6; i < len(fields); i++ {
			if fields[i] == "-" {
				sep = i
				break
			}
		}
		if sep < 0 || sep+2 >= len(fields) {
			continue
		}
		out = append(out, LinuxMount{
			Dev:        fields[2],
			Root:       unescapeMountinfo(fields[3]),
			MountPoint: unescapeMountinfo(fields[4]),
			FSType:     fields[sep+1],
			Source:     unescapeMountinfo(fields[sep+2]),
		})
	}
	return out
}

// unescapeMountinfo undoes the octal escapes the kernel writes for space,
// tab, newline and backslash ("\040", ...).
func unescapeMountinfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// LinuxBlockDevice is what sysfs says about the device under a mount.
type LinuxBlockDevice struct {
	Name      string // the device that holds the file system: "sdb1", "mmcblk0p1", "dm-0"
	Dev       string // its "major:minor"
	Disk      string // the whole disk under it: "sdb", "mmcblk0", "nvme0n1"
	DiskPath  string // the disk's resolved sysfs path, which shows how it is attached
	Removable bool   // /sys/block/<disk>/removable
	MMCType   string // /sys/block/mmcblkN/device/type: "SD", "MMC", ...
}

// LinuxBusName names how a disk is attached, with the names the Windows
// build reports ("USB", "SD", "MMC", ...).
func LinuxBusName(d LinuxBlockDevice) string {
	switch {
	case strings.HasPrefix(d.Disk, "loop"):
		return "Loop"
	case strings.Contains(d.DiskPath, "/usb"):
		// A card in a USB reader is a USB disk (sdX) to Linux.
		return "USB"
	case strings.HasPrefix(d.Disk, "mmcblk"):
		if d.MMCType == "MMC" {
			return "MMC" // soldered eMMC storage
		}
		return "SD"
	case strings.HasPrefix(d.Disk, "nvme"):
		return "NVMe"
	case strings.Contains(d.DiskPath, "/ata"):
		return "SATA"
	case strings.Contains(d.DiskPath, "/virtio"):
		return "Virtio"
	}
	return ""
}

// ClassifyLinuxVolume decides whether a mounted volume is listed and whether
// it is reported as removable, like ClassifyDrive does on Windows. Loop
// devices (mounted disk images) and RAM disks are never offered.
func ClassifyLinuxVolume(d LinuxBlockDevice, all bool) (include, removable bool) {
	bus := LinuxBusName(d)
	if bus == "Loop" || strings.HasPrefix(d.Disk, "zram") || strings.HasPrefix(d.Disk, "ram") {
		return false, false
	}
	if d.Removable || bus == "USB" || bus == "SD" || bus == "MMC" {
		return true, true
	}
	return all, false
}

// IsLocalLinuxFS reports whether a mount type is a disk format that can sit
// on a card or drive (network, virtual and optical file systems are left
// out). fuseblk is a FUSE driver on a block device (ntfs-3g, exfat-fuse).
func IsLocalLinuxFS(fstype string) bool {
	switch fstype {
	case "vfat", "msdos", "exfat", "ntfs", "ntfs3", "fuseblk",
		"ext2", "ext3", "ext4", "btrfs", "xfs", "f2fs", "hfsplus":
		return true
	}
	return false
}

// ParseUdevData reads the properties ("E:KEY=value" lines) of a device's
// entry in the udev database, /run/udev/data/b<major>:<minor>.
func ParseUdevData(data string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(data, "\n") {
		if kv, ok := strings.CutPrefix(line, "E:"); ok {
			if k, v, ok := strings.Cut(kv, "="); ok {
				out[k] = v
			}
		}
	}
	return out
}

// LinuxFSName turns the mount type, helped by udev's ID_FS_TYPE and
// ID_FS_VERSION when known, into the names the Windows build reports:
// "FAT32", "exFAT", "NTFS", ... total is the volume size and only helps when
// udev gave nothing.
func LinuxFSName(fstype string, udev map[string]string, total uint64) string {
	if fstype == "fuseblk" && udev["ID_FS_TYPE"] != "" {
		fstype = udev["ID_FS_TYPE"]
	}
	switch fstype {
	case "vfat", "msdos":
		switch v := strings.ToUpper(udev["ID_FS_VERSION"]); v {
		case "FAT32", "FAT16", "FAT12":
			return v
		}
		// FAT16 cannot exceed 4 GB; anything bigger is FAT32.
		if total > 4<<30 {
			return "FAT32"
		}
		return "FAT"
	case "exfat":
		return "exFAT"
	case "ntfs", "ntfs3":
		return "NTFS"
	case "btrfs":
		return "Btrfs"
	case "hfsplus":
		return "HFS+"
	case "xfs", "f2fs":
		return strings.ToUpper(fstype)
	}
	return fstype
}

// LinuxBrowsers lists Chromium-based browsers that can open an "app" window,
// as commands looked up in PATH, in the order they are tried.
func LinuxBrowsers() []string {
	return []string{
		"google-chrome", "google-chrome-stable",
		"chromium", "chromium-browser",
		"microsoft-edge", "microsoft-edge-stable",
		"brave-browser", "brave",
		"vivaldi", "vivaldi-stable",
	}
}

// LinuxDialogTool chooses the program for the folder dialog: kdialog on KDE
// Plasma (desktop is $XDG_CURRENT_DESKTOP), the zenity family elsewhere, and
// whichever is installed when the preferred one is not; "" when none is.
func LinuxDialogTool(desktop string, installed func(string) bool) string {
	zenity := []string{"qarma", "zenity", "matedialog"} // what github.com/ncruces/zenity runs
	order := append(append([]string{}, zenity...), "kdialog")
	for _, d := range strings.Split(desktop, ":") {
		if strings.EqualFold(d, "KDE") {
			order = append([]string{"kdialog"}, zenity...)
		}
	}
	for _, tool := range order {
		if installed(tool) {
			return tool
		}
	}
	return ""
}

// FileURI is the file:// address of an absolute path, as file managers take
// it over D-Bus. Commas are escaped too, since dbus-send splits array
// arguments at them.
func FileURI(path string) string {
	return strings.ReplaceAll((&url.URL{Scheme: "file", Path: path}).String(), ",", "%2C")
}
