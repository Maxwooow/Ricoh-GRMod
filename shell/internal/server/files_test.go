package server

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"grmod/shell/internal/platform"
)

type writeResponse struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func noTempFiles(t *testing.T, root string) {
	t.Helper()
	for _, name := range tree(t, root) {
		if strings.Contains(filepath.Base(name), ".grmod-") || strings.HasSuffix(name, ".tmp") {
			t.Errorf("temporary file left behind: %s", name)
		}
	}
}

func TestPing(t *testing.T) {
	e := newEnv(t)
	rec := e.do("GET", "/api/ping", nil)
	wantStatus(t, rec, 200, "")
	if got := strings.TrimSpace(rec.Body.String()); got != `{"ok":true,"version":"1.2.3-test"}` {
		t.Errorf("ping body = %s", got)
	}
}

func TestVolumes(t *testing.T) {
	e := newEnv(t)
	type resp struct {
		Volumes []platform.Volume `json:"volumes"`
	}
	rec := e.do("GET", "/api/volumes", nil)
	wantStatus(t, rec, 200, "")
	got := decode[resp](t, rec)
	if len(got.Volumes) != 1 || got.Volumes[0].ID != "card" || !got.Volumes[0].Removable {
		t.Fatalf("default listing = %+v", got.Volumes)
	}
	v := got.Volumes[0]
	if v.Root != e.card || v.Label != "GR_CARD" || v.FS != "FAT32" || v.Total != 1000 || v.Free != 500 || v.Bus != "SD" {
		t.Errorf("volume fields = %+v", v)
	}
	for _, key := range []string{`"id"`, `"root"`, `"label"`, `"fs"`, `"total"`, `"free"`, `"removable"`, `"bus"`} {
		if !strings.Contains(rec.Body.String(), key) {
			t.Errorf("volume JSON lacks %s: %s", key, rec.Body.String())
		}
	}

	got = decode[resp](t, e.do("GET", "/api/volumes?all=1", nil))
	if len(got.Volumes) != 2 || got.Volumes[1].ID != "disk" || got.Volumes[1].Removable {
		t.Fatalf("all=1 listing = %+v", got.Volumes)
	}
	got = decode[resp](t, e.do("GET", "/api/volumes?all=0", nil))
	if len(got.Volumes) != 1 {
		t.Fatalf("all=0 listing = %+v", got.Volumes)
	}
	wantStatus(t, e.do("GET", "/api/volumes?all=maybe", nil), 400, "invalid")

	// No volumes: an empty array, not null.
	e.host.mu.Lock()
	e.host.removable = nil
	e.host.mu.Unlock()
	if body := strings.TrimSpace(e.do("GET", "/api/volumes", nil).Body.String()); body != `{"volumes":[]}` {
		t.Errorf("empty listing = %s", body)
	}
}

// Volumes that contain the data directory or an operating-system location
// are never listed and never become allowed roots, whatever the host says.
func TestProtectedVolumesAreFiltered(t *testing.T) {
	var e *env
	e = newEnv(t, func(o *Options) {
		h := o.Host.(*fakeHost)
		base := filepath.Dir(o.DataDir)
		sys := filepath.Join(base, "system")
		if err := os.MkdirAll(filepath.Join(sys, "Windows"), 0o755); err != nil {
			t.Fatal(err)
		}
		h.protected = []string{filepath.Join(sys, "Windows")}
		h.removable = append(h.removable,
			platform.Volume{ID: "sys", Root: sys, Removable: true},
			platform.Volume{ID: "datavol", Root: base, Removable: true},       // contains the data dir
			platform.Volume{ID: "dataitself", Root: o.DataDir},                // is the data dir
			platform.Volume{ID: "bogus", Root: "not/absolute"},                // unusable root
			platform.Volume{ID: "gone", Root: filepath.Join(base, "nowhere")}, // does not exist: harmless
		)
	})
	type resp struct {
		Volumes []platform.Volume `json:"volumes"`
	}
	got := decode[resp](t, e.do("GET", "/api/volumes?all=1", nil))
	var ids []string
	for _, v := range got.Volumes {
		ids = append(ids, v.ID)
	}
	if strings.Join(ids, ",") != "card,gone,disk" {
		t.Errorf("listed volumes = %v, want card, gone and disk only", ids)
	}
	for _, p := range []string{
		filepath.Join(e.base, "system", "Windows"),
		filepath.Join(e.base, "system"),
		e.data,
		e.base,
		e.outside,
	} {
		wantStatus(t, e.do("GET", q("/api/list", "path", p), nil), 403, "forbidden")
	}
	wantStatus(t, e.do("PUT", q("/api/write", "path", filepath.Join(e.data, "log.txt")), "x"), 403, "forbidden")
	wantStatus(t, e.do("PUT", q("/api/write", "path", filepath.Join(e.base, "system", "evil.dll")), "x"), 403, "forbidden")
}

