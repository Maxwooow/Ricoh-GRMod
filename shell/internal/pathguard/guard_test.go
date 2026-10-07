package pathguard

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------- fake FS

// fakeFS is an in-memory tree addressed with cleaned paths of one flavor. It
// lets the resolver be exercised with Windows paths on any platform.
type fakeFS struct {
	f     Flavor
	nodes map[string]fakeNode
}

type fakeNode struct {
	mode   fs.FileMode
	target string // for symlinks: absolute target
}

type fakeInfo struct {
	name string
	mode fs.FileMode
}

func (i fakeInfo) Name() string       { return i.name }
func (i fakeInfo) Size() int64        { return 0 }
func (i fakeInfo) Mode() fs.FileMode  { return i.mode }
func (i fakeInfo) ModTime() time.Time { return time.Time{} }
func (i fakeInfo) IsDir() bool        { return i.mode.IsDir() }
func (i fakeInfo) Sys() any           { return nil }

func newFakeFS(f Flavor) *fakeFS { return &fakeFS{f: f, nodes: map[string]fakeNode{}} }

func (m *fakeFS) dir(p string)  { m.nodes[m.key(p)] = fakeNode{mode: fs.ModeDir | 0o755} }
func (m *fakeFS) file(p string) { m.nodes[m.key(p)] = fakeNode{mode: 0o644} }
func (m *fakeFS) link(p, target string) {
	m.nodes[m.key(p)] = fakeNode{mode: fs.ModeSymlink | 0o777, target: target}
}
func (m *fakeFS) junction(p string) { m.nodes[m.key(p)] = fakeNode{mode: fs.ModeIrregular | 0o666} }
func (m *fakeFS) cloudDir(p string) {
	m.nodes[m.key(p)] = fakeNode{mode: fs.ModeDir | fs.ModeIrregular | 0o777}
}
func (m *fakeFS) key(p string) string {
	if m.f.Name() == "windows" {
		return strings.ToUpper(p)
	}
	return p
}

var errFakeLoop = errors.New("too many links")

// follow resolves every symlink in p, like EvalSymlinks.
func (m *fakeFS) follow(p string, final bool) (string, error) {
	for hops := 0; hops < 40; hops++ {
		vol, parts := m.f.split(p)
		restart := false
		for i := 0; i <= len(parts); i++ {
			cur := m.f.join(vol, parts[:i])
			n, ok := m.nodes[m.key(cur)]
			if !ok {
				return "", &fs.PathError{Op: "lstat", Path: cur, Err: fs.ErrNotExist}
			}
			last := i == len(parts)
			if n.mode&fs.ModeSymlink != 0 && (!last || final) {
				p = m.f.join(vol, nil)
				tv, tp := m.f.split(n.target)
				p = m.f.join(tv, append(append([]string{}, tp...), parts[i:]...))
				restart = true
				break
			}
			if !last && n.mode&fs.ModeDir == 0 && n.mode&fs.ModeIrregular == 0 {
				return "", &fs.PathError{Op: "lstat", Path: cur, Err: fs.ErrNotExist}
			}
		}
		if !restart {
			return p, nil
		}
	}
	return "", errFakeLoop
}

func (m *fakeFS) Lstat(name string) (fs.FileInfo, error) {
	p, err := m.follow(name, false)
	if err != nil {
		return nil, err
	}
	return fakeInfo{name: p, mode: m.nodes[m.key(p)].mode}, nil
}

func (m *fakeFS) EvalSymlinks(name string) (string, error) { return m.follow(name, true) }

