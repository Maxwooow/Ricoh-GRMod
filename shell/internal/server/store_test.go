package server

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoreKeyValidation(t *testing.T) {
	valid := []string{
		"a", "0", "settings", "settings.json", "preset-01", "a_b", "a.b-c_d", "9lives",
		"x" + strings.Repeat("y", 63), // 64 characters
		"null", "console", "com10", "a.nul", "nu",
	}
	invalid := []string{
		"", ".", "..", ".hidden", "-dash", "_under", "UPPER", "Mixed", "a b", "a/b", `a\b`, "a:b",
		"ä", "a\x00", "a%2fb", "a*", "a?", "a\n",
		"x" + strings.Repeat("y", 64), // 65 characters
		"a.", "a..",                   // would alias "a" on Windows
		"nul", "con", "prn", "aux", "com1", "lpt9", "nul.txt", "con.json", "com0", // Windows devices
		".grmod-123.tmp",
	}
	for _, k := range valid {
		if !ValidKey(k) {
			t.Errorf("ValidKey(%q) = false, want true", k)
		}
	}
	for _, k := range invalid {
		if ValidKey(k) {
			t.Errorf("ValidKey(%q) = true, want false", k)
		}
	}

	e := newEnv(t)
	for _, target := range []string{
		"/api/store/UPPER", "/api/store/.hidden", "/api/store/a/b", "/api/store/..", "/api/store/",
		"/api/store/a%2Fb", "/api/store/..%2F..%2Flog.txt", "/api/store/%2e%2e", "/api/store/nul",
		"/api/store/a.", "/api/store/a%20b", "/api/store/" + strings.Repeat("k", 65),
	} {
		for _, method := range []string{"GET", "PUT", "DELETE"} {
			wantStatus(t, e.do(method, target, "x"), 400, "invalid")
		}
	}
	if entries, _ := os.ReadDir(e.data); len(entries) != 0 {
		t.Errorf("invalid keys touched the data directory: %v", entries)
	}
}