func TestListAndStat(t *testing.T) {
	e := newEnv(t)
	dir := filepath.Join(e.card, "DCIM")
	e.writeFile(filepath.Join(dir, "b.jpg"), "bbbb")
	e.writeFile(filepath.Join(dir, "a.jpg"), "a")
	e.writeFile(filepath.Join(dir, "Z.JPG"), "zz")
	e.writeFile(filepath.Join(dir, "sub", "inner.txt"), "x")
	mtime := time.Unix(1700000000, 0)
	if err := os.Chtimes(filepath.Join(dir, "a.jpg"), mtime, mtime); err != nil {
		t.Fatal(err)
	}

	type resp struct {
		Entries []listEntry `json:"entries"`
	}
	rec := e.do("GET", q("/api/list", "path", dir), nil)
	wantStatus(t, rec, 200, "")
	got := decode[resp](t, rec).Entries
	want := []listEntry{
		{Name: "Z.JPG", Size: 2},
		{Name: "a.jpg", Size: 1, Mtime: 1700000000},
		{Name: "b.jpg", Size: 4},
		{Name: "sub", Dir: true},
	}
	if len(got) != len(want) {
		t.Fatalf("entries = %+v", got)
	}
	for i := range want {
		if got[i].Name != want[i].Name || got[i].Dir != want[i].Dir || got[i].Size != want[i].Size {
			t.Errorf("entry %d = %+v, want %+v", i, got[i], want[i])
		}
		if got[i].Mtime <= 0 {
			t.Errorf("entry %d has no mtime", i)
		}
	}
	if got[1].Mtime != 1700000000 {
		t.Errorf("mtime = %d", got[1].Mtime)
	}
	if !strings.Contains(rec.Body.String(), `{"name":"a.jpg","dir":false,"size":1,"mtime":1700000000}`) {
		t.Errorf("entry JSON shape: %s", rec.Body.String())
	}

	// Empty directory: empty array.
	empty := filepath.Join(e.card, "empty")
	os.Mkdir(empty, 0o755)
	if body := strings.TrimSpace(e.do("GET", q("/api/list", "path", empty), nil).Body.String()); body != `{"entries":[]}` {
		t.Errorf("empty dir listing = %s", body)
	}
	wantStatus(t, e.do("GET", q("/api/list", "path", filepath.Join(e.card, "nope")), nil), 404, "not-found")
	wantStatus(t, e.do("GET", q("/api/list", "path", filepath.Join(dir, "a.jpg")), nil), 400, "invalid")
	wantStatus(t, e.do("GET", "/api/list", nil), 400, "invalid")
	wantStatus(t, e.do("GET", "/api/list?path=", nil), 400, "invalid")

	stat := func(p string) string {
		rec := e.do("POST", "/api/stat", map[string]string{"path": p})
		wantStatus(t, rec, 200, "")
		return strings.TrimSpace(rec.Body.String())
	}
	if got := stat(filepath.Join(dir, "b.jpg")); got != `{"exists":true,"dir":false,"size":4}` {
		t.Errorf("stat file = %s", got)
	}
	if got := stat(dir); got != `{"exists":true,"dir":true,"size":0}` {
		t.Errorf("stat dir = %s", got)
	}
	if got := stat(e.card); got != `{"exists":true,"dir":true,"size":0}` {
		t.Errorf("stat root = %s", got)
	}
	if got := stat(filepath.Join(dir, "missing", "deep.bin")); got != `{"exists":false,"dir":false,"size":0}` {
		t.Errorf("stat missing = %s", got)
	}
	wantStatus(t, e.do("POST", "/api/stat", `{"path":""}`), 400, "invalid")
	wantStatus(t, e.do("POST", "/api/stat", `{}`), 400, "invalid")
	wantStatus(t, e.do("POST", "/api/stat", ``), 400, "invalid")
	wantStatus(t, e.do("POST", "/api/stat", `{"path":`), 400, "invalid")
	wantStatus(t, e.do("POST", "/api/stat", `[1,2]`), 400, "invalid")
}

