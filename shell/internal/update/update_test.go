package update

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.7.1", "0.7.0", true},
		{"0.7.0", "0.7.0", false},
		{"0.7.0", "0.7.1", false},
		{"0.10.0", "0.9.9", true},
		{"1.0", "0.99.99", true},
		{"0.7.0.1", "0.7.0", true},
		{"0.7", "0.7.0", false},
		{"v0.8.0", "0.7.0", true},
		{"0.8.0", "dev", false},
		{"garbage", "0.7.0", false},
		{"0.8.0-beta", "0.7.0", false},
	}
	for _, c := range cases {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// release is a fake release site.
type release struct {
	t        *testing.T
	pub      ed25519.PublicKey
	priv     ed25519.PrivateKey
	files    map[string][]byte
	mu       sync.Mutex
	requests []string
}

func newRelease(t *testing.T) *release {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &release{t: t, pub: pub, priv: priv, files: map[string][]byte{}}
}

func (r *release) publish(version string, pkgs map[string][]byte, names map[string]string) []byte {
	m := Manifest{App: AppName, Version: version, Date: "2026-10-20", Notes: map[string]string{"zh": "说明", "en": "notes"}, Files: map[string]File{}}
	for plat, data := range pkgs {
		sum := sha256.Sum256(data)
		m.Files[plat] = File{Name: names[plat], Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])}
		r.files[names[plat]] = data
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		r.t.Fatal(err)
	}
	r.files[ManifestName] = data
	r.files[SignatureName] = []byte(Sign(data, r.priv) + "\n")
	return data
}

func (r *release) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	r.mu.Lock()
	r.requests = append(r.requests, req.URL.Path)
	r.mu.Unlock()
	name := strings.TrimPrefix(req.URL.Path, "/rel/")
	data, ok := r.files[name]
	if !ok {
		http.NotFound(w, req)
		return
	}
	w.Write(data)
}

func TestCheckDownloadSwapFile(t *testing.T) {
	rel := newRelease(t)
	newProgram := bytes.Repeat([]byte("new program "), 5000)
	rel.publish("0.7.1", map[string][]byte{PlatformWindows: newProgram}, map[string]string{PlatformWindows: "GRMod-0.7.1.exe"})
	srv := httptest.NewServer(rel)
	defer srv.Close()

	dir := t.TempDir()
	exe := filepath.Join(dir, "GRMod.exe")
	os.WriteFile(exe, []byte("old program"), 0o755)
	var launched []string
	target := &FileTarget{Exe: exe, Launch: func(name string, args []string) error { launched = append([]string{name}, args...); return nil }}
	u := &Updater{Current: "0.7.0", Sources: []string{"http://127.0.0.1:1/unreachable/", srv.URL + "/rel/"}, Key: rel.pub, Platform: PlatformWindows, Target: target}

	in, err := u.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !in.Available || !in.CanInstall || in.Latest != "0.7.1" || in.Size != int64(len(newProgram)) || in.Notes["zh"] != "说明" {
		t.Fatalf("unexpected info %+v", in)
	}
	var last int64
	if err := u.Download(context.Background(), in, func(n, total int64) { last = n }); err != nil {
		t.Fatal(err)
	}
	if last != int64(len(newProgram)) {
		t.Errorf("progress ended at %d", last)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old program" {
		t.Fatal("the program was replaced before Swap")
	}
	if err := target.Swap(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); !bytes.Equal(b, newProgram) {
		t.Fatal("the program was not replaced")
	}
	if b, _ := os.ReadFile(exe + ".old"); string(b) != "old program" {
		t.Fatal("the old program was not kept")
	}
	if err := target.Relaunch([]string{"--after-update=1"}); err != nil || launched[0] != exe {
		t.Fatalf("relaunch: %v %v", err, launched)
	}
	target.Cleanup()
	left, _ := os.ReadDir(dir)
	if len(left) != 1 {
		t.Fatalf("left behind: %v", left)
	}
}

func TestNoUpdate(t *testing.T) {
	rel := newRelease(t)
	rel.publish("0.7.0", map[string][]byte{PlatformWindows: []byte("x")}, map[string]string{PlatformWindows: "GRMod-0.7.0.exe"})
	srv := httptest.NewServer(rel)
	defer srv.Close()
	u := &Updater{Current: "0.7.0", Sources: []string{srv.URL + "/rel/"}, Key: rel.pub, Platform: PlatformWindows}
	in, err := u.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if in.Available {
		t.Fatal("the same version is offered as an update")
	}
	if in.CanInstall || in.Reason != ReasonUnsupported {
		t.Fatalf("no target, but %+v", in)
	}
	u.Platform = PlatformMac
	in, _ = u.Check(context.Background())
	if in.Reason != ReasonNoPackage {
		t.Fatalf("reason %q", in.Reason)
	}
}

