package platform

import (
	"reflect"
	"testing"
)

// Trimmed from a real /proc/self/mountinfo, plus a card whose label has a
// space and a mount with optional fields of its own.
const mountinfoSample = `45 1 0:40 /@/.snapshots/565/snapshot / rw,relatime shared:1 - btrfs /dev/nvme0n1p2 rw,ssd,subvolid=840
47 45 0:26 / /sys rw,nosuid,nodev,noexec,relatime shared:5 - sysfs sysfs rw
42 45 0:49 /@/home /home rw,relatime shared:53 - btrfs /dev/nvme0n1p2 rw,ssd,subvolid=262,subvol=/@/home
97 45 259:1 / /boot/efi rw,relatime shared:63 - vfat /dev/nvme0n1p1 rw,fmask=0022,dmask=0022
401 104 0:127 / /run/user/1000/gvfs rw,nosuid,nodev,relatime shared:1359 - fuse.gvfsd-fuse gvfsd-fuse rw,user_id=1000
512 55 179:1 / /run/media/sata/NO\040NAME rw,nosuid,nodev,relatime shared:700 master:12 - vfat /dev/mmcblk0p1 rw,uid=1000
513 55 8:1 / /run/media/sata/back\134slash rw shared:701 - exfat /dev/sda1 rw
bad line
514 55 8:2 / /mnt/x rw - vfat
`