func TestWriteReadBackHash(t *testing.T) {
	e := newEnv(t)
	payload := make([]byte, 300_000)
	for i := range payload {
		payload[i] = byte(i*7 + i>>8)
	}
	dest := filepath.Join(e.card, "firmware", "deep", "fw.bin")

	rec := e.do("PUT", q("/api/write", "path", dest), payload)
	wantStatus(t, rec, 200, "")
	got := decode[writeResponse](t, rec)
	if got.Size != int64(len(payload)) || got.SHA256 != sha(payload) {
		t.Errorf("write response = %+v, want size %d sha %s", got, len(payload), sha(payload))
	}
	if !bytes.Equal([]byte(e.readFile(dest)), payload) {
		t.Error("file content differs")
	}
	noTempFiles(t, e.card)

	rec = e.do("GET", q("/api/read", "path", dest), nil)
	wantStatus(t, rec, 200, "")
	if !bytes.Equal(rec.Body.Bytes(), payload) {
		t.Error("read returned different bytes")
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("read Content-Type = %q", ct)
	}
	if cl := rec.Header().Get("Content-Length"); cl != "300000" {
		t.Errorf("read Content-Length = %q", cl)
	}

	// Overwrite (the default) replaces the content; chunked uploads work.
	rec = e.do("PUT", q("/api/write", "path", dest), "short", chunked)
	wantStatus(t, rec, 200, "")
	if got := decode[writeResponse](t, rec); got.Size != 5 || got.SHA256 != sha([]byte("short")) {
		t.Errorf("overwrite response = %+v", got)
	}
	if e.readFile(dest) != "short" {
		t.Error("overwrite did not replace the file")
	}

	// Empty files are fine.
	empty := filepath.Join(e.card, "empty.bin")
	rec = e.do("PUT", q("/api/write", "path", empty), nil)
	wantStatus(t, rec, 200, "")
	if got := decode[writeResponse](t, rec); got.Size != 0 || got.SHA256 != sha(nil) {
		t.Errorf("empty write response = %+v", got)
	}
	noTempFiles(t, e.card)
}

func TestWriteOverwriteZero(t *testing.T) {
	e := newEnv(t)
	dest := filepath.Join(e.card, "a.bin")

	wantStatus(t, e.do("PUT", q("/api/write", "path", dest, "overwrite", "0"), "first"), 200, "")
	wantStatus(t, e.do("PUT", q("/api/write", "path", dest, "overwrite", "0"), "second"), 409, "exists")
	if e.readFile(dest) != "first" {
		t.Error("overwrite=0 replaced the file")
	}
	wantStatus(t, e.do("PUT", q("/api/write", "path", dest, "overwrite", "1"), "third"), 200, "")
	if e.readFile(dest) != "third" {
		t.Error("overwrite=1 did not replace the file")
	}
	wantStatus(t, e.do("PUT", q("/api/write", "path", dest, "overwrite", "perhaps"), "x"), 400, "invalid")
	noTempFiles(t, e.card)

	// Two simultaneous overwrite=0 writes of the same new file: exactly one wins.
	race := filepath.Join(e.card, "race.bin")
	var wg sync.WaitGroup
	codes := make([]int, 8)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = e.do("PUT", q("/api/write", "path", race, "overwrite", "0"), strings.Repeat("x", 1000+i)).Code
		}(i)
	}
	wg.Wait()
	wins := 0
	for _, c := range codes {
		switch c {
		case 200:
			wins++
		case 409:
		default:
			t.Errorf("unexpected status %d in overwrite race", c)
		}
	}
	if wins != 1 {
		t.Errorf("%d writers won the overwrite=0 race, want exactly 1", wins)
	}
	noTempFiles(t, e.card)
}

