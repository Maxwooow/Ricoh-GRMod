//go:build linux

package platform

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fakeLinux builds a sysfs, a /dev and a udev database in a temporary
// directory, as a laptop with these disks shows them:
//
//	nvme0n1  system disk: p1 = /boot/efi (FAT32), p2 = LUKS -> dm-0 = / and /home
//	sda      USB card reader with the camera's card (sda1, FAT32)
//	mmcblk0  built-in SD slot with a card (mmcblk0p1, label "NO NAME", no udev entry)
//	sdc      USB stick formatted without partitions (exFAT through FUSE)
//	sdb      internal SATA disk (sdb1, ext4)
//	loop0    a mounted disk image (FAT)
type fakeLinux struct {
	t    *testing.T
	root string
}

func newFakeLinux(t *testing.T) *fakeLinux {
	f := &fakeLinux{t: t, root: t.TempDir()}
	pci := "devices/pci0000:00"
	nvme := pci + "/0000:00:02.4/0000:03:00.0/nvme/nvme0/nvme0n1"
	usb := pci + "/0000:00:14.0/usb3/3-1/3-1:1.0/host0/target0:0:0/0:0:0:0/block/sda"
	stick := pci + "/0000:00:14.0/usb3/3-2/3-2:1.0/host2/target2:0:0/2:0:0:0/block/sdc"
	mmcHost := pci + "/0000:00:1c.0/0000:02:00.0/rtsx_pci_sdmmc.0/mmc_host/mmc0/mmc0:aaaa"
	mmc := mmcHost + "/block/mmcblk0"
	sata := pci + "/0000:00:17.0/ata1/host1/target1:0:0/1:0:0:0/block/sdb"

	f.disk("nvme0n1", nvme, "259:0", "0")
	f.part("nvme0n1p1", nvme, "259:1")
	f.part("nvme0n1p2", nvme, "259:2")
	f.disk("dm-0", "devices/virtual/block/dm-0", "254:0", "0")
	f.link("sys/devices/virtual/block/dm-0/slaves/nvme0n1p2", "sys/"+nvme+"/nvme0n1p2")
	f.disk("sda", usb, "8:0", "1")
	f.part("sda1", usb, "8:1")
	f.disk("mmcblk0", mmc, "179:0", "0")
	f.part("mmcblk0p1", mmc, "179:1")
	f.file("sys/"+mmcHost+"/type", "SD\n")
	f.link("sys/"+mmc+"/device", "sys/"+mmcHost)
	f.disk("sdc", stick, "8:32", "0")
	f.disk("sdb", sata, "8:16", "0")
	f.part("sdb1", sata, "8:17")
	f.disk("loop0", "devices/virtual/block/loop0", "7:0", "0")

	f.file("dev/dm-0", "")
	f.link("dev/mapper/cr_root", "dev/dm-0")
	f.file("udev/b259:1", "E:ID_FS_TYPE=vfat\nE:ID_FS_VERSION=FAT32\n")
	f.file("udev/b8:1", "E:ID_FS_TYPE=vfat\nE:ID_FS_VERSION=FAT32\nE:ID_FS_LABEL=CARD\n")
	f.file("udev/b8:32", "E:ID_FS_TYPE=exfat\nE:ID_FS_VERSION=1.0\n")
	f.file("udev/b7:0", "E:ID_FS_TYPE=vfat\nE:ID_FS_VERSION=FAT16\n")
	return f
}

func (f *fakeLinux) path(rel string) string { return filepath.Join(f.root, rel) }