func TestTampering(t *testing.T) {
	rel := newRelease(t)
	program := []byte("genuine program")
	rel.publish("0.7.1", map[string][]byte{PlatformWindows: program}, map[string]string{PlatformWindows: "GRMod-0.7.1.exe"})
	srv := httptest.NewServer(rel)
	defer srv.Close()
	dir := t.TempDir()
	exe := filepath.Join(dir, "GRMod.exe")
	os.WriteFile(exe, []byte("old"), 0o755)
	newU := func(key ed25519.PublicKey) *Updater {
		return &Updater{Current: "0.7.0", Sources: []string{srv.URL + "/rel/"}, Key: key, Platform: PlatformWindows, Target: &FileTarget{Exe: exe}}
	}

	// Signed with another key.
	other, _, _ := ed25519.GenerateKey(nil)
	if _, err := newU(other).Check(context.Background()); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("foreign key: %v", err)
	}
	// Manifest changed after signing.
	orig := rel.files[ManifestName]
	rel.files[ManifestName] = bytes.Replace(orig, []byte("0.7.1"), []byte("0.7.2"), 1)
	if _, err := newU(rel.pub).Check(context.Background()); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("edited manifest: %v", err)
	}
	rel.files[ManifestName] = orig
	// Program replaced on the server.
	in, err := newU(rel.pub).Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	rel.files["GRMod-0.7.1.exe"] = []byte("evil program!!!")
	if err := newU(rel.pub).Download(context.Background(), in, nil); !errors.Is(err, ErrMismatch) {
		t.Fatalf("substituted program: %v", err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Fatal("program touched")
	}
	if _, err := os.Stat(exe + ".new"); err == nil {
		t.Fatal("a rejected download was staged")
	}
	if m, _ := filepath.Glob(filepath.Join(dir, ".download-*")); len(m) != 0 {
		t.Fatalf("temporary files left: %v", m)
	}
}

func TestManifestNames(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(nil)
	pub := priv.Public().(ed25519.PublicKey)
	for _, name := range []string{"../evil.exe", "a/b.exe", `a\b.exe`, "", ".."} {
		m := Manifest{App: AppName, Version: "1.0.0", Files: map[string]File{PlatformWindows: {Name: name, Size: 1, SHA256: strings.Repeat("00", 32)}}}
		data, _ := json.Marshal(m)
		if _, err := ParseManifest(data, Sign(data, priv), pub); err == nil {
			t.Errorf("name %q accepted", name)
		}
	}
}

// zipBundle packs files (path -> content; a trailing "*" marks executables).
func zipBundle(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		h := &zip.FileHeader{Name: name}
		if strings.HasSuffix(name, "/") {
			h.SetMode(fs.ModeDir | 0o755)
			zw.CreateHeader(h)
			continue
		}
		mode := fs.FileMode(0o644)
		if strings.HasSuffix(content, "*") {
			mode = 0o755
		}
		h.SetMode(mode)
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(content))
	}
	zw.Close()
	return buf.Bytes()
}