func windowsFixture() *fakeFS {
	m := newFakeFS(Windows)
	m.dir(`C:\`)
	m.dir(`C:\Windows`)
	m.file(`C:\Windows\win.ini`)
	m.dir(`C:\Users`)
	m.dir(`C:\Users\me`)
	m.dir(`C:\Users\me\Presets`)
	m.file(`C:\Users\me\Presets\a.xmp`)
	m.file(`C:\Users\me\secret.txt`)
	m.dir(`E:\`)
	m.dir(`E:\DCIM`)
	m.dir(`E:\DCIM\100RICOH`)
	m.file(`E:\DCIM\100RICOH\R0000001.DNG`)
	m.file(`E:\firmware.bin`)
	m.link(`E:\escape`, `C:\Windows`)
	m.link(`E:\escapefile`, `C:\Windows\win.ini`)
	m.link(`E:\inside`, `E:\DCIM\100RICOH`)
	m.link(`E:\dangling`, `C:\Windows\new.txt`)
	m.link(`E:\topresets`, `C:\Users\me\Presets`)
	m.junction(`E:\junction`)
	m.cloudDir(`C:\Users\me\Presets\cloud`)
	m.file(`C:\Users\me\Presets\cloud\b.xmp`)
	m.link(`C:\Users\me\Presets\up`, `C:\Users\me`)
	return m
}

func TestResolveWindowsFlavorOnFakeFS(t *testing.T) {
	m := windowsFixture()
	g := Guard{Flavor: Windows, FS: m}
	roots := []string{`E:\`, `C:\Users\me\Presets`, `Q:\`, `not a root`}

	type tc struct {
		in   string
		want string // resolved path, or "" for rejection
		kind Kind
	}
	cases := []tc{
		{in: `E:\`, want: `E:\`},
		{in: `e:/dcim/100ricoh/R0000001.DNG`, want: `E:\dcim\100ricoh\R0000001.DNG`},
		{in: `E:\DCIM\100RICOH\new.bin`, want: `E:\DCIM\100RICOH\new.bin`},
		{in: `E:\new dir\sub\file.bin`, want: `E:\new dir\sub\file.bin`},
		{in: `E:\DCIM\..\firmware.bin`, want: `E:\firmware.bin`},
		{in: `E:\inside\new.bin`, want: `E:\DCIM\100RICOH\new.bin`},
		{in: `E:\inside`, want: `E:\DCIM\100RICOH`},
		{in: `C:\Users\me\Presets\a.xmp`, want: `C:\Users\me\Presets\a.xmp`},
		{in: `c:\users\ME\presets\new\x.xmp`, want: `C:\users\ME\presets\new\x.xmp`},
		{in: `C:\Users\me\Presets\cloud\b.xmp`, want: `C:\Users\me\Presets\cloud\b.xmp`},
		// A link from one allowed root into another allowed root is fine.
		{in: `E:\topresets\a.xmp`, want: `C:\Users\me\Presets\a.xmp`},

		{in: `C:\Windows\win.ini`, kind: Forbidden},
		{in: `C:\Users\me\secret.txt`, kind: Forbidden},
		{in: `C:\Users\me\Presets\..\secret.txt`, kind: Forbidden},
		{in: `C:\Users\me\Presets2\a.xmp`, kind: Forbidden},
		{in: `D:\x`, kind: Forbidden},
		{in: `Q:\x`, kind: NotFound}, // allowed root whose volume is gone
		{in: `E:\escape\win.ini`, kind: Forbidden},
		{in: `E:\escape\new.txt`, kind: Forbidden},
		{in: `E:\escape`, kind: Forbidden},
		{in: `E:\escapefile`, kind: Forbidden},
		{in: `E:\dangling`, kind: Forbidden},
		{in: `E:\dangling\x`, kind: Forbidden},
		{in: `C:\Users\me\Presets\up\secret.txt`, kind: Forbidden},
		{in: `E:\junction\x`, kind: Forbidden},
		{in: `E:\firmware.bin\x`, kind: Invalid},
		{in: `\\?\E:\firmware.bin`, kind: Forbidden},
		{in: `\\.\E:`, kind: Forbidden},
		{in: `E:\firmware.bin:ads`, kind: Forbidden},
		{in: `E:\firmware.bin.`, kind: Forbidden},
		{in: `E:\DCIM\..\..\Windows`, kind: Forbidden},
		{in: `E:DCIM`, kind: Forbidden},
		{in: ``, kind: Invalid},
	}
	for _, c := range cases {
		got, err := g.Resolve(c.in, roots)
		if c.want == "" {
			if err == nil {
				t.Errorf("Resolve(%q) = %q, want rejection", c.in, got.Path)
			} else if KindOf(err) != c.kind {
				t.Errorf("Resolve(%q) kind = %v (%v), want %v", c.in, KindOf(err), err, c.kind)
			}
			continue
		}
		if err != nil {
			t.Errorf("Resolve(%q) unexpected error: %v", c.in, err)
			continue
		}
		if got.Path != c.want {
			t.Errorf("Resolve(%q) = %q, want %q", c.in, got.Path, c.want)
		}
	}

	// The junction itself may be named (so that it can be reported by stat),
	// but nothing may be reached through it.
	if r, err := g.Resolve(`E:\junction`, roots); err != nil || r.Path != `E:\junction` {
		t.Errorf("Resolve(junction) = %q, %v", r.Path, err)
	}
}

func TestResolveNoRoots(t *testing.T) {
	g := Guard{Flavor: Windows, FS: windowsFixture()}
	if _, err := g.Resolve(`E:\firmware.bin`, nil); KindOf(err) != Forbidden {
		t.Errorf("with no roots: %v, want Forbidden", err)
	}
}

func TestResolvedRootAndIsRoot(t *testing.T) {
	g := Guard{Flavor: Windows, FS: windowsFixture()}
	roots := []string{`E:\`, `E:\DCIM`}
	r, err := g.Resolve(`E:\DCIM\100RICOH`, roots)
	if err != nil {
		t.Fatal(err)
	}
	if r.Root != `E:\DCIM` || r.IsRoot {
		t.Errorf("root = %q isRoot = %v, want the most specific root E:\\DCIM", r.Root, r.IsRoot)
	}
	r, err = g.Resolve(`e:\dcim\`, roots)
	if err != nil {
		t.Fatal(err)
	}
	if !r.IsRoot || r.Lexical != `E:\dcim` {
		t.Errorf("got %+v, want root itself", r)
	}
}

// ---------------------------------------------------------------- real FS

func evalDir(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot create symlinks here: %v", err)
	}
}

func TestResolveRealFilesystem(t *testing.T) {
	base := evalDir(t)
	root := filepath.Join(base, "card")
	outside := filepath.Join(base, "outside")
	for _, d := range []string{filepath.Join(root, "DCIM"), outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(p string) {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(root, "DCIM", "a.jpg"))
	write(filepath.Join(outside, "secret.txt"))
	symlinkOrSkip(t, outside, filepath.Join(root, "out"))
	symlinkOrSkip(t, filepath.Join(outside, "secret.txt"), filepath.Join(root, "outfile"))
	symlinkOrSkip(t, filepath.Join(root, "DCIM"), filepath.Join(root, "in"))
	symlinkOrSkip(t, filepath.Join(outside, "does-not-exist"), filepath.Join(root, "dangling"))
	symlinkOrSkip(t, filepath.Join(root, "loop"), filepath.Join(root, "loop"))

	g := Guard{Flavor: Native(), FS: OS{}}
	roots := []string{root}
	j := filepath.Join

	ok := map[string]string{
		root:                         root,
		j(root, "DCIM", "a.jpg"):     j(root, "DCIM", "a.jpg"),
		j(root, "DCIM", "new.jpg"):   j(root, "DCIM", "new.jpg"),
		j(root, "x", "y", "z.bin"):   j(root, "x", "y", "z.bin"),
		j(root, "in", "a.jpg"):       j(root, "DCIM", "a.jpg"),
		j(root, "in", "new", "b"):    j(root, "DCIM", "new", "b"),
		root + "/DCIM/../DCIM/a.jpg": j(root, "DCIM", "a.jpg"),
	}
	for in, want := range ok {
		got, err := g.Resolve(in, roots)
		if err != nil {
			t.Errorf("Resolve(%q): %v", in, err)
		} else if got.Path != want {
			t.Errorf("Resolve(%q) = %q, want %q", in, got.Path, want)
		}
	}

	forbidden := []string{
		outside,
		j(outside, "secret.txt"),
		base,
		root + "x",
		root + "/../outside/secret.txt",
		root + "/DCIM/../../outside/secret.txt",
		j(root, "out"),
		j(root, "out", "secret.txt"),
		j(root, "out", "new.txt"),
		j(root, "outfile"),
		j(root, "dangling"),
		j(root, "dangling", "x"),
	}
	for _, in := range forbidden {
		if got, err := g.Resolve(in, roots); KindOf(err) != Forbidden {
			t.Errorf("Resolve(%q) = %q, %v; want Forbidden", in, got.Path, err)
		}
	}

	if _, err := g.Resolve(j(root, "DCIM", "a.jpg", "under-a-file"), roots); KindOf(err) != Invalid {
		t.Errorf("path below a file: %v, want Invalid", err)
	}
	if _, err := g.Resolve(j(root, "loop"), roots); err == nil {
		t.Error("a symlink loop must not resolve")
	}
}

// A root that is itself reached through a symlink still works, and paths
// are reported relative to its real location.
func TestResolveSymlinkedRoot(t *testing.T) {
	base := evalDir(t)
	realRoot := filepath.Join(base, "real")
	if err := os.MkdirAll(filepath.Join(realRoot, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(base, "alias")
	symlinkOrSkip(t, realRoot, alias)

	g := Guard{Flavor: Native(), FS: OS{}}
	r, err := g.Resolve(filepath.Join(alias, "sub", "f.bin"), []string{alias})
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(realRoot, "sub", "f.bin"); r.Path != want || r.Root != realRoot {
		t.Errorf("got %+v, want path %q under %q", r, want, realRoot)
	}
	// The real spelling is not an allowed root by itself.
	if _, err := g.Resolve(filepath.Join(realRoot, "sub"), []string{alias}); KindOf(err) != Forbidden {
		t.Errorf("real spelling: %v, want Forbidden", err)
	}
}

func TestResolveMissingRoot(t *testing.T) {
	base := evalDir(t)
	g := Guard{Flavor: Native(), FS: OS{}}
	gone := filepath.Join(base, "gone")
	if _, err := g.Resolve(filepath.Join(gone, "x"), []string{gone}); KindOf(err) != Forbidden {
		t.Errorf("missing root: %v, want Forbidden", err)
	}
}
