package platform

import (
	"encoding/binary"
	"net/url"
	"strings"
	"testing"
)

// The control codes must equal the values documented in the Windows SDK
// (winioctl.h); a typo here would only show up on a real PC.
func TestControlCodes(t *testing.T) {
	for name, c := range map[string]struct{ got, want uint32 }{
		"IOCTL_STORAGE_QUERY_PROPERTY": {IoctlStorageQueryProperty, 0x002D1400},
		"IOCTL_STORAGE_MEDIA_REMOVAL":  {IoctlStorageMediaRemoval, 0x002D4804},
		"IOCTL_STORAGE_EJECT_MEDIA":    {IoctlStorageEjectMedia, 0x002D4808},
		"FSCTL_LOCK_VOLUME":            {FsctlLockVolume, 0x00090018},
		"FSCTL_UNLOCK_VOLUME":          {FsctlUnlockVolume, 0x0009001C},
		"FSCTL_DISMOUNT_VOLUME":        {FsctlDismountVolume, 0x00090020},
	} {
		if c.got != c.want {
			t.Errorf("%s = %#x, want %#x", name, c.got, c.want)
		}
	}
}

func TestBusName(t *testing.T) {
	for bus, want := range map[uint32]string{
		0: "", 1: "SCSI", 3: "ATA", 7: "USB", 11: "SATA", 12: "SD", 13: "MMC", 17: "NVME", 99: "",
	} {
		if got := BusName(bus); got != want {
			t.Errorf("BusName(%d) = %q, want %q", bus, got, want)
		}
	}
}

// descriptor builds a STORAGE_DEVICE_DESCRIPTOR the way the storage stack
// returns it: a 36-byte header followed by strings.
func descriptor(busType uint32, removable bool) []byte {
	buf := make([]byte, 36+40)
	binary.LittleEndian.PutUint32(buf[0:], 36)               // Version
	binary.LittleEndian.PutUint32(buf[4:], uint32(len(buf))) // Size
	buf[8] = 0                                               // DeviceType: direct access
	if removable {
		buf[10] = 1
	}
	binary.LittleEndian.PutUint32(buf[12:], 36) // VendorIdOffset
	binary.LittleEndian.PutUint32(buf[16:], 45) // ProductIdOffset
	binary.LittleEndian.PutUint32(buf[28:], busType)
	copy(buf[36:], "Generic \x00STORAGE DEVICE\x00")
	return buf
}