func TestWriteRejectsBadDestinations(t *testing.T) {
	e := newEnv(t)
	dir := filepath.Join(e.card, "DCIM")
	os.Mkdir(dir, 0o755)
	e.writeFile(filepath.Join(e.card, "file.txt"), "x")

	wantStatus(t, e.do("PUT", q("/api/write", "path", dir), "x"), 400, "invalid")                                    // a directory
	wantStatus(t, e.do("PUT", q("/api/write", "path", e.card), "x"), 400, "invalid")                                 // the root
	wantStatus(t, e.do("PUT", q("/api/write", "path", filepath.Join(e.card, "file.txt", "x")), "x"), 400, "invalid") // below a file
	wantStatus(t, e.do("PUT", "/api/write", "x"), 400, "invalid")                                                    // no path
	if !exists(dir) || e.readFile(filepath.Join(e.card, "file.txt")) != "x" {
		t.Error("a refused write changed something")
	}
	noTempFiles(t, e.card)
}

// failAfter yields n bytes and then fails, like a connection that drops.
type failAfter struct {
	n   int
	err error
}

func (f *failAfter) Read(p []byte) (int, error) {
	if f.n <= 0 {
		return 0, f.err
	}
	if len(p) > f.n {
		p = p[:f.n]
	}
	for i := range p {
		p[i] = 'x'
	}
	f.n -= len(p)
	return len(p), nil
}

func TestAtomicWriteLeavesNoTempFileOnFailure(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.MaxBytes = 64 << 10 })
	dest := filepath.Join(e.card, "dir", "target.bin")
	e.writeFile(dest, "original")

	t.Run("rename fails", func(t *testing.T) {
		var tmpSeen string
		e.srv.rename = func(oldpath, newpath string) error {
			tmpSeen = oldpath
			if !exists(oldpath) {
				t.Error("temp file does not exist at rename time")
			}
			if filepath.Dir(oldpath) != filepath.Dir(newpath) {
				t.Errorf("temp file %s is not next to its destination %s", oldpath, newpath)
			}
			return errors.New("simulated rename failure")
		}
		defer func() { e.srv.rename = renameFile }()
		wantStatus(t, e.do("PUT", q("/api/write", "path", dest), "new content"), 500, "io")
		if tmpSeen == "" {
			t.Fatal("rename hook was not reached")
		}
		if exists(tmpSeen) {
			t.Errorf("temp file %s survived a failed rename", tmpSeen)
		}
	})
	t.Run("upload breaks off", func(t *testing.T) {
		body := &failAfter{n: 10_000, err: io.ErrUnexpectedEOF}
		wantStatus(t, e.do("PUT", q("/api/write", "path", dest), body, chunked), 499, "cancelled")
	})
	t.Run("upload exceeds limit while streaming", func(t *testing.T) {
		body := &failAfter{n: 200 << 10, err: io.EOF}
		wantStatus(t, e.do("PUT", q("/api/write", "path", dest), io.Reader(body), chunked), 413, "too-large")
	})
	t.Run("new file in new directory", func(t *testing.T) {
		fresh := filepath.Join(e.card, "fresh", "f.bin")
		body := &failAfter{n: 5_000, err: io.ErrUnexpectedEOF}
		wantStatus(t, e.do("PUT", q("/api/write", "path", fresh), body, chunked), 499, "cancelled")
		if exists(fresh) {
			t.Error("a broken upload created the destination")
		}
	})

	if e.readFile(dest) != "original" {
		t.Errorf("destination was changed by a failed write: %q", e.readFile(dest))
	}
	noTempFiles(t, e.card)
	for _, name := range tree(t, e.card) {
		switch name {
		case "dir", "dir/target.bin", "fresh":
		default:
			t.Errorf("unexpected leftover: %s", name)
		}
	}
}

