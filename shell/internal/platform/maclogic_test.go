package platform

import "testing"

func TestMacSDReaderAndMountGuards(t *testing.T) {
	d := macDisk{DeviceIdentifier: "disk4s1", MountPoint: "/Volumes/Untitled", VolumeName: "Untitled",
		FilesystemType: "exfat", BusProtocol: "Secure Digital", Removable: true, Ejectable: true, Writable: true}
	v, ok := macVolume(d, d.MountPoint, false)
	if !ok || v.ID != "disk4s1" || v.Bus != "Secure Digital" || !v.Removable {
		t.Fatalf("SD card: %+v, %v", v, ok)
	}
	for _, mutate := range []func(*macDisk){
		func(d *macDisk) { d.OSInternalMedia = true },
		func(d *macDisk) { d.MountPoint = "/" },
		func(d *macDisk) { d.MountPoint = "/Volumes/Other" },
		func(d *macDisk) { d.Writable = false },
		func(d *macDisk) { d.DeviceIdentifier = "" },
	} {
		bad := d
		mutate(&bad)
		if _, ok := macVolume(bad, d.MountPoint, true); ok {
			t.Fatalf("unsafe volume accepted: %+v", bad)
		}
	}
	d.Removable, d.Ejectable = false, false
	if _, ok := macVolume(d, d.MountPoint, false); ok {
		t.Fatal("fixed disk shown by default")
	}
	if _, ok := macVolume(d, d.MountPoint, true); !ok {
		t.Fatal("external fixed disk absent in all mode")
	}
}