func (f *fakeLinux) file(rel, content string) {
	f.t.Helper()
	p := f.path(rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fakeLinux) link(rel, target string) {
	f.t.Helper()
	p := f.path(rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Symlink(f.path(target), p); err != nil {
		f.t.Fatal(err)
	}
}

// disk adds a whole disk below /sys/devices and its /sys/class/block link.
func (f *fakeLinux) disk(name, devpath, dev, removable string) {
	f.file("sys/"+devpath+"/dev", dev+"\n")
	f.file("sys/"+devpath+"/removable", removable+"\n")
	f.link("sys/class/block/"+name, "sys/"+devpath)
}

// part adds a partition of the disk at devpath.
func (f *fakeLinux) part(name, devpath, dev string) {
	f.file("sys/"+devpath+"/"+name+"/dev", dev+"\n")
	f.file("sys/"+devpath+"/"+name+"/partition", "1\n")
	f.link("sys/class/block/"+name, "sys/"+devpath+"/"+name)
}

const fakeMountinfo = `29 1 0:31 / / rw,relatime shared:1 - btrfs /dev/mapper/cr_root rw,ssd
30 29 0:31 /@/home /home rw,relatime shared:2 - btrfs /dev/mapper/cr_root rw,ssd
31 29 259:1 / /boot/efi rw,relatime shared:3 - vfat /dev/nvme0n1p1 rw
32 29 0:25 / /proc rw,nosuid shared:4 - proc proc rw
33 29 0:26 / /run rw,nosuid shared:5 - tmpfs tmpfs rw
40 33 8:1 / /run/media/u/CARD rw,nosuid,nodev,relatime shared:10 - vfat /dev/sda1 rw,uid=1000
41 33 179:1 / /run/media/u/NO\040NAME rw,nosuid,nodev shared:11 - vfat /dev/mmcblk0p1 rw
42 33 0:40 / /run/media/u/STICK rw,nosuid,nodev shared:12 - fuseblk /dev/sdc rw,user_id=1000
43 29 8:17 / /mnt/CARD rw,relatime shared:13 - ext4 /dev/sdb1 rw
44 29 8:1 /DCIM /mnt/bind rw shared:14 - vfat /dev/sda1 rw
45 29 8:1 / /mnt/again rw shared:15 - vfat /dev/sda1 rw
46 33 7:0 / /run/media/u/IMAGE rw shared:16 - vfat /dev/loop0 rw
47 29 0:50 / /mnt/nas rw shared:17 - nfs4 nas:/photos rw
48 33 8:33 / /run/media/u/GONE rw shared:18 - vfat /dev/sdd1 rw
`

func (f *fakeLinux) system(mountinfo string) LinuxSystem {
	f.file("proc/mountinfo", mountinfo)
	const gb = 1 << 30
	sizes := map[string][2]uint64{
		"/run/media/u/CARD":    {32 * gb, 30 * gb},
		"/run/media/u/NO NAME": {16 * gb, 8 * gb},
		"/run/media/u/STICK":   {64 * gb, 60 * gb},
		"/mnt/CARD":            {500 * gb, 100 * gb},
		"/mnt/again":           {32 * gb, 30 * gb},
		"/run/media/u/IMAGE":   {1 * gb, 1 * gb},
		"/boot/efi":            {1 * gb, 1 * gb},
	}
	return LinuxSystem{
		Mountinfo: f.path("proc/mountinfo"),
		Sys:       f.path("sys"),
		Udev:      f.path("udev"),
		DevRoot:   f.root,
		Statfs: func(path string) (uint64, uint64, error) {
			s, ok := sizes[path]
			if !ok {
				return 0, 0, errors.New("no such file system")
			}
			return s[0], s[1], nil
		},
	}
}

func TestLinuxSystemVolumes(t *testing.T) {
	f := newFakeLinux(t)
	sys := f.system(fakeMountinfo)
	const gb = 1 << 30
	card := Volume{ID: "CARD", Root: "/run/media/u/CARD", Label: "CARD", FS: "FAT32", Total: 32 * gb, Free: 30 * gb, Removable: true, Bus: "USB"}
	slot := Volume{ID: "NO NAME", Root: "/run/media/u/NO NAME", Label: "NO NAME", FS: "FAT32", Total: 16 * gb, Free: 8 * gb, Removable: true, Bus: "SD"}
	stick := Volume{ID: "STICK", Root: "/run/media/u/STICK", Label: "STICK", FS: "exFAT", Total: 64 * gb, Free: 60 * gb, Removable: true, Bus: "USB"}
	sata := Volume{ID: "CARD (sdb1)", Root: "/mnt/CARD", Label: "CARD", FS: "ext4", Total: 500 * gb, Free: 100 * gb, Removable: false, Bus: "SATA"}

	got, err := sys.Volumes(false)
	if err != nil {
		t.Fatal(err)
	}
	if want := []Volume{card, slot, stick}; !reflect.DeepEqual(got, want) {
		t.Errorf("default listing:\n got  %+v\n want %+v", got, want)
	}
	got, err = sys.Volumes(true)
	if err != nil {
		t.Fatal(err)
	}
	if want := []Volume{card, slot, stick, sata}; !reflect.DeepEqual(got, want) {
		t.Errorf("all=1:\n got  %+v\n want %+v", got, want)
	}
}

func TestLinuxSystemVolumesEdgeCases(t *testing.T) {
	f := newFakeLinux(t)

	// Nothing mounted besides the system: an empty, non-nil list.
	sys := f.system("29 1 0:31 / / rw - btrfs /dev/mapper/cr_root rw\n31 29 259:1 / /boot/efi rw - vfat /dev/nvme0n1p1 rw\n")
	if vols, err := sys.Volumes(true); err != nil || vols == nil || len(vols) != 0 {
		t.Errorf("system only: %+v, %v (want an empty, non-nil list)", vols, err)
	}

	// The system on a USB disk (a portable installation): that disk is
	// never offered, its other partitions neither.
	sys = f.system("29 1 0:31 / / rw - vfat /dev/sda1 rw\n40 29 8:1 / /run/media/u/CARD rw - vfat /dev/sda1 rw\n")
	if vols, _ := sys.Volumes(true); len(vols) != 0 {
		t.Errorf("system disk listed: %+v", vols)
	}

	// Without udev the FAT version comes from the size.
	sys = f.system(fakeMountinfo)
	sys.Udev = ""
	vols, err := sys.Volumes(false)
	if err != nil || len(vols) != 3 || vols[0].FS != "FAT32" || vols[2].FS != "fuseblk" {
		t.Errorf("without udev: %+v, %v", vols, err)
	}

	// A missing mount table is an error.
	sys.Mountinfo = f.path("proc/missing")
	if _, err := sys.Volumes(false); err == nil {
		t.Error("missing mountinfo must be an error")
	}
}

func TestLinuxSystemBlock(t *testing.T) {
	f := newFakeLinux(t)
	sys := f.system(fakeMountinfo)
	cases := []struct {
		source string
		name   string
		dev    string
		disk   string
		bus    string
	}{
		{"/dev/sda1", "sda1", "8:1", "sda", "USB"},
		{"/dev/mmcblk0p1", "mmcblk0p1", "179:1", "mmcblk0", "SD"},
		{"/dev/sdc", "sdc", "8:32", "sdc", "USB"},
		{"/dev/mapper/cr_root", "dm-0", "254:0", "nvme0n1", "NVMe"},
		{"/dev/loop0", "loop0", "7:0", "loop0", "Loop"},
	}
	for _, c := range cases {
		d, err := sys.BlockOfSource(c.source)
		if err != nil {
			t.Errorf("%s: %v", c.source, err)
			continue
		}
		if d.Name != c.name || d.Dev != c.dev || d.Disk != c.disk || LinuxBusName(d) != c.bus {
			t.Errorf("%s: %+v (bus %q), want name %s dev %s disk %s bus %s", c.source, d, LinuxBusName(d), c.name, c.dev, c.disk, c.bus)
		}
	}
	if d, _ := sys.Block("sda1"); !d.Removable {
		t.Errorf("sda1 must inherit the reader's removable flag: %+v", d)
	}
	if d, _ := sys.Block("mmcblk0p1"); d.MMCType != "SD" {
		t.Errorf("mmcblk0p1: MMC type %q", d.MMCType)
	}
	for _, bad := range []string{"", ".", "..", "../sda", "sdz"} {
		if _, err := sys.Block(bad); err == nil {
			t.Errorf("Block(%q) must fail", bad)
		}
	}
}

func TestLinuxSystemMountAt(t *testing.T) {
	f := newFakeLinux(t)
	sys := f.system(fakeMountinfo + "49 40 8:33 / /run/media/u/CARD rw - vfat /dev/sdd1 rw\n")
	m, ok := sys.MountAt("/run/media/u/NO NAME/")
	if !ok || m.Source != "/dev/mmcblk0p1" {
		t.Errorf("NO NAME: %+v, %v", m, ok)
	}
	// Stacked mounts: the last one is what is visible there.
	if m, ok := sys.MountAt("/run/media/u/CARD"); !ok || m.Source != "/dev/sdd1" {
		t.Errorf("stacked: %+v, %v", m, ok)
	}
	if _, ok := sys.MountAt("/run/media/u"); ok {
		t.Error("a directory that is not a mount point must not be found")
	}
}

// TestLinuxSystemThisMachine runs the real files of the machine the tests
// run on: they must parse, and no volume may be the system's.
func TestLinuxSystemThisMachine(t *testing.T) {
	sys := DefaultLinuxSystem()
	data, err := os.ReadFile(sys.Mountinfo)
	if err != nil {
		t.Skip("no mountinfo:", err)
	}
	foundRoot := false
	for _, m := range ParseMountinfo(string(data)) {
		foundRoot = foundRoot || m.MountPoint == "/"
	}
	if !foundRoot {
		t.Error("no mount at / in", sys.Mountinfo)
	}
	vols, err := sys.Volumes(true)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range vols {
		if v.Root == "/" || strings.HasPrefix(v.Root, "/boot") || v.Root == "/home" {
			t.Errorf("system volume listed: %+v", v)
		}
	}
}