func TestSizeLimits(t *testing.T) {
	const limit = 4096
	e := newEnv(t, func(o *Options) { o.MaxBytes = limit })
	dest := filepath.Join(e.card, "f.bin")
	exact := strings.Repeat("a", limit)
	over := strings.Repeat("a", limit+1)

	// write
	wantStatus(t, e.do("PUT", q("/api/write", "path", dest), exact), 200, "")
	wantStatus(t, e.do("PUT", q("/api/write", "path", dest), over), 413, "too-large")
	wantStatus(t, e.do("PUT", q("/api/write", "path", dest), over, chunked), 413, "too-large")
	// A lying Content-Length does not get more through either.
	wantStatus(t, e.do("PUT", q("/api/write", "path", dest), over, withContentLength(10)), 413, "too-large")
	if e.readFile(dest) != exact {
		t.Error("an oversized write replaced the file")
	}
	noTempFiles(t, e.card)

	// read
	wantStatus(t, e.do("GET", q("/api/read", "path", dest), nil), 200, "")
	big := filepath.Join(e.card, "big.bin")
	e.writeFile(big, over)
	wantStatus(t, e.do("GET", q("/api/read", "path", big), nil), 413, "too-large")

	// store
	wantStatus(t, e.do("PUT", "/api/store/k", exact), 200, "")
	wantStatus(t, e.do("PUT", "/api/store/k", over), 413, "too-large")
	wantStatus(t, e.do("PUT", "/api/store/k", over, chunked), 413, "too-large")
	if rec := e.do("GET", "/api/store/k", nil); rec.Body.String() != exact {
		t.Error("an oversized store value replaced the old one")
	}
	noTempFiles(t, e.data)

	// JSON bodies have their own (fixed) limit.
	huge := `{"path":"` + strings.Repeat("a", maxJSONBody) + `"}`
	wantStatus(t, e.do("POST", "/api/stat", huge), 413, "too-large")
}

func TestDefaultLimitIs256MiB(t *testing.T) {
	e := newEnv(t)
	if e.srv.opt.MaxBytes != 256<<20 {
		t.Errorf("default limit = %d", e.srv.opt.MaxBytes)
	}
	// Refused from the Content-Length alone, before any byte is read.
	rec := e.do("PUT", q("/api/write", "path", filepath.Join(e.card, "x")), "tiny", withContentLength(256<<20+1))
	wantStatus(t, rec, 413, "too-large")
	wantStatus(t, e.do("PUT", "/api/store/x", "tiny", withContentLength(256<<20+1)), 413, "too-large")
	noTempFiles(t, e.card)
}

func TestReadErrors(t *testing.T) {
	e := newEnv(t)
	os.Mkdir(filepath.Join(e.card, "dir"), 0o755)
	wantStatus(t, e.do("GET", q("/api/read", "path", filepath.Join(e.card, "nope.bin")), nil), 404, "not-found")
	wantStatus(t, e.do("GET", q("/api/read", "path", filepath.Join(e.card, "dir")), nil), 400, "invalid")
	wantStatus(t, e.do("GET", q("/api/read", "path", e.card), nil), 400, "invalid")
	wantStatus(t, e.do("GET", "/api/read", nil), 400, "invalid")
}

