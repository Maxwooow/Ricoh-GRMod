package pathguard

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// FS is the part of the filesystem the guard needs. The real implementation
// is OS; tests substitute a fake to exercise Windows-style paths on Linux.
type FS interface {
	Lstat(name string) (fs.FileInfo, error)
	EvalSymlinks(name string) (string, error)
}

// OS is the real filesystem.
type OS struct{}

func (OS) Lstat(name string) (fs.FileInfo, error)   { return os.Lstat(name) }
func (OS) EvalSymlinks(name string) (string, error) { return filepath.EvalSymlinks(name) }

// Guard resolves user paths against allowed roots.
type Guard struct {
	Flavor Flavor
	FS     FS
}

// Resolved is a path that passed every check.
type Resolved struct {
	// Path is the symlink-free path to operate on.
	Path string
	// Root is the (symlink-free) allowed root that contains Path.
	Root string
	// Lexical is the cleaned path as the caller spelled it, before symbolic
	// links were resolved.
	Lexical string
	// IsRoot reports whether Path is the allowed root itself.
	IsRoot bool
}

// Resolve checks p against roots.
//
//  1. p is cleaned lexically and must lie inside one of the cleaned roots.
//  2. Symbolic links are resolved on the longest existing prefix of p; a
//     dangling link is refused because writing through it would create its
//     target.
//  3. The resolved path must lie inside one of the resolved roots.
//  4. No existing component below that root may still be a link, and every
//     existing intermediate component must be a real directory. (On Windows
//     this is what catches directory junctions, which EvalSymlinks does not
//     follow.)
//
// Roots that cannot be cleaned or do not exist are ignored.
func (g Guard) Resolve(p string, roots []string) (Resolved, error) {
	f := g.Flavor
	clean, err := f.Clean(p)
	if err != nil {
		return Resolved{}, err
	}

	var cleanRoots []string
	inside := false
	for _, r := range roots {
		rc, err := f.Clean(r)
		if err != nil {
			continue
		}
		cleanRoots = append(cleanRoots, rc)
		if Within(f, rc, clean) {
			inside = true
		}
	}
	if !inside {
		return Resolved{}, errKind(Forbidden, "path is outside the allowed locations")
	}

	resolved, existing, err := g.resolveExisting(clean)
	if err != nil {
		return Resolved{}, err
	}

	best := ""
	bestLen := -1
	for _, rc := range cleanRoots {
		ev, err := g.FS.EvalSymlinks(rc)
		if err != nil {
			continue
		}
		rr, err := f.Clean(ev)
		if err != nil || !Within(f, rr, resolved) {
			continue
		}
		if _, parts := f.split(rr); len(parts) > bestLen {
			best, bestLen = rr, len(parts)
		}
	}
	if bestLen < 0 {
		return Resolved{}, errKind(Forbidden, "path leads outside the allowed locations")
	}

	vol, parts := f.split(resolved)
	for i := bestLen + 1; i <= existing; i++ {
		fi, err := g.FS.Lstat(f.join(vol, parts[:i]))
		if err != nil {
			if isMissing(err) {
				break // removed meanwhile; the operation itself will report it
			}
			return Resolved{}, err
		}
		mode := fi.Mode()
		if mode&fs.ModeSymlink != 0 {
			return Resolved{}, errKind(Forbidden, "path goes through a symbolic link")
		}
		if i < len(parts) && !mode.IsDir() {
			if mode&fs.ModeIrregular != 0 {
				return Resolved{}, errKind(Forbidden, "path goes through a junction or reparse point")
			}
			return Resolved{}, errKind(Invalid, "a parent of the path is not a directory")
		}
	}
	return Resolved{Path: resolved, Root: best, Lexical: clean, IsRoot: len(parts) == bestLen}, nil
}

// resolveExisting resolves symbolic links on the longest existing prefix of
// the cleaned path and re-attaches the remainder. It returns the resolved
// path and how many of its components exist.
func (g Guard) resolveExisting(clean string) (string, int, error) {
	f := g.Flavor
	vol, parts := f.split(clean)
	for i := len(parts); i >= 0; i-- {
		cur := f.join(vol, parts[:i])
		if _, err := g.FS.Lstat(cur); err != nil {
			if isMissing(err) {
				continue
			}
			return "", 0, err
		}
		ev, err := g.FS.EvalSymlinks(cur)
		if err != nil {
			if isMissing(err) {
				return "", 0, errKind(Forbidden, "path goes through a dangling symbolic link")
			}
			return "", 0, err
		}
		evc, err := f.Clean(ev)
		if err != nil {
			return "", 0, errKind(Forbidden, "path resolves to an unsupported location")
		}
		ev2, eparts := f.split(evc)
		return f.join(ev2, append(append([]string{}, eparts...), parts[i:]...)), len(eparts), nil
	}
	return "", 0, errKind(NotFound, "the volume of the path is not available")
}

// isMissing reports whether err means "this name does not exist", including
// the case where a parent turned out to be a file.
func isMissing(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR)
}