func TestParseMountinfo(t *testing.T) {
	got := ParseMountinfo(mountinfoSample)
	want := []LinuxMount{
		{Dev: "0:40", Root: "/@/.snapshots/565/snapshot", MountPoint: "/", FSType: "btrfs", Source: "/dev/nvme0n1p2"},
		{Dev: "0:26", Root: "/", MountPoint: "/sys", FSType: "sysfs", Source: "sysfs"},
		{Dev: "0:49", Root: "/@/home", MountPoint: "/home", FSType: "btrfs", Source: "/dev/nvme0n1p2"},
		{Dev: "259:1", Root: "/", MountPoint: "/boot/efi", FSType: "vfat", Source: "/dev/nvme0n1p1"},
		{Dev: "0:127", Root: "/", MountPoint: "/run/user/1000/gvfs", FSType: "fuse.gvfsd-fuse", Source: "gvfsd-fuse"},
		{Dev: "179:1", Root: "/", MountPoint: "/run/media/sata/NO NAME", FSType: "vfat", Source: "/dev/mmcblk0p1"},
		{Dev: "8:1", Root: "/", MountPoint: `/run/media/sata/back\slash`, FSType: "exfat", Source: "/dev/sda1"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
	if got := ParseMountinfo(""); len(got) != 0 {
		t.Errorf("empty input: %+v", got)
	}
}

func TestUnescapeMountinfo(t *testing.T) {
	cases := map[string]string{
		`plain`:             `plain`,
		`a\040b`:            `a b`,
		`tab\011nl\012`:     "tab\tnl\n",
		`\134`:              `\`,
		`end\04`:            `end\04`, // too short to be an escape
		`not\999octal`:      `not\999octal`,
		`\040\040twice\040`: `  twice `,
	}
	for in, want := range cases {
		if got := unescapeMountinfo(in); got != want {
			t.Errorf("unescapeMountinfo(%q) = %q, want %q", in, got, want)
		}
	}
}

// Disk paths as sysfs resolves them.
const (
	sysUSBReader = "/sys/devices/pci0000:00/0000:00:14.0/usb3/3-1/3-1:1.0/host0/target0:0:0/0:0:0:0/block/sda"
	sysSDSlot    = "/sys/devices/pci0000:00/0000:00:1c.0/0000:02:00.0/rtsx_pci_sdmmc.0/mmc_host/mmc0/mmc0:aaaa/block/mmcblk0"
	sysNVMe      = "/sys/devices/pci0000:00/0000:00:02.4/0000:03:00.0/nvme/nvme0/nvme0n1"
	sysSATA      = "/sys/devices/pci0000:00/0000:00:17.0/ata1/host1/target1:0:0/1:0:0:0/block/sdb"
	sysVirtio    = "/sys/devices/pci0000:00/0000:00:04.0/virtio1/block/vda"
	sysLoop      = "/sys/devices/virtual/block/loop0"
	sysZram      = "/sys/devices/virtual/block/zram0"
)

func TestClassifyLinuxVolume(t *testing.T) {
	cases := []struct {
		name          string
		dev           LinuxBlockDevice
		bus           string
		incl, inclAll bool
		removable     bool
	}{
		{"card in a USB reader", LinuxBlockDevice{Disk: "sda", DiskPath: sysUSBReader, Removable: true}, "USB", true, true, true},
		{"USB SSD (not removable media)", LinuxBlockDevice{Disk: "sda", DiskPath: sysUSBReader}, "USB", true, true, true},
		{"card in a built-in slot", LinuxBlockDevice{Disk: "mmcblk0", DiskPath: sysSDSlot, MMCType: "SD"}, "SD", true, true, true},
		{"slot, type unknown", LinuxBlockDevice{Disk: "mmcblk0", DiskPath: sysSDSlot}, "SD", true, true, true},
		{"eMMC", LinuxBlockDevice{Disk: "mmcblk1", DiskPath: sysSDSlot, MMCType: "MMC"}, "MMC", true, true, true},
		{"NVMe SSD", LinuxBlockDevice{Disk: "nvme0n1", DiskPath: sysNVMe}, "NVMe", false, true, false},
		{"SATA disk", LinuxBlockDevice{Disk: "sdb", DiskPath: sysSATA}, "SATA", false, true, false},
		{"removable SATA (eSATA dock)", LinuxBlockDevice{Disk: "sdb", DiskPath: sysSATA, Removable: true}, "SATA", true, true, true},
		{"virtual machine disk", LinuxBlockDevice{Disk: "vda", DiskPath: sysVirtio}, "Virtio", false, true, false},
		{"disk image", LinuxBlockDevice{Disk: "loop0", DiskPath: sysLoop}, "Loop", false, false, false},
		{"disk image marked removable", LinuxBlockDevice{Disk: "loop0", DiskPath: sysLoop, Removable: true}, "Loop", false, false, false},
		{"RAM disk", LinuxBlockDevice{Disk: "zram0", DiskPath: sysZram}, "", false, false, false},
		{"unknown", LinuxBlockDevice{Disk: "xyz", DiskPath: "/sys/devices/platform/xyz"}, "", false, true, false},
	}
	for _, c := range cases {
		if bus := LinuxBusName(c.dev); bus != c.bus {
			t.Errorf("%s: bus %q, want %q", c.name, bus, c.bus)
		}
		incl, rem := ClassifyLinuxVolume(c.dev, false)
		if incl != c.incl || (incl && rem != c.removable) {
			t.Errorf("%s: default listing include=%v removable=%v, want %v/%v", c.name, incl, rem, c.incl, c.removable)
		}
		incl, rem = ClassifyLinuxVolume(c.dev, true)
		if incl != c.inclAll || rem != c.removable {
			t.Errorf("%s: all=1 include=%v removable=%v, want %v/%v", c.name, incl, rem, c.inclAll, c.removable)
		}
	}
}

func TestIsLocalLinuxFS(t *testing.T) {
	for _, fs := range []string{"vfat", "exfat", "fuseblk", "ntfs3", "ext4", "btrfs"} {
		if !IsLocalLinuxFS(fs) {
			t.Errorf("%s must count as local", fs)
		}
	}
	for _, fs := range []string{"nfs4", "cifs", "tmpfs", "sysfs", "fuse.gvfsd-fuse", "fuse.portal", "iso9660", "squashfs", "overlay", ""} {
		if IsLocalLinuxFS(fs) {
			t.Errorf("%s must not count as local", fs)
		}
	}
}

func TestParseUdevData(t *testing.T) {
	data := "S:disk/by-uuid/7A95-D15F\nI:1234\nE:ID_FS_VERSION=FAT32\nE:ID_FS_TYPE=vfat\nE:ID_FS_LABEL=GR=CARD\nG:systemd\n"
	got := ParseUdevData(data)
	want := map[string]string{"ID_FS_VERSION": "FAT32", "ID_FS_TYPE": "vfat", "ID_FS_LABEL": "GR=CARD"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestLinuxFSName(t *testing.T) {
	const gb = 1 << 30
	cases := []struct {
		fstype string
		udev   map[string]string
		total  uint64
		want   string
	}{
		{"vfat", map[string]string{"ID_FS_VERSION": "FAT32"}, 2 * gb, "FAT32"}, // small FAT32 card
		{"vfat", map[string]string{"ID_FS_VERSION": "FAT16"}, 2 * gb, "FAT16"},
		{"vfat", map[string]string{"ID_FS_VERSION": "fat12"}, 1 << 20, "FAT12"},
		{"vfat", nil, 32 * gb, "FAT32"},
		{"vfat", nil, 2 * gb, "FAT"},
		{"msdos", map[string]string{}, 8 * gb, "FAT32"},
		{"exfat", nil, 64 * gb, "exFAT"},
		{"fuseblk", map[string]string{"ID_FS_TYPE": "exfat"}, 64 * gb, "exFAT"},
		{"fuseblk", map[string]string{"ID_FS_TYPE": "ntfs"}, 64 * gb, "NTFS"},
		{"fuseblk", nil, 64 * gb, "fuseblk"},
		{"ntfs3", nil, 0, "NTFS"},
		{"ext4", nil, 0, "ext4"},
		{"xfs", nil, 0, "XFS"},
		{"btrfs", nil, 0, "Btrfs"},
		{"hfsplus", nil, 0, "HFS+"},
	}
	for _, c := range cases {
		if got := LinuxFSName(c.fstype, c.udev, c.total); got != c.want {
			t.Errorf("LinuxFSName(%q, %v, %d) = %q, want %q", c.fstype, c.udev, c.total, got, c.want)
		}
	}
}

func TestLinuxDialogTool(t *testing.T) {
	have := func(tools ...string) func(string) bool {
		return func(s string) bool {
			for _, t := range tools {
				if s == t {
					return true
				}
			}
			return false
		}
	}
	cases := []struct {
		desktop string
		tools   []string
		want    string
	}{
		{"KDE", []string{"zenity", "kdialog"}, "kdialog"},
		{"ubuntu:GNOME", []string{"zenity", "kdialog"}, "zenity"},
		{"GNOME", []string{"kdialog"}, "kdialog"},
		{"KDE", []string{"zenity"}, "zenity"},
		{"", []string{"qarma", "zenity"}, "qarma"},
		{"XFCE", []string{"matedialog"}, "matedialog"},
		{"kde", nil, ""},
	}
	for _, c := range cases {
		if got := LinuxDialogTool(c.desktop, have(c.tools...)); got != c.want {
			t.Errorf("desktop %q with %v: %q, want %q", c.desktop, c.tools, got, c.want)
		}
	}
}

func TestFileURI(t *testing.T) {
	cases := map[string]string{
		"/run/media/sata/NO NAME/fwdc.bin": "file:///run/media/sata/NO%20NAME/fwdc.bin",
		"/home/u/a,b.jpg":                  "file:///home/u/a%2Cb.jpg",
		"/home/u/100%/x#y?.txt":            "file:///home/u/100%25/x%23y%3F.txt",
	}
	for in, want := range cases {
		if got := FileURI(in); got != want {
			t.Errorf("FileURI(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLinuxBrowsers(t *testing.T) {
	seen := map[string]bool{}
	for _, b := range LinuxBrowsers() {
		if b == "" || seen[b] {
			t.Errorf("empty or repeated entry %q", b)
		}
		seen[b] = true
	}
	if !seen["chromium"] || !seen["google-chrome"] {
		t.Errorf("Chrome and Chromium must be tried: %v", LinuxBrowsers())
	}
}
