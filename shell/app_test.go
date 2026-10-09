//go:build !windows && !darwin

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"grmod/shell/internal/platform"
)

// startApp runs a complete instance on a real socket, the way the
// development build does.
func startApp(t *testing.T, cfg config) (*app, string) {
	t.Helper()
	base := t.TempDir()
	if cfg.dataDir == "" {
		cfg.dataDir = filepath.Join(base, "data")
	}
	card := filepath.Join(base, "card")
	if err := os.Mkdir(card, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(platform.EnvDevVolumes, card)
	t.Setenv(platform.EnvDevPick, "")
	a, err := newApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.close)
	if err := a.start(platform.New()); err != nil {
		t.Fatal(err)
	}
	return a, card
}

func request(t *testing.T, method, rawURL, token string, body []byte) (int, http.Header, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, rawURL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("X-GRMod-Token", token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, resp.Header, data
}

func TestAppEndToEnd(t *testing.T) {
	a, card := startApp(t, config{})
	if !strings.HasPrefix(a.url, "http://127.0.0.1:") || !strings.HasSuffix(a.url, "/") {
		t.Fatalf("url = %q", a.url)
	}
	if len(a.token) != 32 {
		t.Fatalf("token = %q", a.token)
	}
	api := strings.TrimSuffix(a.url, "/")

	// The embedded placeholder page and host.js.
	code, hdr, body := request(t, "GET", a.url, "", nil)
	if code != 200 || !strings.Contains(string(body), "<title>GR Mod</title>") || hdr.Get("Cache-Control") != "no-store" {
		t.Errorf("GET /: %d, Cache-Control %q", code, hdr.Get("Cache-Control"))
	}
	code, _, body = request(t, "GET", api+"/host.js", "", nil)
	if code != 200 || !strings.Contains(string(body), `"kind":"dev"`) || !strings.Contains(string(body), `"token":"`+a.token+`"`) || !strings.Contains(string(body), `"version":"`+version+`"`) {
		t.Errorf("GET /host.js: %d %s", code, body)
	}

	// Token enforcement over a real connection.
	if code, _, _ := request(t, "GET", api+"/api/ping", "", nil); code != 403 {
		t.Errorf("ping without token: %d", code)
	}
	if code, _, body := request(t, "GET", api+"/api/ping", a.token, nil); code != 200 || !strings.Contains(string(body), `"ok":true`) {
		t.Errorf("ping: %d %s", code, body)
	}
	// "localhost" is an accepted name for the same socket.
	localhost := strings.Replace(api, "127.0.0.1", "localhost", 1)
	if code, _, _ := request(t, "GET", localhost+"/api/ping", a.token, nil); code != 200 {
		t.Errorf("ping via localhost: %d", code)
	}

	// Write, read back, list.
	payload := bytes.Repeat([]byte("GR"), 50_000)
	sum := sha256.Sum256(payload)
	file := filepath.Join(card, "DCIM", "x.bin")
	code, _, body = request(t, "PUT", api+"/api/write?path="+url.QueryEscape(file), a.token, payload)
	var wr struct {
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	}
	json.Unmarshal(body, &wr)
	if code != 200 || wr.Size != int64(len(payload)) || wr.SHA256 != hex.EncodeToString(sum[:]) {
		t.Errorf("write: %d %s", code, body)
	}
	code, _, body = request(t, "GET", api+"/api/read?path="+url.QueryEscape(file), a.token, nil)
	if code != 200 || !bytes.Equal(body, payload) {
		t.Errorf("read: %d, %d bytes", code, len(body))
	}
	code, _, body = request(t, "GET", api+"/api/list?path="+url.QueryEscape(filepath.Dir(file)), a.token, nil)
	if code != 200 || !strings.Contains(string(body), `"name":"x.bin"`) {
		t.Errorf("list: %d %s", code, body)
	}
	if code, _, _ := request(t, "GET", api+"/api/list?path="+url.QueryEscape(a.dataDir), a.token, nil); code != 403 {
		t.Errorf("listing the data directory: %d", code)
	}

	// The log exists, mentions the write, and holds neither the token nor
	// file contents.
	logData, err := os.ReadFile(filepath.Join(a.dataDir, "log.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(logData), "wrote "+file) || !strings.Contains(string(logData), "/api/write") {
		t.Errorf("log lacks the write:\n%s", logData)
	}
	if strings.Contains(string(logData), a.token) {
		t.Error("the log contains the API token")
	}
	if strings.Contains(string(logData), "GRGRGRGR") {
		t.Error("the log contains file contents")
	}
	if strings.Contains(string(logData), "/api/ping -> 200") {
		t.Error("successful pings are logged (they would flood the log)")
	}
}

func TestAppFlags(t *testing.T) {
	web := t.TempDir()
	os.WriteFile(filepath.Join(web, "index.html"), []byte("<p>dev ui</p>"), 0o644)
	os.WriteFile(filepath.Join(web, "app.js"), []byte("1"), 0o644)
	data := filepath.Join(t.TempDir(), "custom-data")

	// Find a free port for --port.
	probe, err := listen(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	port := portOf(probe)
	probe.Close()

	a, _ := startApp(t, config{port: port, token: "fixed-token", webDir: web, dataDir: data})
	if a.port != port || a.token != "fixed-token" || a.dataDir != data {
		t.Fatalf("port %d token %q data %q", a.port, a.token, a.dataDir)
	}
	code, _, body := request(t, "GET", a.url, "", nil)
	if code != 200 || string(body) != "<p>dev ui</p>" {
		t.Errorf("--web index: %d %q", code, body)
	}
	code, hdr, _ := request(t, "GET", a.url+"app.js", "", nil)
	if code != 200 || !strings.HasPrefix(hdr.Get("Content-Type"), "text/javascript") {
		t.Errorf("--web app.js: %d %q", code, hdr.Get("Content-Type"))
	}
	// Files on disk are picked up without a restart (development).
	os.WriteFile(filepath.Join(web, "index.html"), []byte("<p>edited</p>"), 0o644)
	if _, _, body := request(t, "GET", a.url+"some/route", "", nil); string(body) != "<p>edited</p>" {
		t.Errorf("edited index via SPA fallback: %q", body)
	}
	// The --web directory cannot be escaped.
	os.WriteFile(filepath.Join(filepath.Dir(web), "outside.txt"), []byte("outside"), 0o644)
	if _, _, body := request(t, "GET", a.url+"%2e%2e/outside.txt", "", nil); strings.Contains(string(body), "outside") {
		t.Error("--web directory escaped")
	}

	if code, _, _ := request(t, "GET", a.url+"api/ping", "fixed-token", nil); code != 200 {
		t.Errorf("ping with fixed token: %d", code)
	}
	if code, _, _ := request(t, "PUT", a.url+"api/store/k", "fixed-token", []byte("v")); code != 200 {
		t.Errorf("store put: %d", code)
	}
	if got, _ := os.ReadFile(filepath.Join(data, "store", "k")); string(got) != "v" {
		t.Errorf("store file in --data: %q", got)
	}
	if _, err := os.Stat(filepath.Join(data, "log.txt")); err != nil {
		t.Errorf("log in --data: %v", err)
	}
}

func TestNewAppErrors(t *testing.T) {
	if _, err := newApp(config{dataDir: t.TempDir(), webDir: filepath.Join(t.TempDir(), "missing")}); err == nil {
		t.Error("a missing --web directory was accepted")
	}
	file := filepath.Join(t.TempDir(), "file")
	os.WriteFile(file, []byte("x"), 0o644)
	if _, err := newApp(config{dataDir: filepath.Join(file, "sub")}); err == nil {
		t.Error("an impossible --data directory was accepted")
	}
}

func TestDefaultDataDirFollowsXDG(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_DATA_HOME", xdg)
	a, err := newApp(config{})
	if err != nil {
		t.Fatal(err)
	}
	defer a.close()
	if a.dataDir != filepath.Join(xdg, "grmod") {
		t.Errorf("data dir = %q", a.dataDir)
	}
}