func TestStoreRoundTrip(t *testing.T) {
	e := newEnv(t)

	// Empty store.
	if body := strings.TrimSpace(e.do("GET", "/api/store", nil).Body.String()); body != `{"keys":[]}` {
		t.Errorf("empty store listing = %s", body)
	}
	wantStatus(t, e.do("GET", "/api/store/settings.json", nil), 404, "not-found")
	wantStatus(t, e.do("DELETE", "/api/store/settings.json", nil), 200, "") // idempotent

	// Put, get.
	value := []byte("{\"theme\":\"dark\"}\x00\xff binary too")
	rec := e.do("PUT", "/api/store/settings.json", value)
	wantStatus(t, rec, 200, "")
	if strings.TrimSpace(rec.Body.String()) != `{"ok":true,"size":29}` {
		t.Errorf("put body = %s", rec.Body.String())
	}
	rec = e.do("GET", "/api/store/settings.json", nil)
	wantStatus(t, rec, 200, "")
	if !bytes.Equal(rec.Body.Bytes(), value) {
		t.Errorf("get returned %q", rec.Body.Bytes())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("get Content-Type = %q", ct)
	}
	// It lives exactly where documented.
	onDisk, err := os.ReadFile(filepath.Join(e.data, "store", "settings.json"))
	if err != nil || !bytes.Equal(onDisk, value) {
		t.Errorf("file in <data>/store: %v", err)
	}

	// Replace, add more, list sorted with sizes.
	wantStatus(t, e.do("PUT", "/api/store/settings.json", "v2", chunked), 200, "")
	wantStatus(t, e.do("PUT", "/api/store/b-key", "12345"), 200, "")
	wantStatus(t, e.do("PUT", "/api/store/a_key", ""), 200, "")
	if got := e.do("GET", "/api/store/settings.json", nil).Body.String(); got != "v2" {
		t.Errorf("after replace: %q", got)
	}
	want := `{"keys":[{"key":"a_key","size":0},{"key":"b-key","size":5},{"key":"settings.json","size":2}]}`
	if body := strings.TrimSpace(e.do("GET", "/api/store", nil).Body.String()); body != want {
		t.Errorf("listing = %s\nwant      %s", body, want)
	}

	// Strangers in the directory are not keys.
	os.WriteFile(filepath.Join(e.data, "store", ".grmod-1.tmp"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(e.data, "store", "NotAKey"), []byte("x"), 0o644)
	os.Mkdir(filepath.Join(e.data, "store", "adir"), 0o755)
	if body := strings.TrimSpace(e.do("GET", "/api/store", nil).Body.String()); body != want {
		t.Errorf("listing with strangers = %s", body)
	}
	wantStatus(t, e.do("GET", "/api/store/adir", nil), 404, "not-found")

	// Delete.
	wantStatus(t, e.do("DELETE", "/api/store/b-key", nil), 200, "")
	wantStatus(t, e.do("GET", "/api/store/b-key", nil), 404, "not-found")
	if exists(filepath.Join(e.data, "store", "b-key")) {
		t.Error("delete left the file")
	}
	// Store deletion cannot reach user files.
	e.writeFile(filepath.Join(e.card, "a_key"), "user file")
	wantStatus(t, e.do("DELETE", "/api/store/a_key", nil), 200, "")
	if e.readFile(filepath.Join(e.card, "a_key")) != "user file" {
		t.Error("store delete touched a user file")
	}
}

func TestStoreWriteIsAtomic(t *testing.T) {
	e := newEnv(t)
	wantStatus(t, e.do("PUT", "/api/store/k", "old"), 200, "")
	body := &failAfter{n: 100, err: os.ErrDeadlineExceeded}
	wantStatus(t, e.do("PUT", "/api/store/k", body, chunked), 499, "cancelled")
	if got := e.do("GET", "/api/store/k", nil).Body.String(); got != "old" {
		t.Errorf("a broken upload replaced the value: %q", got)
	}
	entries, _ := os.ReadDir(filepath.Join(e.data, "store"))
	if len(entries) != 1 || entries[0].Name() != "k" {
		t.Errorf("store directory after failed write: %v", entries)
	}
}

func TestSidecar(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "preview.jpg"), []byte("JPEGDATA"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("no"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, func(o *Options) { o.SidecarDir = dir })
	rec := e.do("GET", "/api/sidecar/preview.jpg", nil)
	if rec.Code != 200 || rec.Body.String() != "JPEGDATA" || rec.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("sidecar read: %d %q", rec.Code, rec.Body.String())
	}
	for _, p := range []string{"/api/sidecar/secret.txt", "/api/sidecar/sub/preview.jpg", "/api/sidecar/", "/api/sidecar/..%2Fpreview.jpg", "/api/sidecar/PREVIEW.JPG"} {
		wantStatus(t, e.do("GET", p, nil), 404, "not-found")
	}
	wantStatus(t, e.do("PUT", "/api/sidecar/preview.jpg", "x"), 405, "invalid")
	wantStatus(t, e.do("GET", "/api/sidecar/preview.jpg", nil, noToken), 403, "forbidden")
	wantStatus(t, newEnv(t).do("GET", "/api/sidecar/preview.jpg", nil), 404, "not-found")
}

func TestWindowChrome(t *testing.T) {
	e := newEnv(t)
	body := `{"caption":"#202020","text":"#d6d6d6","dark":true}`
	// no native window: accepted, nothing applied
	rec := e.do("POST", "/api/window/chrome", body)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"applied":false`) {
		t.Fatalf("without a handler: %d %q", rec.Code, rec.Body.String())
	}
	var got []ChromeColors
	e.srv.SetChromeHandler(func(c ChromeColors) { got = append(got, c) })
	rec = e.do("POST", "/api/window/chrome", body)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"applied":true`) {
		t.Fatalf("with a handler: %d %q", rec.Code, rec.Body.String())
	}
	if len(got) != 1 || got[0] != (ChromeColors{Caption: 0x202020, Text: 0xd6d6d6, Dark: true}) {
		t.Fatalf("handler received %+v", got)
	}
	for _, bad := range []string{`{"caption":"202020","text":"#d6d6d6"}`, `{"caption":"#20202","text":"#d6d6d6"}`, `{"caption":"#gggggg","text":"#d6d6d6"}`, `{"caption":"#202020"}`, `{}`} {
		wantStatus(t, e.do("POST", "/api/window/chrome", bad), 400, "invalid")
	}
	if len(got) != 1 {
		t.Errorf("invalid requests reached the handler: %+v", got)
	}
	wantStatus(t, e.do("GET", "/api/window/chrome", nil), 405, "invalid")
	wantStatus(t, e.do("POST", "/api/window/chrome", body, noToken), 403, "forbidden")
}
