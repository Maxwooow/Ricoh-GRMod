package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

func writeFiles(t *testing.T, base string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		full := filepath.Join(base, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func fileTree(t *testing.T, base string) []string {
	t.Helper()
	var out []string
	filepath.Walk(base, func(p string, fi os.FileInfo, err error) error {
		if err == nil && p != base {
			rel, _ := filepath.Rel(base, p)
			rel = filepath.ToSlash(rel)
			if fi.IsDir() {
				rel += "/"
			}
			out = append(out, rel)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

func decodeJSON[T any](t *testing.T, body string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("bad JSON %q: %v", body, err)
	}
	return v
}

type listReply struct {
	Dir     string        `json:"dir"`
	Entries []parkedEntry `json:"entries"`
}
type deleteReply struct {
	Deleted []string        `json:"deleted"`
	Failed  []parkedFailure `json:"failed"`
}
type backupReply struct {
	Saved  []backupResult  `json:"saved"`
	Failed []parkedFailure `json:"failed"`
}

func paths(es []parkedEntry) []string {
	out := []string{}
	for _, e := range es {
		out = append(out, e.Path)
	}
	return out
}

func TestParkedRel(t *testing.T) {
	good := []string{"parked-20261007-104625/fwdc248b.bin", "parked-20261007-104625-2/script/startup.ttl", "parked-s1/00078560.636", "parked-a_b/DEVELOP.MOD"}
	for _, p := range good {
		if _, ok := parkedRel(p); !ok {
			t.Errorf("%q should be accepted", p)
		}
	}
	bad := []string{"", "fwdc248b.bin", "parked-1", "parked-1/", "parked-1//x", "parked-1/../x", "parked-1/a/b/c", "../parked-1/x", "parked-1/..", "parked-1/.hidden", "parked-1/a..b",
		"parked-1/x.", "parked-/x", "Parked-1/x", "parked-1\\x", "parked-1/a b", "/parked-1/x", "parked-1/x/", "parked-1/CON", "parked-1/nul.txt", "parked-1/a/..", "GRMOD/parked-1/x", "parked-1/x\x00"}
	for _, p := range bad {
		if _, ok := parkedRel(p); ok {
			t.Errorf("%q should be refused", p)
		}
	}
}

func TestParkedListDeleteBackup(t *testing.T) {
	e := newEnv(t)
	writeFiles(t, e.card, map[string]string{
		"DCIM/100RICOH/R0000001.JPG":                      "photo",
		"fwdc248b.bin":                                    "current firmware",
		"GRMOD/parked-20261007-104625/fwdc248b.bin":       "firmware A",
		"GRMOD/parked-20261007-104625/00078560.636":       "entry",
		"GRMOD/parked-20261007-110000/script/startup.ttl": "script",
		"GRMOD/parked-20261007-110000/fwdc248b.bin":       "firmware B",
		"GRMOD/notes.txt":                                 "not ours",
		"GRMOD/other/fwdc248b.bin":                        "not in a parked folder",
		"GRMOD/parked-20261007-110000/we ird name":        "skipped",
	})
	rec := e.do("GET", q("/api/parked", "volume", "card"), nil)
	if rec.Code != 200 {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	got := paths(decodeJSON[listReply](t, rec.Body.String()).Entries)
	want := []string{"parked-20261007-104625/00078560.636", "parked-20261007-104625/fwdc248b.bin", "parked-20261007-110000/fwdc248b.bin", "parked-20261007-110000/script/startup.ttl"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("list = %v", got)
	}
	wantStatus(t, e.do("GET", q("/api/parked", "volume", "nope"), nil), 404, "not-found")
	wantStatus(t, e.do("GET", "/api/parked", nil), 400, "invalid")
	wantStatus(t, e.do("GET", q("/api/parked", "volume", "card"), nil, noToken), 403, "forbidden")

	// read one
	rec = e.do("GET", q("/api/parked/read", "volume", "card", "path", "parked-20261007-104625/fwdc248b.bin"), nil)
	if rec.Code != 200 || rec.Body.String() != "firmware A" {
		t.Fatalf("read: %d %q", rec.Code, rec.Body.String())
	}
	for _, p := range []string{"../../fwdc248b.bin", "parked-20261007-104625/../../fwdc248b.bin", "other/fwdc248b.bin", "notes.txt", "parked-20261007-104625/missing.bin"} {
		if c := e.do("GET", q("/api/parked/read", "volume", "card", "path", p), nil).Code; c != 400 && c != 404 {
			t.Errorf("read %q: status %d", p, c)
		}
	}

	// back up two files, twice: the second time nothing is copied again
	req := parkedRequest{Volume: "card", Paths: []string{"parked-20261007-104625/fwdc248b.bin", "parked-20261007-110000/script/startup.ttl", "parked-20261007-104625/nope.bin", "../../fwdc248b.bin"}}
	rep := decodeJSON[backupReply](t, e.do("POST", "/api/parked/backup", req).Body.String())
	if len(rep.Saved) != 2 || len(rep.Failed) != 2 || rep.Saved[0].Existed || rep.Saved[0].Dest != "parked-20261007-104625/fwdc248b.bin" {
		t.Fatalf("backup: %+v", rep)
	}
	backups := filepath.Join(e.data, "backups")
	if b, _ := os.ReadFile(filepath.Join(backups, "parked-20261007-104625", "fwdc248b.bin")); string(b) != "firmware A" {
		t.Fatalf("backup content %q", b)
	}
	rep = decodeJSON[backupReply](t, e.do("POST", "/api/parked/backup", req).Body.String())
	if len(rep.Saved) != 2 || !rep.Saved[0].Existed || !rep.Saved[1].Existed {
		t.Fatalf("second backup: %+v", rep)
	}
	// a different file under the same folder name (another card) is kept next to it
	if err := os.WriteFile(filepath.Join(e.card, "GRMOD", "parked-20261007-104625", "fwdc248b.bin"), []byte("firmware A, other card"), 0o644); err != nil {
		t.Fatal(err)
	}
	rep = decodeJSON[backupReply](t, e.do("POST", "/api/parked/backup", parkedRequest{Volume: "card", Paths: []string{"parked-20261007-104625/fwdc248b.bin"}}).Body.String())
	if len(rep.Saved) != 1 || rep.Saved[0].Dest != "parked-20261007-104625-2/fwdc248b.bin" || rep.Saved[0].Existed {
		t.Fatalf("backup of a different file: %+v", rep)
	}
	lst := decodeJSON[listReply](t, e.do("GET", "/api/backups", nil).Body.String())
	if lst.Dir != backups || strings.Join(paths(lst.Entries), "|") != "parked-20261007-104625-2/fwdc248b.bin|parked-20261007-104625/fwdc248b.bin|parked-20261007-110000/script/startup.ttl" {
		t.Fatalf("backups list: %+v", lst)
	}
	if rec := e.do("GET", q("/api/backups/read", "path", "parked-20261007-104625-2/fwdc248b.bin"), nil); rec.Code != 200 || rec.Body.String() != "firmware A, other card" {
		t.Fatalf("backup read: %d %q", rec.Code, rec.Body.String())
	}
	wantStatus(t, e.do("GET", q("/api/backups/read", "path", "../store/x"), nil), 400, "invalid")

	// reveal
	if rec := e.do("POST", "/api/backups/reveal", `{}`); rec.Code != 200 {
		t.Fatalf("reveal: %d %s", rec.Code, rec.Body.String())
	}
	if n := len(e.host.revealed); n == 0 || e.host.revealed[n-1] != "dir:"+backups {
		t.Fatalf("revealed %v", e.host.revealed)
	}

	// delete on the card: only what is named, only inside parked folders
	del := decodeJSON[deleteReply](t, e.do("POST", "/api/parked/delete", parkedRequest{Volume: "card", Paths: []string{
		"parked-20261007-104625/fwdc248b.bin", "parked-20261007-110000/script/startup.ttl", "../fwdc248b.bin", "notes.txt", "other/fwdc248b.bin", "parked-20261007-104625/../../fwdc248b.bin", "parked-20261007-110000/script"}}).Body.String())
	if strings.Join(del.Deleted, "|") != "parked-20261007-104625/fwdc248b.bin|parked-20261007-110000/script/startup.ttl" || len(del.Failed) != 5 {
		t.Fatalf("delete: %+v", del)
	}
	wantTree := []string{"DCIM/", "DCIM/100RICOH/", "DCIM/100RICOH/R0000001.JPG", "GRMOD/", "GRMOD/notes.txt", "GRMOD/other/", "GRMOD/other/fwdc248b.bin",
		"GRMOD/parked-20261007-104625/", "GRMOD/parked-20261007-104625/00078560.636", "GRMOD/parked-20261007-110000/", "GRMOD/parked-20261007-110000/fwdc248b.bin", "GRMOD/parked-20261007-110000/we ird name", "fwdc248b.bin"}
	if got := fileTree(t, e.card); strings.Join(got, "|") != strings.Join(wantTree, "|") {
		t.Fatalf("card after delete:\n%v\nwant\n%v", got, wantTree)
	}
	// deleting the last file of a folder removes the folder; GRMOD stays while something else is in it
	del = decodeJSON[deleteReply](t, e.do("POST", "/api/parked/delete", parkedRequest{Volume: "card", Paths: []string{"parked-20261007-104625/00078560.636"}}).Body.String())
	if len(del.Deleted) != 1 {
		t.Fatalf("delete: %+v", del)
	}
	if _, err := os.Stat(filepath.Join(e.card, "GRMOD", "parked-20261007-104625")); !os.IsNotExist(err) {
		t.Error("the empty parked folder was not removed")
	}
	if _, err := os.Stat(filepath.Join(e.card, "GRMOD", "notes.txt")); err != nil {
		t.Error("a foreign file in GRMOD was touched")
	}
	wantStatus(t, e.do("POST", "/api/parked/delete", parkedRequest{Volume: "card"}), 400, "invalid")
	wantStatus(t, e.do("POST", "/api/parked/delete", parkedRequest{Volume: "nope", Paths: []string{"parked-1/x"}}), 404, "not-found")
	wantStatus(t, e.do("POST", "/api/parked/delete", parkedRequest{Volume: "card", Paths: []string{"parked-1/x"}}, noToken), 403, "forbidden")
	wantStatus(t, e.do("GET", "/api/parked/delete", nil), 405, "invalid")

	// delete backups
	del = decodeJSON[deleteReply](t, e.do("POST", "/api/backups/delete", parkedRequest{Paths: []string{"parked-20261007-104625/fwdc248b.bin", "parked-20261007-110000/script/startup.ttl", "../store/x"}}).Body.String())
	if len(del.Deleted) != 2 || len(del.Failed) != 1 {
		t.Fatalf("delete backups: %+v", del)
	}
	if got := fileTree(t, backups); strings.Join(got, "|") != "parked-20261007-104625-2/|parked-20261007-104625-2/fwdc248b.bin" {
		t.Fatalf("backups after delete: %v", got)
	}
}

func TestParkedEmptyAndGRMODRemoval(t *testing.T) {
	e := newEnv(t)
	lst := decodeJSON[listReply](t, e.do("GET", q("/api/parked", "volume", "card"), nil).Body.String())
	if len(lst.Entries) != 0 {
		t.Fatalf("empty card lists %v", lst.Entries)
	}
	if lst := decodeJSON[listReply](t, e.do("GET", "/api/backups", nil).Body.String()); len(lst.Entries) != 0 {
		t.Fatalf("no backups yet, got %v", lst.Entries)
	}
	writeFiles(t, e.card, map[string]string{"GRMOD/parked-s1/fwdc248b.bin": "x"})
	del := decodeJSON[deleteReply](t, e.do("POST", "/api/parked/delete", parkedRequest{Volume: "card", Paths: []string{"parked-s1/fwdc248b.bin"}}).Body.String())
	if len(del.Deleted) != 1 {
		t.Fatalf("delete: %+v", del)
	}
	if got := fileTree(t, e.card); len(got) != 0 {
		t.Errorf("an emptied GRMOD folder should be gone, card has %v", got)
	}
}

func TestParkedLinksAreNotFollowed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs symbolic links")
	}
	e := newEnv(t)
	writeFiles(t, e.outside, map[string]string{"secret/fwdc248b.bin": "outside", "file.bin": "outside file"})
	writeFiles(t, e.card, map[string]string{"GRMOD/parked-real/keep.bin": "keep"})
	if err := os.Symlink(filepath.Join(e.outside, "secret"), filepath.Join(e.card, "GRMOD", "parked-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(e.outside, "file.bin"), filepath.Join(e.card, "GRMOD", "parked-real", "link.bin")); err != nil {
		t.Fatal(err)
	}
	got := paths(decodeJSON[listReply](t, e.do("GET", q("/api/parked", "volume", "card"), nil).Body.String()).Entries)
	if strings.Join(got, "|") != "parked-real/keep.bin" {
		t.Fatalf("list follows links: %v", got)
	}
	del := decodeJSON[deleteReply](t, e.do("POST", "/api/parked/delete", parkedRequest{Volume: "card", Paths: []string{"parked-link/fwdc248b.bin", "parked-real/link.bin"}}).Body.String())
	if len(del.Deleted) != 0 || len(del.Failed) != 2 {
		t.Fatalf("delete through links: %+v", del)
	}
	for _, p := range []string{filepath.Join(e.outside, "secret", "fwdc248b.bin"), filepath.Join(e.outside, "file.bin")} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s was deleted through a link", p)
		}
	}
	rep := decodeJSON[backupReply](t, e.do("POST", "/api/parked/backup", parkedRequest{Volume: "card", Paths: []string{"parked-link/fwdc248b.bin", "parked-real/link.bin"}}).Body.String())
	if len(rep.Saved) != 0 {
		t.Fatalf("backup through links: %+v", rep)
	}
	// GRMOD itself being a link disables everything
	os.RemoveAll(filepath.Join(e.card, "GRMOD"))
	if err := os.Symlink(e.outside, filepath.Join(e.card, "GRMOD")); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, e.outside, map[string]string{"parked-x/a.bin": "a"})
	if got := decodeJSON[listReply](t, e.do("GET", q("/api/parked", "volume", "card"), nil).Body.String()).Entries; len(got) != 0 {
		t.Fatalf("list through a linked GRMOD: %v", got)
	}
	del = decodeJSON[deleteReply](t, e.do("POST", "/api/parked/delete", parkedRequest{Volume: "card", Paths: []string{"parked-x/a.bin"}}).Body.String())
	if len(del.Deleted) != 0 {
		t.Fatalf("delete through a linked GRMOD: %+v", del)
	}
	if _, err := os.Stat(filepath.Join(e.outside, "parked-x", "a.bin")); err != nil {
		t.Error("file behind a linked GRMOD was deleted")
	}
}