func TestBundle(t *testing.T) {
	rel := newRelease(t)
	pkg := zipBundle(t, map[string]string{
		"GR Mod.app/":                     "",
		"GR Mod.app/Contents/":            "",
		"GR Mod.app/Contents/Info.plist":  "plist v2",
		"GR Mod.app/Contents/MacOS/GRMod": "binary v2*",
	})
	rel.publish("0.7.1", map[string][]byte{PlatformMac: pkg}, map[string]string{PlatformMac: "GRMod-0.7.1-mac.zip"})
	srv := httptest.NewServer(rel)
	defer srv.Close()

	apps := t.TempDir()
	bundle := filepath.Join(apps, "GR Mod.app")
	os.MkdirAll(filepath.Join(bundle, "Contents", "MacOS"), 0o755)
	os.WriteFile(filepath.Join(bundle, "Contents", "Info.plist"), []byte("plist v1"), 0o644)
	os.WriteFile(filepath.Join(bundle, "Contents", "MacOS", "GRMod"), []byte("binary v1"), 0o755)
	if got := BundleOf(filepath.Join(bundle, "Contents", "MacOS", "GRMod")); got != bundle {
		t.Fatalf("BundleOf = %q", got)
	}

	var launched []string
	target := &BundleTarget{Bundle: bundle, Launch: func(name string, args []string) error { launched = append([]string{name}, args...); return nil }}
	u := &Updater{Current: "0.7.0", Sources: []string{srv.URL + "/rel"}, Key: rel.pub, Platform: PlatformMac, Target: target}
	in, err := u.Check(context.Background())
	if err != nil || !in.CanInstall {
		t.Fatalf("check: %v %+v", err, in)
	}
	if err := u.Download(context.Background(), in, nil); err != nil {
		t.Fatal(err)
	}
	if err := target.Swap(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(bundle, "Contents", "MacOS", "GRMod")); string(b) != "binary v2*" {
		t.Fatalf("binary not replaced: %q", b)
	}
	if fi, _ := os.Stat(filepath.Join(bundle, "Contents", "MacOS", "GRMod")); fi.Mode().Perm()&0o111 == 0 {
		t.Fatal("the executable lost its permission")
	}
	if err := target.Relaunch(nil); err != nil || launched[0] != bundle {
		t.Fatalf("relaunch %v %v", err, launched)
	}
	target.Cleanup()
	left, _ := os.ReadDir(apps)
	if len(left) != 1 || left[0].Name() != "GR Mod.app" {
		t.Fatalf("left behind: %v", left)
	}

	if (&BundleTarget{Bundle: "/private/var/folders/x/AppTranslocation/ABC/d/GR Mod.app"}).Check() != ReasonTranslocated {
		t.Fatal("translocation not recognised")
	}
}

func TestBundleRejects(t *testing.T) {
	bad := []map[string]string{
		{"GR Mod.app/Contents/Info.plist": "x", "evil.txt": "x"},
		{"GR Mod.app/../../evil": "x"},
		{"/abs/GR Mod.app/Contents/Info.plist": "x"},
		{"GR Mod.app/Contents/MacOS/GRMod": "x*"}, // no Info.plist
		{"Other/Contents/Info.plist": "x"},
	}
	for i, files := range bad {
		dir := t.TempDir()
		bundle := filepath.Join(dir, "GR Mod.app")
		target := &BundleTarget{Bundle: bundle}
		os.MkdirAll(target.StageDir(), 0o755)
		zipPath := filepath.Join(target.StageDir(), "dl.zip")
		os.WriteFile(zipPath, zipBundle(t, files), 0o644)
		if err := target.Stage(zipPath); err == nil {
			t.Errorf("case %d accepted", i)
		}
		if _, err := os.Stat(filepath.Join(dir, "evil")); err == nil {
			t.Errorf("case %d wrote outside", i)
		}
	}
}

// A release published without update.json: the newest release's version,
// from the address releases/latest redirects to, still answers the check.
func TestLatestWithoutManifest(t *testing.T) {
	tag := "v0.7.0"
	var tagHits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch {
		case req.URL.Path == "/old/repo/releases/latest":
			http.Redirect(w, req, "/new/repo/releases/latest", http.StatusMovedPermanently)
		case req.URL.Path == "/new/repo/releases/latest":
			http.Redirect(w, req, "/new/repo/releases/tag/"+tag, http.StatusFound)
		case strings.HasPrefix(req.URL.Path, "/new/repo/releases/tag/"):
			tagHits++
			w.Write([]byte("page"))
		default:
			http.NotFound(w, req)
		}
	}))
	defer srv.Close()
	rel := newRelease(t)
	u := &Updater{Current: "0.7.1", Sources: []string{srv.URL + "/rel/"}, Key: rel.pub, Platform: PlatformWindows, LatestPage: srv.URL + "/old/repo/releases/latest"}

	in, err := u.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if in.Available || in.Latest != "0.7.0" || in.Current != "0.7.1" {
		t.Fatalf("older release offered: %+v", in)
	}
	u.Current = "0.7.0"
	if in, err = u.Check(context.Background()); err != nil || in.Available {
		t.Fatalf("same release: %+v %v", in, err)
	}
	tag = "v0.8.0"
	in, err = u.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !in.Available || in.Latest != "0.8.0" || in.CanInstall || in.Reason != ReasonManual {
		t.Fatalf("newer release without manifest: %+v", in)
	}
	if err := u.Download(context.Background(), in, nil); err == nil {
		t.Fatal("a release without manifest was downloaded")
	}
	if tagHits != 0 {
		t.Fatal("the release page itself was fetched")
	}

	// Not a release address: the check fails as before.
	u.LatestPage = srv.URL + "/nothing"
	if _, err := u.Check(context.Background()); err == nil {
		t.Fatal("no error without manifest or release")
	}
	tag = "latest-build"
	u.LatestPage = srv.URL + "/new/repo/releases/latest"
	if _, err := u.Check(context.Background()); err == nil {
		t.Fatal("unusable tag accepted")
	}
}

