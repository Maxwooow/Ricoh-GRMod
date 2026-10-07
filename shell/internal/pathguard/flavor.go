// Package pathguard confines user-supplied paths to a set of allowed roots.
//
// The work is split in two layers:
//
//   - a Flavor implements the purely lexical rules of one path syntax (POSIX
//     or Windows). Both flavors are compiled on every platform so that the
//     Windows rules can be unit-tested on Linux by passing Windows-style
//     paths as plain strings.
//   - a Guard combines a Flavor with a (replaceable) filesystem to resolve
//     symbolic links before the final containment check.
package pathguard

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"unicode/utf8"
)

// Kind classifies a confinement failure.
type Kind int

const (
	// Invalid: the request is malformed (for example an empty path).
	Invalid Kind = iota + 1
	// Forbidden: the path breaks a confinement rule.
	Forbidden
	// NotFound: nothing of the path exists, not even its volume.
	NotFound
)

// Error is returned for every rejection made by this package itself. Errors
// coming from the filesystem are returned unchanged.
type Error struct {
	Kind   Kind
	Reason string
}

func (e *Error) Error() string { return e.Reason }

func errKind(k Kind, format string, a ...any) error {
	return &Error{Kind: k, Reason: fmt.Sprintf(format, a...)}
}

// KindOf returns the Kind of err, or 0 when err was not produced by this
// package.
func KindOf(err error) Kind {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return 0
}

// maxPathLen bounds accepted paths; nothing this program handles gets close.
const maxPathLen = 4096

// Flavor is one path syntax.
type Flavor interface {
	// Name is "posix" or "windows".
	Name() string
	// Clean validates an absolute path and returns its canonical spelling:
	// separators unified, "." and ".." resolved lexically, no trailing
	// separator. Anything suspicious is rejected instead of being repaired.
	Clean(p string) (string, error)

	// split breaks a cleaned path into its volume root and the components
	// below it.
	split(clean string) (vol string, parts []string)
	// join is the inverse of split.
	join(vol string, parts []string) string
	// same reports whether two volume names or components name the same
	// thing.
	same(a, b string) bool
}

// Posix and Windows are the two supported flavors.
var (
	Posix   Flavor = posixFlavor{}
	Windows Flavor = windowsFlavor{}
)

// Native returns the flavor of the running operating system.
func Native() Flavor {
	if runtime.GOOS == "windows" {
		return Windows
	}
	return Posix
}

// Within reports whether the cleaned path p is root itself or lies below it.
// Both arguments must come from f.Clean.
func Within(f Flavor, root, p string) bool {
	rv, rp := f.split(root)
	pv, pp := f.split(p)
	if !f.same(rv, pv) || len(pp) < len(rp) {
		return false
	}
	for i := range rp {
		if !f.same(rp[i], pp[i]) {
			return false
		}
	}
	return true
}

// SameVolume reports whether two cleaned paths are on the same volume as far
// as the syntax can tell (always true for POSIX).
func SameVolume(f Flavor, a, b string) bool {
	av, _ := f.split(a)
	bv, _ := f.split(b)
	return f.same(av, bv)
}

// checkText applies the checks shared by both flavors.
func checkText(p string) error {
	if p == "" {
		return errKind(Invalid, "path is empty")
	}
	if len(p) > maxPathLen {
		return errKind(Forbidden, "path is too long")
	}
	if !utf8.ValidString(p) {
		return errKind(Forbidden, "path is not valid UTF-8")
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return errKind(Forbidden, "path contains a control character")
		}
	}
	return nil
}

