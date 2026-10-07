package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"grmod/shell/internal/platform"
)

const (
	testToken = "0123456789abcdef0123456789abcdef"
	testPort  = 4321
	testHost  = "127.0.0.1:4321"
)

// fakeHost is a scriptable platform.Host.
type fakeHost struct {
	mu        sync.Mutex
	kind      string
	removable []platform.Volume // listed always
	fixed     []platform.Volume // listed only with all=1
	protected []string
	volErr    error
	pick      string
	pickErr   error
	pickTitle string
	revealed  []string
	ejectErr  error
	ejected   []string
}

func (h *fakeHost) Kind() string { return h.kind }

func (h *fakeHost) Volumes(all bool) ([]platform.Volume, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.volErr != nil {
		return nil, h.volErr
	}
	out := append([]platform.Volume{}, h.removable...)
	if all {
		out = append(out, h.fixed...)
	}
	return out, nil
}

func (h *fakeHost) ProtectedPaths() []string { return h.protected }

func (h *fakeHost) PickDirectory(title string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.pickTitle = title
	return h.pick, h.pickErr
}

func (h *fakeHost) Reveal(path string, isDir bool) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	kind := "file:"
	if isDir {
		kind = "dir:"
	}
	h.revealed = append(h.revealed, kind+path)
	return nil
}

func (h *fakeHost) Eject(vol platform.Volume) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ejectErr != nil {
		return h.ejectErr
	}
	h.ejected = append(h.ejected, vol.ID)
	return nil
}

// env is a server with one removable volume ("card"), one fixed volume
// ("disk", only allowed/listed with all=1) and a directory outside of both.
type env struct {
	t       *testing.T
	srv     *Server
	host    *fakeHost
	base    string
	card    string
	disk    string
	outside string
	data    string
}

var testWeb = fstest.MapFS{
	"index.html":        {Data: []byte("<!doctype html><title>test ui</title>")},
	"assets/app.js":     {Data: []byte("console.log('app')")},
	"assets/style.css":  {Data: []byte("body{}")},
	"assets/logo.svg":   {Data: []byte("<svg/>")},
	"assets/data.cube":  {Data: []byte("LUT")},
	"assets/mod.wasm":   {Data: []byte("\x00asm")},
	"assets/font.woff2": {Data: []byte("wOF2")},
}

func newEnv(t *testing.T, mod ...func(*Options)) *env {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e := &env{
		t:       t,
		base:    base,
		card:    filepath.Join(base, "card"),
		disk:    filepath.Join(base, "disk"),
		outside: filepath.Join(base, "outside"),
		data:    filepath.Join(base, "data"),
	}
	for _, d := range []string{e.card, e.disk, e.outside, e.data} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	e.host = &fakeHost{
		kind:      "dev",
		removable: []platform.Volume{{ID: "card", Root: e.card, Label: "GR_CARD", FS: "FAT32", Total: 1000, Free: 500, Removable: true, Bus: "SD"}},
		fixed:     []platform.Volume{{ID: "disk", Root: e.disk, Label: "Data", FS: "NTFS", Total: 2000, Free: 100, Bus: "SATA"}},
	}
	opt := Options{
		Token:   testToken,
		Port:    testPort,
		Version: "1.2.3-test",
		Web:     testWeb,
		DataDir: e.data,
		Host:    e.host,
	}
	for _, m := range mod {
		m(&opt)
	}
	srv, err := New(opt)
	if err != nil {
		t.Fatal(err)
	}
	e.srv = srv
	return e
}

// reqMod adjusts a request before it is served.
type reqMod func(*http.Request)

func noToken(r *http.Request)          { r.Header.Del(TokenHeader) }
func withHeader(k, v string) reqMod    { return func(r *http.Request) { r.Header.Set(k, v) } }
func withHost(host string) reqMod      { return func(r *http.Request) { r.Host = host } }
func chunked(r *http.Request)          { r.ContentLength = -1 }
func withContentLength(n int64) reqMod { return func(r *http.Request) { r.ContentLength = n } }

// do serves one request. target is a path with an optional query, body may
// be nil, a string, a []byte, an io.Reader or anything JSON-encodable.
func (e *env) do(method, target string, body any, mods ...reqMod) *httptest.ResponseRecorder {
	e.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		rd = strings.NewReader(b)
	case []byte:
		rd = bytes.NewReader(b)
	case io.Reader:
		rd = b
	default:
		data, err := json.Marshal(b)
		if err != nil {
			e.t.Fatal(err)
		}
		rd = bytes.NewReader(data)
	}
	req := httptest.NewRequest(method, "http://"+testHost+target, rd)
	req.Header.Set(TokenHeader, testToken)
	for _, m := range mods {
		m(req)
	}
	rec := httptest.NewRecorder()
	e.srv.ServeHTTP(rec, req)
	return rec
}

// q builds "?path=<escaped>" style queries.
func q(endpoint string, kv ...string) string {
	var sb strings.Builder
	sb.WriteString(endpoint)
	for i := 0; i+1 < len(kv); i += 2 {
		if i == 0 {
			sb.WriteByte('?')
		} else {
			sb.WriteByte('&')
		}
		sb.WriteString(kv[i] + "=" + urlEscape(kv[i+1]))
	}
	return sb.String()
}

func urlEscape(s string) string {
	const hexdigits = "0123456789ABCDEF"
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' || c == '/' {
			sb.WriteByte(c)
		} else {
			sb.WriteByte('%')
			sb.WriteByte(hexdigits[c>>4])
			sb.WriteByte(hexdigits[c&15])
		}
	}
	return sb.String()
}

// wantStatus checks the status code and, for errors, the JSON error shape.
func wantStatus(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, status, rec.Body.String())
	}
	if code == "" {
		return
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body is not JSON: %v: %s", err, rec.Body.String())
	}
	if body.Error.Code != code || body.Error.Message == "" {
		t.Fatalf("error = %+v, want code %q with a message", body.Error, code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("error Content-Type = %q", ct)
	}
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("response is not JSON: %v: %s", err, rec.Body.String())
	}
	return v
}

func sha(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (e *env) writeFile(path string, data string) {
	e.t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) readFile(path string) string {
	e.t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		e.t.Fatal(err)
	}
	return string(data)
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// tree lists every file and directory below root, relative and sorted.
func tree(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if p != root {
			rel, _ := filepath.Rel(root, p)
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot create symlinks here: %v", err)
	}
}