func TestFetchReleases(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Write([]byte(`[
		 {"tag_name":"v0.7.1","name":"0.7.1","body":"## Fixes\r\n- a","html_url":"https://github.com/x/y/releases/tag/v0.7.1","published_at":"2026-10-14T05:16:58Z"},
		 {"tag_name":"v0.8.0-beta","body":"beta","prerelease":true},
		 {"tag_name":"v0.7.2","body":"new","html_url":"http://insecure","published_at":"2026-10-15T01:00:00Z"},
		 {"tag_name":"nightly","body":"x"},
		 {"tag_name":"v0.6.1","body":"old","draft":true}]`))
	}))
	defer srv.Close()
	list, err := FetchReleases(context.Background(), nil, srv.URL, "GRMod/test")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Version != "0.7.2" || list[1].Version != "0.7.1" {
		t.Fatalf("releases %+v", list)
	}
	if list[1].Body != "## Fixes\n- a" || list[1].Date != "2026-10-14" || list[1].Page == "" || list[0].Page != "" {
		t.Fatalf("release %+v / %+v", list[1], list[0])
	}
}

// A later line (GR Mod for a later camera firmware) is reported, never offered.
func TestLines(t *testing.T) {
	own := newRelease(t)
	later := newRelease(t)
	later.pub, later.priv = own.pub, own.priv // the same project key
	own.publish("0.8.3", map[string][]byte{PlatformWindows: []byte("fix")}, map[string]string{PlatformWindows: "GRMod-0.8.3.exe"})
	later.publish("0.9.0", map[string][]byte{PlatformWindows: []byte("new line")}, map[string]string{PlatformWindows: "GRMod-0.9.0.exe"})
	tag := "v0.9.0"
	mux := http.NewServeMux()
	mux.Handle("/own/", http.StripPrefix("/own", own))
	mux.Handle("/later/", http.StripPrefix("/later", later))
	mux.HandleFunc("/releases/latest", func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, "/releases/tag/"+tag, http.StatusFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	dir := t.TempDir()
	exe := filepath.Join(dir, "GRMod.exe")
	os.WriteFile(exe, []byte("old"), 0o755)
	target := &FileTarget{Exe: exe}

	// The channel of this line first, then the newest release (a later line): 0.8.3 is the update.
	u := &Updater{Current: "0.8.2", Sources: []string{srv.URL + "/own/rel/", srv.URL + "/later/rel/"}, Key: own.pub, Platform: PlatformWindows, Target: target, LatestPage: srv.URL + "/releases/latest", Below: "0.9"}
	in, err := u.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !in.Available || in.Latest != "0.8.3" || !in.CanInstall || in.Other == nil || in.Other.Version != "0.9.0" {
		t.Fatalf("own line: %+v %+v", in, in.Other)
	}
	// Without the channel (not published yet): the later line is only reported.
	u.Sources = []string{srv.URL + "/missing/rel/", srv.URL + "/later/rel/"}
	in, err = u.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if in.Available || in.CanInstall || in.Latest != "0.8.2" || in.Other == nil || in.Other.Version != "0.9.0" {
		t.Fatalf("later line offered: %+v", in)
	}
	if err := u.Download(context.Background(), in, nil); err == nil {
		t.Fatal("a release of a later line was downloaded")
	}
	// No manifest anywhere, the newest release is of the later line: reported only.
	u.Sources = []string{srv.URL + "/missing/rel/"}
	in, err = u.Check(context.Background())
	if err != nil || in.Available || in.Other == nil || in.Other.Version != "0.9.0" {
		t.Fatalf("latest page of a later line: %+v %v", in, err)
	}
	// While the newest release is still of this line, nothing is reported.
	tag = "v0.8.3"
	u.Sources = []string{srv.URL + "/own/rel/"}
	in, err = u.Check(context.Background())
	if err != nil || !in.Available || in.Other != nil {
		t.Fatalf("same line: %+v %v", in, err)
	}
	// Without Below every release is of this line (as before 0.8.2).
	u.Below = ""
	u.Sources = []string{srv.URL + "/later/rel/"}
	if in, err = u.Check(context.Background()); err != nil || !in.Available || in.Latest != "0.9.0" {
		t.Fatalf("no line: %+v %v", in, err)
	}
}
