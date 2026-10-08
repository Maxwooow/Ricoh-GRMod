package platform

import (
	"encoding/binary"
	"errors"
	"net/url"
	"strings"
)

// Drive types returned by GetDriveType.
const (
	DriveUnknown   = 0
	DriveNoRootDir = 1
	DriveRemovable = 2
	DriveFixed     = 3
	DriveRemote    = 4
	DriveCDROM     = 5
	DriveRAMDisk   = 6
)

// CtlCode is the CTL_CODE macro from the Windows SDK.
func CtlCode(deviceType, function, method, access uint32) uint32 {
	return deviceType<<16 | access<<14 | function<<2 | method
}

// Device I/O control codes used by the Windows build. They are spelled with
// CtlCode so that a unit test can pin them to the documented values.
var (
	IoctlStorageQueryProperty = CtlCode(0x2d, 0x0500, 0, 0) // IOCTL_STORAGE_QUERY_PROPERTY
	IoctlStorageMediaRemoval  = CtlCode(0x2d, 0x0201, 0, 1) // IOCTL_STORAGE_MEDIA_REMOVAL
	IoctlStorageEjectMedia    = CtlCode(0x2d, 0x0202, 0, 1) // IOCTL_STORAGE_EJECT_MEDIA
	FsctlLockVolume           = CtlCode(0x09, 6, 0, 0)      // FSCTL_LOCK_VOLUME
	FsctlUnlockVolume         = CtlCode(0x09, 7, 0, 0)      // FSCTL_UNLOCK_VOLUME
	FsctlDismountVolume       = CtlCode(0x09, 8, 0, 0)      // FSCTL_DISMOUNT_VOLUME
)

// StoragePropertyQuerySize is sizeof(STORAGE_PROPERTY_QUERY): two 32-bit
// enums and a one-byte flexible array, padded to 4-byte alignment. All zero
// bytes mean StorageDeviceProperty / PropertyStandardQuery.
const StoragePropertyQuerySize = 12

// busNames maps STORAGE_BUS_TYPE values to the names used in the API.
var busNames = map[uint32]string{
	1: "SCSI", 2: "ATAPI", 3: "ATA", 4: "1394", 5: "SSA", 6: "FIBRE",
	7: "USB", 8: "RAID", 9: "ISCSI", 10: "SAS", 11: "SATA", 12: "SD",
	13: "MMC", 14: "VIRTUAL", 15: "VHD", 16: "SPACES", 17: "NVME",
	18: "SCM", 19: "UFS",
}

// BusName returns the API name of a STORAGE_BUS_TYPE value, or "" when it
// is unknown.
func BusName(busType uint32) string { return busNames[busType] }

// ParseStorageDeviceDescriptor extracts the bus type and the removable-media
// flag from a STORAGE_DEVICE_DESCRIPTOR as returned by
// IOCTL_STORAGE_QUERY_PROPERTY.
//
//	offset  0  DWORD   Version
//	offset  4  DWORD   Size
//	offset  8  BYTE    DeviceType
//	offset  9  BYTE    DeviceTypeModifier
//	offset 10  BOOLEAN RemovableMedia
//	offset 11  BOOLEAN CommandQueueing
//	offset 12  DWORD   VendorIdOffset
//	offset 16  DWORD   ProductIdOffset
//	offset 20  DWORD   ProductRevisionOffset
//	offset 24  DWORD   SerialNumberOffset
//	offset 28  DWORD   BusType (STORAGE_BUS_TYPE)
func ParseStorageDeviceDescriptor(buf []byte) (busType uint32, removableMedia bool, ok bool) {
	if len(buf) < 32 {
		return 0, false, false
	}
	if size := binary.LittleEndian.Uint32(buf[4:8]); size < 32 {
		return 0, false, false
	}
	return binary.LittleEndian.Uint32(buf[28:32]), buf[10] != 0, true
}

// ClassifyDrive decides whether a drive is listed and whether it is reported
// as removable. bus is a BusName result ("" when the query failed, in which
// case only the drive type counts).
func ClassifyDrive(driveType uint32, bus string, all bool) (include, removable bool) {
	switch driveType {
	case DriveRemovable:
		return true, true
	case DriveFixed:
		if bus == "USB" || bus == "SD" || bus == "MMC" {
			return true, true
		}
		return all, false
	}
	return false, false
}

// DriveLetters expands a GetLogicalDrives bit mask into "A:" … "Z:".
func DriveLetters(mask uint32) []string {
	var out []string
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) != 0 {
			out = append(out, string(rune('A'+i))+":")
		}
	}
	return out
}

// DriveOf returns the upper-case "X:" prefix of a Windows path, or "" when
// the path does not start with a drive letter.
func DriveOf(path string) string {
	if len(path) >= 2 && path[1] == ':' {
		c := path[0]
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		if c >= 'A' && c <= 'Z' {
			return string(rune(c)) + ":"
		}
	}
	return ""
}

