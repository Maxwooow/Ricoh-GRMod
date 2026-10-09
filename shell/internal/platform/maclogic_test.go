package platform

import (
	"net/url"
	"strings"
	"testing"
)

// A trimmed `diskutil info -plist /Volumes/NO NAME` of a microSD card in a
// USB reader.
const diskutilCard = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Bootable</key>
	<false/>
	<key>BusProtocol</key>
	<string>USB</string>
	<key>DeviceIdentifier</key>
	<string>disk4s1</string>
	<key>Ejectable</key>
	<true/>
	<key>FilesystemName</key>
	<string>MS-DOS FAT32</string>
	<key>FilesystemType</key>
	<string>msdos</string>
	<key>FilesystemUserVisibleName</key>
	<string>MS-DOS (FAT32)</string>
	<key>Internal</key>
	<false/>
	<key>MediaType</key>
	<string>Generic</string>
	<key>MountPoint</key>
	<string>/Volumes/NO NAME</string>
	<key>Removable</key>
	<true/>
	<key>RemovableMedia</key>
	<true/>
	<key>RemovableMediaOrExternalDevice</key>
	<true/>
	<key>Size</key>
	<integer>31914983424</integer>
	<key>Stealth</key>
	<array>
		<string>nested values are ignored</string>
	</array>
	<key>VolumeName</key>
	<string>NO NAME</string>
	<key>WritableVolume</key>
	<true/>
</dict>
</plist>`

func TestParseDiskutilInfo(t *testing.T) {
	info, err := ParseDiskutilInfo([]byte(diskutilCard))
	if err != nil {
		t.Fatal(err)
	}
	want := MacDiskInfo{
		BusProtocol: "USB", Internal: false, Removable: true, Ejectable: true, ExternalOrRemoved: true,
		FilesystemType: "msdos", FilesystemName: "MS-DOS (FAT32)", VolumeName: "NO NAME",
		MountPoint: "/Volumes/NO NAME", Writable: true, WritableKnown: true,
	}
	if info != want {
		t.Errorf("got %+v\nwant %+v", info, want)
	}
	if _, err := ParseDiskutilInfo([]byte("Could not find disk: /Volumes/x")); err == nil {
		t.Error("non-plist output must be an error")
	}
	// Only FilesystemName present.
	info, err = ParseDiskutilInfo([]byte(`<plist><dict><key>FilesystemName</key><string>ExFAT</string></dict></plist>`))
	if err != nil || info.FilesystemName != "ExFAT" {
		t.Errorf("fallback to FilesystemName: %+v, %v", info, err)
	}
}

func TestClassifyMacVolume(t *testing.T) {
	cases := []struct {
		name      string
		info      MacDiskInfo
		all       bool
		include   bool
		removable bool
	}{
		{"usb card reader", MacDiskInfo{BusProtocol: "USB", Removable: true}, false, true, true},
		{"built-in sd slot", MacDiskInfo{BusProtocol: "Secure Digital", Internal: true, Removable: true}, false, true, true},
		{"built-in sd slot without flags", MacDiskInfo{BusProtocol: "Secure Digital", Internal: true}, false, true, true},
		{"external thunderbolt ssd", MacDiskInfo{BusProtocol: "PCI-Express", Internal: false, Ejectable: true}, false, false, false},
		{"external thunderbolt ssd, all", MacDiskInfo{BusProtocol: "PCI-Express", Internal: false, Ejectable: true}, true, true, false},
		{"usb ssd", MacDiskInfo{BusProtocol: "USB", Ejectable: true}, false, true, true},
		{"internal second volume", MacDiskInfo{BusProtocol: "PCI-Express", Internal: true}, false, false, false},
		{"internal second volume, all", MacDiskInfo{BusProtocol: "PCI-Express", Internal: true}, true, true, false},
		{"disk image", MacDiskInfo{BusProtocol: "Disk Image", Ejectable: true}, true, false, false},
	}
	for _, c := range cases {
		inc, rem := ClassifyMacVolume(c.info, c.all)
		if inc != c.include || rem != c.removable {
			t.Errorf("%s: got (%v, %v), want (%v, %v)", c.name, inc, rem, c.include, c.removable)
		}
	}
}

func TestMacFSName(t *testing.T) {
	cases := []struct {
		visible, fstype string
		total           uint64
		want            string
	}{
		{"MS-DOS (FAT32)", "msdos", 32e9, "FAT32"},
		{"MS-DOS (FAT16)", "msdos", 2e9, "FAT16"},
		{"ExFAT", "exfat", 128e9, "exFAT"},
		{"APFS", "apfs", 1e12, "APFS"},
		{"Mac OS Extended (Journaled)", "hfs", 1e12, "HFS+"},
		{"", "msdos", 32e9, "FAT32"},
		{"", "msdos", 1e9, "FAT"},
		{"", "exfat", 0, "exFAT"},
		{"", "zfs", 0, "ZFS"},
	}
	for _, c := range cases {
		if got := MacFSName(c.visible, c.fstype, c.total); got != c.want {
			t.Errorf("MacFSName(%q, %q, %d) = %q, want %q", c.visible, c.fstype, c.total, got, c.want)
		}
	}
}

func TestMacBusAndFS(t *testing.T) {
	for in, want := range map[string]string{"USB": "USB", "Secure Digital": "SD", "PCI-Express": "PCIe", "Disk Image": "Disk Image", "": "", "FireWire": "FireWire"} {
		if got := MacBusName(in); got != want {
			t.Errorf("MacBusName(%q) = %q, want %q", in, got, want)
		}
	}
	for fs, want := range map[string]bool{"msdos": true, "exfat": true, "apfs": true, "smbfs": false, "nfs": false, "devfs": false, "autofs": false, "macfuse": false} {
		if IsLocalMacFS(fs) != want {
			t.Errorf("IsLocalMacFS(%q) != %v", fs, want)
		}
	}
	for p, want := range map[string]bool{"/Volumes/NO NAME": true, "/Volumes/X/": true, "/Volumes": false, "/Volumes/a/b": false, "/Users/me": false, "/Volumes/.timemachine": false} {
		if IsVolumesMount(p) != want {
			t.Errorf("IsVolumesMount(%q) != %v", p, want)
		}
	}
}

const scutilProxy = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      ExceptionsList : <array> {
        0 : example.org
      }
      HTTPEnable : 0
      HTTPSEnable : 0
    }
  }
}`