func TestMove(t *testing.T) {
	e := newEnv(t)
	j := filepath.Join
	move := func(from, to string) int {
		return e.do("POST", "/api/move", map[string]string{"from": from, "to": to}).Code
	}

	// Plain rename.
	e.writeFile(j(e.card, "a.txt"), "A")
	rec := e.do("POST", "/api/move", map[string]string{"from": j(e.card, "a.txt"), "to": j(e.card, "b.txt")})
	wantStatus(t, rec, 200, "")
	if strings.TrimSpace(rec.Body.String()) != `{"ok":true}` {
		t.Errorf("move body = %s", rec.Body.String())
	}
	if exists(j(e.card, "a.txt")) || e.readFile(j(e.card, "b.txt")) != "A" {
		t.Error("rename did not happen")
	}

	// Destination parents are created.
	if code := move(j(e.card, "b.txt"), j(e.card, "x", "y", "z", "c.txt")); code != 200 {
		t.Fatalf("move into new directories: %d", code)
	}
	if e.readFile(j(e.card, "x", "y", "z", "c.txt")) != "A" {
		t.Error("file did not arrive in the new directories")
	}

	// Directories move with their content.
	if code := move(j(e.card, "x", "y"), j(e.card, "moved")); code != 200 {
		t.Fatalf("move directory: %d", code)
	}
	if e.readFile(j(e.card, "moved", "z", "c.txt")) != "A" || exists(j(e.card, "x", "y")) {
		t.Error("directory move incomplete")
	}

	// Existing destination: 409, both files untouched.
	e.writeFile(j(e.card, "src.txt"), "SRC")
	e.writeFile(j(e.card, "dst.txt"), "DST")
	wantStatus(t, e.do("POST", "/api/move", map[string]string{"from": j(e.card, "src.txt"), "to": j(e.card, "dst.txt")}), 409, "exists")
	if e.readFile(j(e.card, "src.txt")) != "SRC" || e.readFile(j(e.card, "dst.txt")) != "DST" {
		t.Error("a refused move changed files")
	}
	// ... also when the destination is a directory, and for a move onto itself.
	wantStatus(t, e.do("POST", "/api/move", map[string]string{"from": j(e.card, "src.txt"), "to": j(e.card, "moved")}), 409, "exists")
	wantStatus(t, e.do("POST", "/api/move", map[string]string{"from": j(e.card, "src.txt"), "to": j(e.card, "src.txt")}), 409, "exists")

	// Missing source: 404, and no destination directories appear.
	wantStatus(t, e.do("POST", "/api/move", map[string]string{"from": j(e.card, "ghost.txt"), "to": j(e.card, "newdir", "g.txt")}), 404, "not-found")
	if exists(j(e.card, "newdir")) {
		t.Error("destination directory created for a missing source")
	}

	// A directory cannot be moved into itself.
	wantStatus(t, e.do("POST", "/api/move", map[string]string{"from": j(e.card, "moved"), "to": j(e.card, "moved", "z", "inner")}), 400, "invalid")

	// Roots cannot be moved or be a destination.
	wantStatus(t, e.do("POST", "/api/move", map[string]string{"from": e.card, "to": j(e.card, "self")}), 400, "invalid")

	// Missing fields.
	wantStatus(t, e.do("POST", "/api/move", map[string]string{"from": j(e.card, "src.txt")}), 400, "invalid")
	wantStatus(t, e.do("POST", "/api/move", map[string]string{"to": j(e.card, "t")}), 400, "invalid")
	wantStatus(t, e.do("POST", "/api/move", `not json`), 400, "invalid")

	// A file standing where a destination directory is needed.
	wantStatus(t, e.do("POST", "/api/move", map[string]string{"from": j(e.card, "src.txt"), "to": j(e.card, "dst.txt", "below")}), 400, "invalid")

	// Between two allowed roots on the same filesystem it is still a rename.
	if code := move(j(e.card, "src.txt"), j(e.disk, "from-card.txt")); code != 200 {
		t.Errorf("move between allowed roots: %d", code)
	}
	noTempFiles(t, e.card)
}

func TestMoveReportsCrossVolume(t *testing.T) {
	e := newEnv(t)
	e.writeFile(filepath.Join(e.card, "a.txt"), "A")
	e.srv.rename = func(oldpath, newpath string) error {
		return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: crossDeviceErrno}
	}
	wantStatus(t, e.do("POST", "/api/move", map[string]string{"from": filepath.Join(e.card, "a.txt"), "to": filepath.Join(e.disk, "a.txt")}), 400, "invalid")
	if e.readFile(filepath.Join(e.card, "a.txt")) != "A" {
		t.Error("source changed")
	}
}

