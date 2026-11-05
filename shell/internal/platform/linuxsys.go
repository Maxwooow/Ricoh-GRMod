//go:build linux

package platform

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// LinuxSystem says where the files that describe mounts and block devices
// are. The Linux build reads the real ones (DefaultLinuxSystem); the tests
// point it at a fake tree, so everything here runs in `go test` on any
// Linux machine. What the files mean is decided in linuxlogic.go.
type LinuxSystem struct {
	Mountinfo string // /proc/self/mountinfo
	Sys       string // /sys
	Udev      string // /run/udev/data
	// DevRoot is put in front of the device paths named in mountinfo
	// ("/dev/sdb1", "/dev/mapper/x") before their links are resolved; ""
	// on a real system.
	DevRoot string
	// Statfs returns the size and the free space of a mounted file system.
	Statfs func(path string) (total, free uint64, err error)
}

// DefaultLinuxSystem is the running system.
func DefaultLinuxSystem() LinuxSystem {
	return LinuxSystem{
		Mountinfo: "/proc/self/mountinfo",
		Sys:       "/sys",
		Udev:      "/run/udev/data",
		Statfs:    statfsSizes,
	}
}

func statfsSizes(path string) (total, free uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize)
	return st.Blocks * bs, st.Bavail * bs, nil
}

func (s LinuxSystem) mounts() ([]LinuxMount, error) {
	data, err := os.ReadFile(s.Mountinfo)
	if err != nil {
		return nil, err
	}
	return ParseMountinfo(string(data)), nil
}

// Volumes lists the mounted volumes that ClassifyLinuxVolume offers. The
// disk that holds the operating system (the one mounted at /) is never
// listed, with all its partitions (/boot/efi is FAT too).
func (s LinuxSystem) Volumes(all bool) ([]Volume, error) {
	mounts, err := s.mounts()
	if err != nil {
		return nil, err
	}
	system := map[string]bool{}
	for _, m := range mounts {
		if m.MountPoint == "/" && strings.HasPrefix(m.Source, "/dev/") {
			if d, err := s.BlockOfSource(m.Source); err == nil {
				system[d.Disk] = true
			}
		}
	}

	out := []Volume{}
	seen := map[string]bool{} // devices already listed (mounted more than once)
	ids := map[string]bool{}
	for _, m := range mounts {
		// Root "/" leaves out bind mounts and subvolumes: the volume is
		// listed where its file system is mounted as a whole.
		if m.Root != "/" || !IsLocalLinuxFS(m.FSType) || !strings.HasPrefix(m.Source, "/dev/") {
			continue
		}
		d, err := s.BlockOfSource(m.Source)
		if err != nil || seen[d.Name] || system[d.Disk] {
			continue
		}
		include, removable := ClassifyLinuxVolume(d, all)
		if !include {
			continue
		}
		total, free, err := s.Statfs(m.MountPoint)
		if err != nil {
			continue // not ready
		}
		seen[d.Name] = true
		name := filepath.Base(m.MountPoint)
		id := name
		if ids[id] {
			id = name + " (" + d.Name + ")"
		}
		ids[id] = true
		out = append(out, Volume{
			ID:        id,
			Root:      m.MountPoint,
			Label:     name,
			FS:        LinuxFSName(m.FSType, s.udev(d.Dev), total),
			Total:     total,
			Free:      free,
			Removable: removable,
			Bus:       LinuxBusName(d),
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

// MountAt returns what is mounted at root (the topmost mount when several
// are stacked there).
func (s LinuxSystem) MountAt(root string) (LinuxMount, bool) {
	mounts, err := s.mounts()
	if err != nil {
		return LinuxMount{}, false
	}
	root = filepath.Clean(root)
	for i := len(mounts) - 1; i >= 0; i-- {
		if mounts[i].MountPoint == root {
			return mounts[i], true
		}
	}
	return LinuxMount{}, false
}

// BlockOfSource describes the block device a mount names ("/dev/sdb1",
// "/dev/disk/by-uuid/…", "/dev/mapper/x").
func (s LinuxSystem) BlockOfSource(source string) (LinuxBlockDevice, error) {
	dev := source
	if real, err := filepath.EvalSymlinks(s.DevRoot + source); err == nil {
		dev = real
	}
	return s.Block(filepath.Base(dev))
}

// Block describes a block device by its kernel name ("sdb1", "dm-0").
func (s LinuxSystem) Block(name string) (LinuxBlockDevice, error) {
	return s.block(name, 0)
}

func (s LinuxSystem) block(name string, depth int) (LinuxBlockDevice, error) {
	if name == "" || name == "." || name == ".." || strings.Contains(name, "/") {
		return LinuxBlockDevice{}, errors.New("not a block device name")
	}
	path, err := filepath.EvalSymlinks(filepath.Join(s.Sys, "class", "block", name))
	if err != nil {
		return LinuxBlockDevice{}, err
	}
	d := LinuxBlockDevice{Name: name, Dev: readTrimmed(filepath.Join(path, "dev"))}
	disk := path
	if _, err := os.Stat(filepath.Join(path, "partition")); err == nil {
		disk = filepath.Dir(path) // .../block/sdb/sdb1 -> .../block/sdb
	}
	// Device mapper (LUKS, LVM) and software RAID sit on other block
	// devices; the disk is the one under them.
	if slaves, _ := os.ReadDir(filepath.Join(disk, "slaves")); len(slaves) > 0 && depth < 8 {
		under, err := s.block(slaves[0].Name(), depth+1)
		if err != nil {
			return LinuxBlockDevice{}, err
		}
		under.Name, under.Dev = d.Name, d.Dev
		return under, nil
	}
	d.Disk = filepath.Base(disk)
	d.DiskPath = disk
	d.Removable = readTrimmed(filepath.Join(disk, "removable")) == "1"
	if strings.HasPrefix(d.Disk, "mmcblk") {
		d.MMCType = readTrimmed(filepath.Join(disk, "device", "type"))
	}
	return d, nil
}

// udev returns the udev properties of a device by its "major:minor", or an
// empty map when udev keeps none (no udev, as in many containers).
func (s LinuxSystem) udev(dev string) map[string]string {
	if dev == "" || s.Udev == "" {
		return map[string]string{}
	}
	data, err := os.ReadFile(filepath.Join(s.Udev, "b"+dev))
	if err != nil {
		return map[string]string{}
	}
	return ParseUdevData(string(data))
}

func readTrimmed(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