func TestParseScutilProxy(t *testing.T) {
	p := ParseScutilProxy(scutilProxy)
	if !p.Enable || p.Server != "http=127.0.0.1:7890;https=127.0.0.1:7890" {
		t.Fatalf("got %+v", p)
	}
	if !strings.Contains(p.Override, "*.local") || !strings.Contains(p.Override, "<local>") || strings.Contains(p.Override, "example.org") {
		t.Errorf("override %q", p.Override)
	}
	u, _ := url.Parse("https://www.ricoh-imaging.co.jp/")
	if got := p.ProxyFor(u); got == nil || got.Host != "127.0.0.1:7890" {
		t.Errorf("ProxyFor = %v", got)
	}
	nas, _ := url.Parse("http://nas.local/")
	if got := p.ProxyFor(nas); got != nil {
		t.Errorf("*.local must bypass, got %v", got)
	}
	if off := ParseScutilProxy("<dictionary> {\n  HTTPEnable : 0\n}"); off.Enable {
		t.Errorf("disabled proxy reported as enabled: %+v", off)
	}
}

func TestMacBrowsers(t *testing.T) {
	got := MacBrowsers("/Users/me/")
	if len(got) == 0 || got[0] != "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" {
		t.Fatalf("first candidate: %v", got)
	}
	if got[1] != "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" {
		t.Errorf("user Applications folder missing: %v", got[1])
	}
	if n := len(MacBrowsers("")); n*2 != len(got) {
		t.Errorf("without a home only /Applications: %d vs %d", n, len(got))
	}
}