func TestMoveRefusesSymlinks(t *testing.T) {
	e := newEnv(t)
	e.writeFile(filepath.Join(e.card, "real.txt"), "R")
	link := filepath.Join(e.card, "link.txt")
	symlinkOrSkip(t, filepath.Join(e.card, "real.txt"), link)
	wantStatus(t, e.do("POST", "/api/move", map[string]string{"from": link, "to": filepath.Join(e.card, "elsewhere.txt")}), 403, "forbidden")
	if !exists(link) || e.readFile(filepath.Join(e.card, "real.txt")) != "R" || exists(filepath.Join(e.card, "elsewhere.txt")) {
		t.Error("a refused symlink move changed something")
	}
}

func TestMkdir(t *testing.T) {
	e := newEnv(t)
	dir := filepath.Join(e.card, "a", "b", "c")
	rec := e.do("POST", "/api/mkdir", map[string]string{"path": dir})
	wantStatus(t, rec, 200, "")
	if strings.TrimSpace(rec.Body.String()) != `{"ok":true}` {
		t.Errorf("mkdir body = %s", rec.Body.String())
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		t.Fatal("directory was not created")
	}
	wantStatus(t, e.do("POST", "/api/mkdir", map[string]string{"path": dir}), 200, "")    // already there
	wantStatus(t, e.do("POST", "/api/mkdir", map[string]string{"path": e.card}), 200, "") // the root itself
	e.writeFile(filepath.Join(e.card, "file"), "x")
	wantStatus(t, e.do("POST", "/api/mkdir", map[string]string{"path": filepath.Join(e.card, "file")}), 409, "exists")
	wantStatus(t, e.do("POST", "/api/mkdir", map[string]string{"path": filepath.Join(e.card, "file", "sub")}), 400, "invalid")
	wantStatus(t, e.do("POST", "/api/mkdir", map[string]string{}), 400, "invalid")
	if e.readFile(filepath.Join(e.card, "file")) != "x" {
		t.Error("file was replaced by mkdir")
	}
}

func TestPickDirectory(t *testing.T) {
	e := newEnv(t)
	picked := filepath.Join(e.outside, "presets")
	e.writeFile(filepath.Join(picked, "a.xmp"), "xmp")
	file := filepath.Join(picked, "a.xmp")

	// Before picking, the folder is off limits.
	wantStatus(t, e.do("GET", q("/api/read", "path", file), nil), 403, "forbidden")

	// Cancelled dialog: empty path, nothing becomes allowed.
	rec := e.do("POST", "/api/pick-directory", map[string]string{"title": "Choose the preset folder"})
	wantStatus(t, rec, 200, "")
	if strings.TrimSpace(rec.Body.String()) != `{"path":""}` {
		t.Errorf("cancel body = %s", rec.Body.String())
	}
	if e.host.pickTitle != "Choose the preset folder" {
		t.Errorf("title passed to the dialog = %q", e.host.pickTitle)
	}
	wantStatus(t, e.do("GET", q("/api/read", "path", file), nil), 403, "forbidden")

	// A picked folder becomes an allowed root for this run (body optional).
	e.host.mu.Lock()
	e.host.pick = picked + string(filepath.Separator)
	e.host.mu.Unlock()
	rec = e.do("POST", "/api/pick-directory", nil)
	wantStatus(t, rec, 200, "")
	if got := decode[pathRequest](t, rec).Path; got != picked {
		t.Errorf("picked path = %q, want %q", got, picked)
	}
	rec = e.do("GET", q("/api/read", "path", file), nil)
	if rec.Code != 200 || rec.Body.String() != "xmp" {
		t.Errorf("read in picked folder: %d %q", rec.Code, rec.Body.String())
	}
	wantStatus(t, e.do("PUT", q("/api/write", "path", filepath.Join(picked, "new", "b.xmp")), "b"), 200, "")
	wantStatus(t, e.do("GET", q("/api/list", "path", picked), nil), 200, "")
	// ... but only that folder, not its parent or siblings.
	wantStatus(t, e.do("GET", q("/api/list", "path", e.outside), nil), 403, "forbidden")
	wantStatus(t, e.do("GET", q("/api/read", "path", picked+"/../other.txt"), nil), 403, "forbidden")
	// Picked folders are not volumes.
	if strings.Contains(e.do("GET", "/api/volumes?all=1", nil).Body.String(), "presets") {
		t.Error("picked folder shows up as a volume")
	}

	// A dialog failure is an error, and picks survive it.
	e.host.mu.Lock()
	e.host.pick, e.host.pickErr = "", errors.New("COM exploded")
	e.host.mu.Unlock()
	wantStatus(t, e.do("POST", "/api/pick-directory", `{}`), 500, "io")
	wantStatus(t, e.do("GET", q("/api/read", "path", file), nil), 200, "")

	// A location that cannot be expressed as a local path is refused.
	e.host.mu.Lock()
	e.host.pick, e.host.pickErr = "relative/dir", nil
	e.host.mu.Unlock()
	wantStatus(t, e.do("POST", "/api/pick-directory", `{}`), 400, "invalid")
	wantStatus(t, e.do("POST", "/api/pick-directory", `{"title":`), 400, "invalid")
}

