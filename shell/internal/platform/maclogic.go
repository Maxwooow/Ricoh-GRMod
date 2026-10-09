package platform

import (
	"bufio"
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"path"
	"strconv"
	"strings"
)

// This file interprets what the macOS tools print (diskutil, scutil) and
// decides which volumes are offered. It is compiled everywhere and
// unit-tested on Linux; the commands themselves are run in darwin.go.

// MacDiskInfo is the part of `diskutil info -plist <mount point>` that
// matters here.
type MacDiskInfo struct {
	BusProtocol       string // "USB", "Secure Digital", "PCI-Express", "Disk Image", ...
	Internal          bool
	Removable         bool // "Removable" or "RemovableMedia"
	Ejectable         bool
	ExternalOrRemoved bool   // "RemovableMediaOrExternalDevice"
	FilesystemType    string // "msdos", "exfat", "apfs", ...
	FilesystemName    string // "MS-DOS (FAT32)", "ExFAT", "APFS", ... (user-visible name)
	VolumeName        string
	MountPoint        string
	Writable          bool
	WritableKnown     bool
}

// ParsePlistDict reads the top-level <dict> of an XML property list into a
// map. Strings, integers and reals become strings, booleans become bools;
// nested arrays and dictionaries are skipped.
func ParsePlistDict(data []byte) (map[string]any, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = false
	out := map[string]any{}
	depth := 0 // depth of <dict>/<array> nesting, 1 = top-level dict
	key := ""
	inTop := false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "dict", "array":
				depth++
				if depth == 1 && t.Name.Local == "dict" {
					inTop = true
				}
				key = ""
			case "key":
				var s string
				if err := dec.DecodeElement(&s, &t); err != nil {
					return nil, err
				}
				if depth == 1 {
					key = s
				}
			case "string", "integer", "real", "date", "data":
				var s string
				if err := dec.DecodeElement(&s, &t); err != nil {
					return nil, err
				}
				if depth == 1 && key != "" {
					out[key] = strings.TrimSpace(s)
				}
				key = ""
			case "true", "false":
				if depth == 1 && key != "" {
					out[key] = t.Name.Local == "true"
				}
				key = ""
			}
		case xml.EndElement:
			if t.Name.Local == "dict" || t.Name.Local == "array" {
				depth--
				key = ""
			}
		}
	}
	if !inTop {
		return nil, errors.New("no dictionary in the property list")
	}
	return out, nil
}

// ParseDiskutilInfo interprets `diskutil info -plist`.
func ParseDiskutilInfo(data []byte) (MacDiskInfo, error) {
	d, err := ParsePlistDict(data)
	if err != nil {
		return MacDiskInfo{}, err
	}
	str := func(k string) string { s, _ := d[k].(string); return s }
	flag := func(k string) bool { b, _ := d[k].(bool); return b }
	info := MacDiskInfo{
		BusProtocol:       str("BusProtocol"),
		Internal:          flag("Internal"),
		Removable:         flag("Removable") || flag("RemovableMedia"),
		Ejectable:         flag("Ejectable"),
		ExternalOrRemoved: flag("RemovableMediaOrExternalDevice"),
		FilesystemType:    str("FilesystemType"),
		FilesystemName:    str("FilesystemUserVisibleName"),
		VolumeName:        str("VolumeName"),
		MountPoint:        str("MountPoint"),
	}
	if info.FilesystemName == "" {
		info.FilesystemName = str("FilesystemName")
	}
	if w, ok := d["WritableVolume"].(bool); ok {
		info.Writable, info.WritableKnown = w, true
	}
	return info, nil
}

// MacBusName shortens diskutil's bus protocol to the names the Windows build
// reports ("USB", "SD", ...).
func MacBusName(protocol string) string {
	switch strings.ToLower(strings.TrimSpace(protocol)) {
	case "":
		return ""
	case "usb":
		return "USB"
	case "secure digital", "sd":
		return "SD"
	case "pci-express", "pci":
		return "PCIe"
	case "sata":
		return "SATA"
	case "thunderbolt":
		return "Thunderbolt"
	case "disk image":
		return "Disk Image"
	}
	return protocol
}

// ClassifyMacVolume decides whether a mounted volume is listed and whether
// it is reported as removable, like ClassifyDrive does on Windows. Disk
// images (.dmg) are never offered.
func ClassifyMacVolume(info MacDiskInfo, all bool) (include, removable bool) {
	bus := MacBusName(info.BusProtocol)
	if bus == "Disk Image" {
		return false, false
	}
	// The same rule as ClassifyDrive on Windows: removable media, or a disk
	// on a USB or SD bus. Other external disks (Thunderbolt SSDs and the
	// like) are only listed with all.
	if info.Removable || bus == "USB" || bus == "SD" {
		return true, true
	}
	return all, false
}