func TestParseStorageDeviceDescriptor(t *testing.T) {
	bus, removable, ok := ParseStorageDeviceDescriptor(descriptor(7, true))
	if !ok || bus != 7 || !removable {
		t.Errorf("USB stick: bus %d removable %v ok %v", bus, removable, ok)
	}
	bus, removable, ok = ParseStorageDeviceDescriptor(descriptor(12, false))
	if !ok || bus != 12 || removable {
		t.Errorf("SD reader: bus %d removable %v ok %v", bus, removable, ok)
	}
	bus, _, ok = ParseStorageDeviceDescriptor(descriptor(17, false)[:32])
	if !ok || bus != 17 {
		t.Errorf("minimal buffer: bus %d ok %v", bus, ok)
	}
	for name, buf := range map[string][]byte{
		"nil":         nil,
		"empty":       {},
		"header only": descriptor(7, true)[:8], // what a too-small output buffer yields
		"31 bytes":    descriptor(7, true)[:31],
		"zero size":   make([]byte, 64),
	} {
		if _, _, ok := ParseStorageDeviceDescriptor(buf); ok {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestClassifyDrive(t *testing.T) {
	cases := []struct {
		driveType          uint32
		bus                string
		all                bool
		include, removable bool
	}{
		{DriveRemovable, "USB", false, true, true},
		{DriveRemovable, "SD", false, true, true},
		{DriveRemovable, "", false, true, true}, // bus query failed
		{DriveRemovable, "SATA", true, true, true},
		{DriveFixed, "USB", false, true, true}, // card readers and USB disks that claim to be fixed
		{DriveFixed, "SD", false, true, true},
		{DriveFixed, "MMC", false, true, true},
		{DriveFixed, "SATA", false, false, false},
		{DriveFixed, "NVME", false, false, false},
		{DriveFixed, "", false, false, false}, // bus query failed: judged by drive type alone
		{DriveFixed, "SATA", true, true, false},
		{DriveFixed, "NVME", true, true, false},
		{DriveFixed, "", true, true, false},
		{DriveRemote, "", true, false, false},
		{DriveCDROM, "USB", true, false, false},
		{DriveRAMDisk, "", true, false, false},
		{DriveUnknown, "", true, false, false},
		{DriveNoRootDir, "", true, false, false},
	}
	for _, c := range cases {
		include, removable := ClassifyDrive(c.driveType, c.bus, c.all)
		if include != c.include || removable != c.removable {
			t.Errorf("ClassifyDrive(%d, %q, all=%v) = %v, %v; want %v, %v",
				c.driveType, c.bus, c.all, include, removable, c.include, c.removable)
		}
	}
}

func TestDriveLetters(t *testing.T) {
	if got := strings.Join(DriveLetters(0), ","); got != "" {
		t.Errorf("no drives: %q", got)
	}
	if got := strings.Join(DriveLetters(1<<2|1<<4|1<<25), ","); got != "C:,E:,Z:" {
		t.Errorf("C, E, Z: %q", got)
	}
	if got := DriveLetters(0xFFFFFFFF); len(got) != 26 || got[0] != "A:" || got[25] != "Z:" {
		t.Errorf("all bits: %v", got)
	}
}

func TestDriveOf(t *testing.T) {
	for in, want := range map[string]string{
		`C:\Windows`: "C:", `e:\`: "E:", `E:`: "E:", `z:/x`: "Z:",
		``: "", `C`: "", `\\server\share`: "", `/usr`: "", `1:\x`: "", `\\?\C:\x`: "", `::`: "",
	} {
		if got := DriveOf(in); got != want {
			t.Errorf("DriveOf(%q) = %q, want %q", in, got, want)
		}
	}
	for id, want := range map[string]bool{"E:": true, "e:": true, "E": false, `E:\`: false, "EE:": false, "": false, "1:": false, `\\.\E:`: false} {
		if got := IsDriveID(id); got != want {
			t.Errorf("IsDriveID(%q) = %v", id, got)
		}
	}
}

func TestExplorerCommandLine(t *testing.T) {
	const exe = `C:\Windows\explorer.exe`
	ok := []struct {
		path  string
		isDir bool
		want  string
	}{
		{`E:\DCIM\100RICOH\R0001234.DNG`, false, `"C:\Windows\explorer.exe" /select,"E:\DCIM\100RICOH\R0001234.DNG"`},
		{`E:\My Photos\a, b.jpg`, false, `"C:\Windows\explorer.exe" /select,"E:\My Photos\a, b.jpg"`},
		{`E:\DCIM`, true, `"C:\Windows\explorer.exe" "E:\DCIM"`},
		{`C:\Users\me\My Presets`, true, `"C:\Windows\explorer.exe" "C:\Users\me\My Presets"`},
		{`E:\`, true, `"C:\Windows\explorer.exe" E:\`},
	}
	for _, c := range ok {
		got, err := ExplorerCommandLine(exe, c.path, c.isDir)
		if err != nil || got != c.want {
			t.Errorf("ExplorerCommandLine(%q, dir=%v) = %q, %v\nwant %q", c.path, c.isDir, got, err, c.want)
		}
	}
	for _, bad := range []string{``, `E:\a"b`, `E:\a" /root,C:\`, "E:\\a\nb", `E:\my dir\`} {
		if got, err := ExplorerCommandLine(exe, bad, true); err == nil {
			t.Errorf("ExplorerCommandLine(%q) = %q, want an error", bad, got)
		}
	}
}

func TestDataDirFor(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	cases := []struct {
		goos string
		env  map[string]string
		home string
		want string
	}{
		{"windows", map[string]string{"LOCALAPPDATA": `C:\Users\me\AppData\Local`}, "", `C:\Users\me\AppData\Local\GRMod`},
		{"windows", map[string]string{"LOCALAPPDATA": `C:\Users\me\AppData\Local\`}, "", `C:\Users\me\AppData\Local\GRMod`},
		{"windows", map[string]string{"USERPROFILE": `C:\Users\me`}, "", `C:\Users\me\AppData\Local\GRMod`},
		{"windows", map[string]string{}, `C:\Users\me`, ""},
		{"linux", map[string]string{"XDG_DATA_HOME": "/data/xdg"}, "/home/me", "/data/xdg/grmod"},
		{"linux", map[string]string{"XDG_DATA_HOME": "/data/xdg/"}, "/home/me", "/data/xdg/grmod"},
		{"linux", map[string]string{"XDG_DATA_HOME": "relative"}, "/home/me", "/home/me/.local/share/grmod"}, // must be absolute per the XDG spec
		{"linux", map[string]string{}, "/home/me", "/home/me/.local/share/grmod"},
		{"darwin", map[string]string{}, "/Users/me/", "/Users/me/.local/share/grmod"},
		{"linux", map[string]string{}, "", ""},
	}
	for _, c := range cases {
		got, err := DataDirFor(c.goos, env(c.env), c.home)
		if c.want == "" {
			if err == nil {
				t.Errorf("DataDirFor(%s, %v, %q) = %q, want an error", c.goos, c.env, c.home, got)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("DataDirFor(%s, %v, %q) = %q, %v; want %q", c.goos, c.env, c.home, got, err, c.want)
		}
	}
}

func TestProxyFor(t *testing.T) {
	target := func(s string) *url.URL {
		u, err := url.Parse(s)
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	https := target("https://www.ricoh-imaging.co.jp/english/support/download_digital.html")
	cases := []struct {
		name string
		p    ProxySettings
		u    *url.URL
		want string
	}{
		{"off", ProxySettings{Enable: false, Server: "127.0.0.1:7890"}, https, ""},
		{"one proxy for everything", ProxySettings{Enable: true, Server: "127.0.0.1:7890"}, https, "http://127.0.0.1:7890"},
		{"with a scheme", ProxySettings{Enable: true, Server: "http://proxy.corp:8080"}, https, "http://proxy.corp:8080"},
		{"per protocol", ProxySettings{Enable: true, Server: "http=a:80;https=b:8443;ftp=c:21"}, https, "http://b:8443"},
		{"per protocol, http", ProxySettings{Enable: true, Server: "http=a:80;https=b:8443"}, target("http://example.com/"), "http://a:80"},
		{"per protocol without ours", ProxySettings{Enable: true, Server: "ftp=c:21"}, https, ""},
		{"socks only", ProxySettings{Enable: true, Server: "socks=127.0.0.1:1080"}, https, "socks5://127.0.0.1:1080"},
		{"https before socks", ProxySettings{Enable: true, Server: "socks=s:1080;https=b:1"}, https, "http://b:1"},
		{"empty server", ProxySettings{Enable: true}, https, ""},
		{"override exact", ProxySettings{Enable: true, Server: "p:1", Override: "localhost;www.ricoh-imaging.co.jp"}, https, ""},
		{"override wildcard", ProxySettings{Enable: true, Server: "p:1", Override: "*.co.jp;<local>"}, https, ""},
		{"override wildcard inside", ProxySettings{Enable: true, Server: "p:1", Override: "www.*-imaging.*"}, https, ""},
		{"override other host", ProxySettings{Enable: true, Server: "p:1", Override: "*.example.com;10.*;<local>"}, https, "http://p:1"},
		{"local name", ProxySettings{Enable: true, Server: "p:1", Override: "<local>"}, target("http://nas/"), ""},
		{"loopback is never proxied", ProxySettings{Enable: true, Server: "p:1"}, target("http://127.0.0.1:4321/api/ping"), ""},
		{"garbage", ProxySettings{Enable: true, Server: "ftp://x:1"}, https, ""},
	}
	for _, c := range cases {
		got := ""
		if u := c.p.ProxyFor(c.u); u != nil {
			got = u.String()
		}
		if got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	if (ProxySettings{Enable: true, Server: "p:1"}).ProxyFor(nil) != nil {
		t.Error("nil URL")
	}
}

func TestBrowserURL(t *testing.T) {
	for _, ok := range []string{
		"https://www.ricoh-imaging.co.jp/english/support/digital/gr4_s.html",
		"http://127.0.0.1:8080/a?b=c&d=%20e#f",
	} {
		if got, err := BrowserURL(ok); err != nil || got != ok {
			t.Errorf("%q: %q %v", ok, got, err)
		}
	}
	for _, bad := range []string{
		"", "gr4_s.html", "file:///C:/Windows/system32/calc.exe", "javascript:alert(1)", "https://", "https://user:pw@example.com/",
		"https://example.com/a b", "https://example.com/\"&calc", "https://example.com/a|b", "https://example.com/a^b", "https://example.com/\n", "https://example.com/é",
		`https://example.com/a\b`,
	} {
		if _, err := BrowserURL(bad); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}