// Even the user cannot be asked twice at the same time.
func TestPickDirectoryOneDialogAtATime(t *testing.T) {
	e := newEnv(t)
	e.srv.picking.Lock()
	wantStatus(t, e.do("POST", "/api/pick-directory", `{}`), 409, "invalid")
	e.srv.picking.Unlock()
	wantStatus(t, e.do("POST", "/api/pick-directory", `{}`), 200, "")
}

func TestReveal(t *testing.T) {
	e := newEnv(t)
	file := filepath.Join(e.card, "DCIM", "a.jpg")
	e.writeFile(file, "x")
	wantStatus(t, e.do("POST", "/api/reveal", map[string]string{"path": file}), 200, "")
	wantStatus(t, e.do("POST", "/api/reveal", map[string]string{"path": filepath.Dir(file)}), 200, "")
	wantStatus(t, e.do("POST", "/api/reveal", map[string]string{"path": e.card}), 200, "")
	want := []string{"file:" + file, "dir:" + filepath.Dir(file), "dir:" + e.card}
	if strings.Join(e.host.revealed, "|") != strings.Join(want, "|") {
		t.Errorf("revealed = %v, want %v", e.host.revealed, want)
	}
	wantStatus(t, e.do("POST", "/api/reveal", map[string]string{"path": filepath.Join(e.card, "nope")}), 404, "not-found")
	wantStatus(t, e.do("POST", "/api/reveal", map[string]string{"path": e.outside}), 403, "forbidden")
	if len(e.host.revealed) != 3 {
		t.Errorf("reveal reached the host for a bad path: %v", e.host.revealed)
	}
}

func TestEject(t *testing.T) {
	e := newEnv(t)
	wantStatus(t, e.do("POST", "/api/eject", map[string]string{"id": "card"}), 200, "")
	wantStatus(t, e.do("POST", "/api/eject", map[string]string{"id": "CARD"}), 200, "")
	if strings.Join(e.host.ejected, ",") != "card,card" {
		t.Errorf("ejected = %v", e.host.ejected)
	}
	// Fixed drives and unknown ids can never be ejected.
	wantStatus(t, e.do("POST", "/api/eject", map[string]string{"id": "disk"}), 404, "not-found")
	wantStatus(t, e.do("POST", "/api/eject", map[string]string{"id": "C:"}), 404, "not-found")
	wantStatus(t, e.do("POST", "/api/eject", map[string]string{}), 400, "invalid")
	if len(e.host.ejected) != 2 {
		t.Errorf("eject reached the host for a bad id: %v", e.host.ejected)
	}

	e.host.ejectErr = errors.New("volume is in use")
	wantStatus(t, e.do("POST", "/api/eject", map[string]string{"id": "card"}), 500, "io")
	e.host.ejectErr = platform.ErrUnsupported
	wantStatus(t, e.do("POST", "/api/eject", map[string]string{"id": "card"}), 501, "invalid")
}
