package platform

import "strings"

// The built-in SD reader reports Internal=true. OSInternalMedia, removal flags
// and the actual mount point distinguish its card from the system disk.
type macDisk struct {
	DeviceIdentifier string
	MountPoint       string
	VolumeName       string
	FilesystemType   string
	BusProtocol      string
	OSInternalMedia  bool
	Removable        bool
	RemovableMedia   bool
	Ejectable        bool
	Writable         bool
}

func macVolume(d macDisk, root string, all bool) (Volume, bool) {
	if d.MountPoint != root || !strings.HasPrefix(root, "/Volumes/") ||
		d.OSInternalMedia || !d.Writable || !strings.HasPrefix(d.DeviceIdentifier, "disk") {
		return Volume{}, false
	}
	removable := d.Removable || d.RemovableMedia || d.Ejectable
	if !all && !removable {
		return Volume{}, false
	}
	return Volume{ID: d.DeviceIdentifier, Root: root, Label: d.VolumeName,
		FS: d.FilesystemType, Bus: d.BusProtocol, Removable: removable}, true
}