// IsDriveID reports whether id has the exact form "X:".
func IsDriveID(id string) bool { return len(id) == 2 && DriveOf(id) != "" }

// ExplorerCommandLine builds the raw command line that makes Explorer show a
// path: "/select," for files, the folder itself for directories.
//
// Explorer does its own command-line parsing, so the line is assembled by
// hand instead of going through the usual argument quoting: the path is
// wrapped in quotes, except when it ends in a backslash (a drive root),
// where a closing quote would be read as escaped.
func ExplorerCommandLine(explorer, path string, isDir bool) (string, error) {
	if path == "" || strings.ContainsAny(path, "\"\r\n\x00") {
		return "", errors.New("path cannot be passed to Explorer")
	}
	arg := `"` + path + `"`
	if strings.HasSuffix(path, `\`) {
		if strings.ContainsAny(path, " ,") {
			return "", errors.New("path cannot be passed to Explorer")
		}
		arg = path
	}
	if !isDir {
		arg = "/select," + arg
	}
	return `"` + explorer + `" ` + arg, nil
}

// ProxySettings are the proxy settings of the current user as Windows keeps
// them for WinINet (Settings > Network > Proxy > manual setup):
// HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings, values
// ProxyEnable, ProxyServer and ProxyOverride.
type ProxySettings struct {
	Enable   bool
	Server   string
	Override string
}

// ProxyFor returns the proxy to use for a request to u, or nil for a direct
// connection. A set-up script (PAC) is not evaluated: with only a script
// configured the connection is direct.
//
// ProxyServer is either "host:port" for every protocol or a list such as
// "http=a:80;https=b:443;socks=c:1080"; an entry may carry a scheme of its
// own ("http://a:80"). ProxyOverride lists hosts that bypass the proxy,
// separated by semicolons, with "*" wildcards; "<local>" stands for names
// without a dot.
func (p ProxySettings) ProxyFor(u *url.URL) *url.URL {
	if !p.Enable || u == nil {
		return nil
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return nil
	}
	for _, pattern := range strings.FieldsFunc(p.Override, func(r rune) bool { return r == ';' || r == ' ' }) {
		pattern = strings.ToLower(strings.TrimSpace(pattern))
		if pattern == "<local>" {
			if !strings.Contains(host, ".") {
				return nil
			}
			continue
		}
		if i := strings.Index(pattern, "://"); i >= 0 {
			pattern = pattern[i+3:]
		}
		if pattern != "" && wildcardMatch(pattern, host) {
			return nil
		}
	}
	var all, byScheme, socks string
	for _, entry := range strings.FieldsFunc(p.Server, func(r rune) bool { return r == ';' || r == ' ' }) {
		entry = strings.TrimSpace(entry)
		key, value, found := strings.Cut(entry, "=")
		if !found {
			if all == "" {
				all = entry
			}
			continue
		}
		switch strings.ToLower(strings.TrimSpace(key)) {
		case strings.ToLower(u.Scheme):
			byScheme = strings.TrimSpace(value)
		case "socks":
			socks = strings.TrimSpace(value)
		}
	}
	switch {
	case byScheme != "":
		return proxyURL(byScheme, "http")
	case all != "":
		return proxyURL(all, "http")
	case socks != "":
		return proxyURL(socks, "socks5")
	}
	return nil
}

// proxyURL parses "host:port" or "scheme://host:port".
func proxyURL(s, defaultScheme string) *url.URL {
	if !strings.Contains(s, "://") {
		s = defaultScheme + "://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return nil
	}
	switch u.Scheme {
	case "http", "https", "socks5":
	case "socks", "socks4", "socks4a", "socks5h":
		u.Scheme = "socks5"
	default:
		return nil
	}
	return &url.URL{Scheme: u.Scheme, Host: u.Host, User: u.User}
}

// wildcardMatch reports whether s matches pattern, where "*" stands for any
// run of characters.
func wildcardMatch(pattern, s string) bool {
	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		return pattern == s
	}
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	last := parts[len(parts)-1]
	for _, part := range parts[1 : len(parts)-1] {
		i := strings.Index(s, part)
		if i < 0 {
			return false
		}
		s = s[i+len(part):]
	}
	return len(s) >= len(last) && strings.HasSuffix(s, last)
}

// BrowserURL checks that an address can be handed to the default browser:
// an absolute http(s) address made of plain URL characters only, so that it
// passes through a command line unchanged.
func BrowserURL(address string) (string, error) {
	u, err := url.Parse(address)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
		return "", errors.New("not a web address")
	}
	for _, r := range address {
		if r <= ' ' || r > '~' || strings.ContainsRune("\"'`<>^|\\{}", r) {
			return "", errors.New("address cannot be passed to the browser")
		}
	}
	return address, nil
}