// resolveDots folds "", "." and ".." components. check is called for every
// real component. A ".." that would climb above the volume root is an error.
func resolveDots(parts []string, check func(string) error) ([]string, error) {
	out := make([]string, 0, len(parts))
	for _, c := range parts {
		switch c {
		case "", ".":
		case "..":
			if len(out) == 0 {
				return nil, errKind(Forbidden, "path climbs above its volume root")
			}
			out = out[:len(out)-1]
		default:
			if check != nil {
				if err := check(c); err != nil {
					return nil, err
				}
			}
			out = append(out, c)
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- POSIX

type posixFlavor struct{}

func (posixFlavor) Name() string { return "posix" }

func (posixFlavor) Clean(p string) (string, error) {
	if err := checkText(p); err != nil {
		return "", err
	}
	if strings.ContainsRune(p, '\\') {
		// A backslash is an ordinary file-name character here, but the same
		// request would mean something else on Windows. Refuse it.
		return "", errKind(Forbidden, "path contains a backslash")
	}
	if !strings.HasPrefix(p, "/") {
		return "", errKind(Forbidden, "path is not absolute")
	}
	parts, err := resolveDots(strings.Split(p, "/"), nil)
	if err != nil {
		return "", err
	}
	return "/" + strings.Join(parts, "/"), nil
}

func (posixFlavor) split(clean string) (string, []string) {
	rest := strings.TrimPrefix(clean, "/")
	if rest == "" {
		return "/", nil
	}
	return "/", strings.Split(rest, "/")
}

func (posixFlavor) join(vol string, parts []string) string {
	return "/" + strings.Join(parts, "/")
}

func (posixFlavor) same(a, b string) bool { return a == b }

// -------------------------------------------------------------- Windows

type windowsFlavor struct{}

func (windowsFlavor) Name() string { return "windows" }

// Clean accepts only fully qualified drive paths ("E:\dir\file", forward
// slashes tolerated) and rejects everything Win32 would silently reinterpret:
// UNC and device namespaces, drive-relative and rooted-relative paths,
// alternate data streams, wildcard characters, components ending in a dot or
// a space, and the reserved DOS device names.
func (windowsFlavor) Clean(p string) (string, error) {
	if err := checkText(p); err != nil {
		return "", err
	}
	s := strings.ReplaceAll(p, "/", `\`)
	if strings.HasPrefix(s, `\\`) {
		return "", errKind(Forbidden, `UNC and device paths (\\server, \\?\, \\.\) are not allowed`)
	}
	if strings.HasPrefix(s, `\`) {
		return "", errKind(Forbidden, "path has no drive letter")
	}
	if len(s) < 3 || !isDriveLetter(s[0]) || s[1] != ':' || s[2] != '\\' {
		return "", errKind(Forbidden, `path is not absolute (expected something like E:\folder)`)
	}
	parts, err := resolveDots(strings.Split(s[3:], `\`), checkWindowsComponent)
	if err != nil {
		return "", err
	}
	drive := strings.ToUpper(s[:1])
	return drive + `:\` + strings.Join(parts, `\`), nil
}

func (windowsFlavor) split(clean string) (string, []string) {
	if len(clean) < 3 {
		return clean, nil
	}
	rest := clean[3:]
	if rest == "" {
		return clean[:3], nil
	}
	return clean[:3], strings.Split(rest, `\`)
}

func (windowsFlavor) join(vol string, parts []string) string {
	return vol + strings.Join(parts, `\`)
}

func (windowsFlavor) same(a, b string) bool { return strings.EqualFold(a, b) }

func isDriveLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func checkWindowsComponent(c string) error {
	if strings.ContainsRune(c, ':') {
		return errKind(Forbidden, "path component contains ':' (alternate data stream)")
	}
	if strings.ContainsAny(c, `<>"|?*`) {
		return errKind(Forbidden, "path component contains a reserved character")
	}
	if last := c[len(c)-1]; last == '.' || last == ' ' {
		return errKind(Forbidden, "path component ends with a dot or a space")
	}
	if isReservedWindowsName(c) {
		return errKind(Forbidden, "path component is a reserved device name")
	}
	return nil
}

// isReservedWindowsName reports whether Win32 would open a device instead of
// a file for this component: CON, PRN, AUX, NUL, COMn, LPTn, CONIN$,
// CONOUT$ and CLOCK$, with any extension ("NUL.txt") and in any case.
func isReservedWindowsName(c string) bool {
	base := c
	if i := strings.IndexByte(base, '.'); i >= 0 {
		base = base[:i]
	}
	base = strings.ToUpper(strings.TrimRight(base, " "))
	switch base {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$":
		return true
	}
	for _, prefix := range []string{"COM", "LPT"} {
		if rest, ok := strings.CutPrefix(base, prefix); ok {
			switch rest {
			case "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "\u00b9", "\u00b2", "\u00b3":
				return true
			}
		}
	}
	return false
}

// IsReservedWindowsName is exported for callers that build file names from
// user input (the key/value store).
func IsReservedWindowsName(name string) bool { return isReservedWindowsName(name) }