// IsLocalMacFS reports whether a statfs file system type is a local disk
// format that can sit on a card or drive (network and virtual file systems
// are left out).
func IsLocalMacFS(fstype string) bool {
	switch strings.ToLower(fstype) {
	case "msdos", "exfat", "apfs", "hfs", "ntfs", "ufs", "lifs":
		return true
	}
	return false
}

// MacFSName turns diskutil's user-visible file system name (preferred) or the
// statfs type into the names the Windows build reports: "FAT32", "exFAT",
// "NTFS", ... total is the volume size and only helps when diskutil gave
// nothing.
func MacFSName(visible, fstype string, total uint64) string {
	v := strings.ToUpper(strings.TrimSpace(visible))
	switch {
	case strings.Contains(v, "FAT32"):
		return "FAT32"
	case strings.Contains(v, "FAT16"):
		return "FAT16"
	case strings.Contains(v, "FAT12"):
		return "FAT12"
	case strings.Contains(v, "EXFAT"):
		return "exFAT"
	case strings.Contains(v, "APFS"):
		return "APFS"
	case strings.Contains(v, "MAC OS EXTENDED"), strings.Contains(v, "HFS"):
		return "HFS+"
	case strings.Contains(v, "NTFS"):
		return "NTFS"
	}
	switch strings.ToLower(fstype) {
	case "msdos":
		// FAT16 cannot exceed 4 GB; anything bigger is FAT32.
		if total > 4<<30 {
			return "FAT32"
		}
		return "FAT"
	case "exfat":
		return "exFAT"
	case "apfs":
		return "APFS"
	case "hfs":
		return "HFS+"
	case "ntfs":
		return "NTFS"
	}
	if visible != "" {
		return visible
	}
	return strings.ToUpper(fstype)
}

// IsVolumesMount reports whether p is a direct child of /Volumes, the only
// place where macOS mounts cards and external drives.
func IsVolumesMount(p string) bool {
	clean := path.Clean(p)
	return path.Dir(clean) == "/Volumes" && path.Base(clean) != "" && !strings.HasPrefix(path.Base(clean), ".")
}

// ParseScutilProxy interprets `scutil --proxy` (the system proxy settings)
// as ProxySettings, so that ProxyFor applies the same rules as on Windows.
func ParseScutilProxy(out string) ProxySettings {
	// Only the top level counts: the output also holds per-interface
	// settings (__SCOPED__ : <dictionary> { en0 : <dictionary> { ... } }).
	vals := map[string]string{}
	var exceptions []string
	depth := 0
	inExceptions := false
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "}" {
			depth--
			inExceptions = false
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		opens := strings.HasSuffix(line, "{")
		if inExceptions && depth == 2 && ok {
			exceptions = append(exceptions, v)
		} else if depth == 1 && ok && !opens {
			vals[k] = v
		}
		if opens {
			depth++
			inExceptions = depth == 2 && k == "ExceptionsList"
		}
	}
	var p ProxySettings
	var servers []string
	add := func(scheme, prefix string) {
		if vals[prefix+"Enable"] != "1" {
			return
		}
		host, port := vals[prefix+"Proxy"], vals[prefix+"Port"]
		if host == "" {
			return
		}
		if n, err := strconv.Atoi(port); err == nil && n > 0 {
			host += ":" + port
		}
		servers = append(servers, scheme+"="+host)
	}
	add("http", "HTTP")
	add("https", "HTTPS")
	add("socks", "SOCKS")
	if len(servers) > 0 {
		p.Enable = true
		p.Server = strings.Join(servers, ";")
	}
	if vals["ExcludeSimpleHostnames"] == "1" {
		exceptions = append(exceptions, "<local>")
	}
	p.Override = strings.Join(exceptions, ";")
	return p
}

// MacBrowsers lists Chromium-based browsers that can open an "app" window,
// as the executables inside their bundles, in the order they are tried.
func MacBrowsers(home string) []string {
	apps := []struct{ bundle, exe string }{
		{"Google Chrome.app", "Google Chrome"},
		{"Microsoft Edge.app", "Microsoft Edge"},
		{"Brave Browser.app", "Brave Browser"},
		{"Chromium.app", "Chromium"},
		{"Vivaldi.app", "Vivaldi"},
	}
	dirs := []string{"/Applications"}
	if strings.HasPrefix(home, "/") {
		dirs = append(dirs, strings.TrimRight(home, "/")+"/Applications")
	}
	var out []string
	for _, a := range apps {
		for _, d := range dirs {
			out = append(out, d+"/"+a.bundle+"/Contents/MacOS/"+a.exe)
		}
	}
	return out
}
