//go:build !windows

package server

import (
	"strings"
	"testing"

	"grmod/shell/internal/pathguard"
	"grmod/shell/internal/platform"
)

// The Windows path rules, driven through the HTTP layer on Linux: the server
// is configured with the Windows flavor and a host that reports Windows
// drives. Nothing here exists on disk, so allowed paths end in "not found",
// which is enough to tell "passed the confinement check" from "refused".
func newWindowsFlavorEnv(t *testing.T) *env {
	return newEnv(t, func(o *Options) {
		o.Flavor = pathguard.Windows
		o.DataDir = `D:\Users\me\AppData\Local\GRMod`
		h := o.Host.(*fakeHost)
		h.kind = "windows"
		h.protected = []string{`C:\Windows`}
		h.removable = []platform.Volume{
			{ID: "E:", Root: `E:\`, Label: "GR_CARD", FS: "FAT32", Removable: true, Bus: "SD"},
			// A host that wrongly offered these must still not get them through:
			{ID: "C:", Root: `C:\`, Label: "System", FS: "NTFS", Removable: true, Bus: "USB"},
			{ID: "D:", Root: `D:\`, Label: "Data", FS: "NTFS", Removable: true, Bus: "USB"},
		}
		h.fixed = []platform.Volume{
			{ID: "F:", Root: `F:\`, Label: "Backup", FS: "NTFS", Bus: "SATA"},
			{ID: "c:", Root: `c:/`, Label: "System again", FS: "NTFS", Bus: "NVME"},
			{ID: "X:", Root: `\\?\X:\`, Label: "device path"},
			{ID: "N:", Root: `\\server\share`, Label: "network"},
		}
	})
}

func TestWindowsVolumesNeverIncludeSystemOrDataDrive(t *testing.T) {
	e := newWindowsFlavorEnv(t)
	type resp struct {
		Volumes []platform.Volume `json:"volumes"`
	}
	ids := func(target string) string {
		var out []string
		for _, v := range decode[resp](t, e.do("GET", target, nil)).Volumes {
			out = append(out, v.ID)
		}
		return strings.Join(out, ",")
	}
	if got := ids("/api/volumes"); got != "E:" {
		t.Errorf("default listing = %q, want only E:", got)
	}
	if got := ids("/api/volumes?all=1"); got != "E:,F:" {
		t.Errorf("all=1 listing = %q, want E: and F:", got)
	}
	rec := e.do("GET", "/api/volumes", nil)
	if !strings.Contains(rec.Body.String(), `{"id":"E:","root":"E:\\","label":"GR_CARD","fs":"FAT32","total":0,"free":0,"removable":true,"bus":"SD"}`) {
		t.Errorf("volume JSON = %s", rec.Body.String())
	}
}

func TestWindowsPathRulesThroughAPI(t *testing.T) {
	e := newWindowsFlavorEnv(t)
	refused := []string{
		// the system drive and the data drive, in any spelling
		`C:\`, `C:\Windows\win.ini`, `c:/windows/win.ini`, `C:\Users\me\Documents`,
		`D:\`, `D:\Users\me\AppData\Local\GRMod\log.txt`, `d:\users\me\appdata\local\grmod\store\x`,
		// drives that are not volumes
		`G:\x`, `Z:\`,
		// escapes from an allowed drive
		`E:\..`, `E:\..\C:\Windows`, `E:\DCIM\..\..\Windows`, `E:/DCIM/../../Windows`, `E:\DCIM\..\..\..\..\x`,
		// device and UNC namespaces
		`\\?\E:\DCIM`, `\\?\C:\Windows`, `\\.\E:`, `\\.\PhysicalDrive0`, `//?/E:/DCIM`, `//./E:/x`,
		`\\server\share\x`, `\\localhost\C$\Windows`, `\??\E:\x`, `\\?\UNC\server\share`,
		// not fully qualified
		`E:`, `E:DCIM`, `\DCIM`, `/DCIM`, `DCIM\x`, `..\x`,
		// alternate data streams
		`E:\file.txt:stream`, `E:\file.txt::$DATA`, `E:\DCIM:$I30:$INDEX_ALLOCATION`,
		// names Win32 would silently change
		`E:\file.`, `E:\file `, `E:\dir.\x`, `E:\dir \x`, `E:\...\x`, `E:\.. \x`,
		// reserved names and characters
		`E:\NUL`, `E:\con.txt`, `E:\DCIM\COM1`, `E:\aux\x`, `E:\*.jpg`, `E:\a?b`, `E:\a|b`, `E:\a<b>`, `E:\"x"`,
		// control characters
		"E:\\a\x00b", "E:\\a\nb",
	}
	for _, p := range refused {
		if rec := e.do("GET", q("/api/read", "path", p), nil); rec.Code != 403 {
			t.Errorf("read %q: status %d, want 403 (%s)", p, rec.Code, strings.TrimSpace(rec.Body.String()))
		}
		if rec := e.do("PUT", q("/api/write", "path", p), "x"); rec.Code != 403 {
			t.Errorf("write %q: status %d, want 403", p, rec.Code)
		}
		if rec := e.do("POST", "/api/stat", map[string]string{"path": p}); rec.Code != 403 {
			t.Errorf("stat %q: status %d, want 403", p, rec.Code)
		}
		if rec := e.do("POST", "/api/move", map[string]string{"from": `E:\a.bin`, "to": p}); rec.Code != 403 {
			t.Errorf("move to %q: status %d, want 403", p, rec.Code)
		}
	}
	// Paths on listed volumes pass the lexical check (and then fail only
	// because drive E: does not exist on the test machine).
	for _, p := range []string{`E:\`, `E:\DCIM\100RICOH\R0001234.DNG`, `e:/dcim/x.jpg`, `E:\DCIM\..\fw.bin`, `F:\backup\x`} {
		if rec := e.do("GET", q("/api/read", "path", p), nil); rec.Code == 403 {
			t.Errorf("read %q was refused: %s", p, strings.TrimSpace(rec.Body.String()))
		}
	}
	// A folder picked on the system drive becomes usable, its siblings do not.
	e.host.pick = `C:\Users\me\Presets`
	wantStatus(t, e.do("POST", "/api/pick-directory", `{}`), 200, "")
	if rec := e.do("GET", q("/api/read", "path", `C:\Users\me\Presets\a.xmp`), nil); rec.Code == 403 {
		t.Errorf("picked folder refused: %s", rec.Body.String())
	}
	for _, p := range []string{`C:\Users\me\Presets2\a.xmp`, `C:\Users\me\secret.txt`, `C:\Users\me\Presets\..\secret.txt`, `C:\Windows`} {
		wantStatus(t, e.do("GET", q("/api/read", "path", p), nil), 403, "forbidden")
	}
	// Network and device locations cannot be picked.
	for _, p := range []string{`\\server\share\Presets`, `\\?\C:\Users\me`, `C:`} {
		e.host.pick = p
		wantStatus(t, e.do("POST", "/api/pick-directory", `{}`), 400, "invalid")
	}
}
