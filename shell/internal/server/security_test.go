package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTokenHostOriginEnforcement(t *testing.T) {
	e := newEnv(t)
	cases := []struct {
		name string
		mods []reqMod
		want int
	}{
		{"valid", nil, 200},
		{"no token", []reqMod{noToken}, 403},
		{"empty token", []reqMod{withHeader(TokenHeader, "")}, 403},
		{"wrong token", []reqMod{withHeader(TokenHeader, "0123456789abcdef0123456789abcdee")}, 403},
		{"token prefix", []reqMod{withHeader(TokenHeader, testToken[:31])}, 403},
		{"token with suffix", []reqMod{withHeader(TokenHeader, testToken+"0")}, 403},
		{"token in query only", []reqMod{noToken, func(r *http.Request) { r.URL.RawQuery = "token=" + testToken }}, 403},
		{"token as bearer only", []reqMod{noToken, withHeader("Authorization", "Bearer "+testToken)}, 403},

		{"host localhost", []reqMod{withHost("localhost:4321")}, 200},
		{"host LOCALHOST", []reqMod{withHost("LocalHost:4321")}, 200},
		{"host without port", []reqMod{withHost("127.0.0.1")}, 403},
		{"host wrong port", []reqMod{withHost("127.0.0.1:4322")}, 403},
		{"host other name", []reqMod{withHost("evil.example:4321")}, 403},
		{"host rebinding", []reqMod{withHost("127.0.0.1.evil.example:4321")}, 403},
		{"host other loopback", []reqMod{withHost("127.0.0.2:4321")}, 403},
		{"host ipv6", []reqMod{withHost("[::1]:4321")}, 403},
		{"host empty", []reqMod{withHost("")}, 403},
		{"host with userinfo", []reqMod{withHost("x@127.0.0.1:4321")}, 403},

		{"origin 127.0.0.1", []reqMod{withHeader("Origin", "http://127.0.0.1:4321")}, 200},
		{"origin localhost", []reqMod{withHeader("Origin", "http://localhost:4321")}, 200},
		{"origin https", []reqMod{withHeader("Origin", "https://127.0.0.1:4321")}, 403},
		{"origin wrong port", []reqMod{withHeader("Origin", "http://127.0.0.1:8080")}, 403},
		{"origin without port", []reqMod{withHeader("Origin", "http://127.0.0.1")}, 403},
		{"origin other site", []reqMod{withHeader("Origin", "https://evil.example")}, 403},
		{"origin null", []reqMod{withHeader("Origin", "null")}, 403},
		{"origin empty", []reqMod{withHeader("Origin", "")}, 403},
		{"origin with path", []reqMod{withHeader("Origin", "http://127.0.0.1:4321/")}, 403},
		{"origin lookalike", []reqMod{withHeader("Origin", "http://127.0.0.1:4321.evil.example")}, 403},
		{"two origins", []reqMod{func(r *http.Request) {
			r.Header["Origin"] = []string{"http://127.0.0.1:4321", "https://evil.example"}
		}}, 403},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := e.do("GET", "/api/ping", nil, c.mods...)
			if c.want == 200 {
				wantStatus(t, rec, 200, "")
			} else {
				wantStatus(t, rec, c.want, "forbidden")
			}
		})
	}
}

// Every endpoint is behind the token, not just ping.
func TestEveryEndpointRequiresToken(t *testing.T) {
	e := newEnv(t)
	e.writeFile(filepath.Join(e.card, "a.txt"), "secret")
	reqs := []struct{ method, target string }{
		{"GET", "/api/ping"},
		{"GET", "/api/volumes"},
		{"GET", q("/api/list", "path", e.card)},
		{"POST", "/api/stat"},
		{"GET", q("/api/read", "path", filepath.Join(e.card, "a.txt"))},
		{"PUT", q("/api/write", "path", filepath.Join(e.card, "b.txt"))},
		{"POST", "/api/move"},
		{"POST", "/api/mkdir"},
		{"POST", "/api/pick-directory"},
		{"POST", "/api/reveal"},
		{"POST", "/api/eject"},
		{"GET", "/api/store"},
		{"GET", "/api/store/k"},
		{"PUT", "/api/store/k"},
		{"DELETE", "/api/store/k"},
		{"GET", "/api/nope"},
		{"GET", "/api"},
		{"GET", "/api/"},
	}
	for _, r := range reqs {
		rec := e.do(r.method, r.target, "x", noToken)
		if rec.Code != 403 {
			t.Errorf("%s %s without token: status %d", r.method, r.target, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "secret") {
			t.Errorf("%s %s leaked data without token", r.method, r.target)
		}
	}
	if exists(filepath.Join(e.card, "b.txt")) || exists(filepath.Join(e.data, "store", "k")) {
		t.Error("an unauthenticated request wrote something")
	}
}

func TestNoCORSHeadersAndCommonHeaders(t *testing.T) {
	e := newEnv(t)
	targets := []struct {
		method, target string
		mods           []reqMod
	}{
		{"GET", "/api/ping", nil},
		{"GET", "/api/ping", []reqMod{withHeader("Origin", "http://127.0.0.1:4321")}},
		{"GET", "/api/ping", []reqMod{withHeader("Origin", "https://evil.example")}},
		{"OPTIONS", "/api/ping", []reqMod{withHeader("Origin", "https://evil.example"),
			withHeader("Access-Control-Request-Method", "GET"),
			withHeader("Access-Control-Request-Headers", "x-grmod-token"), noToken}},
		{"GET", "/", nil},
		{"GET", "/host.js", nil},
		{"GET", "/assets/app.js", nil},
		{"GET", "/api/nope", nil},
	}
	for _, c := range targets {
		rec := e.do(c.method, c.target, nil, c.mods...)
		for name := range rec.Header() {
			if strings.HasPrefix(strings.ToLower(name), "access-control-") {
				t.Errorf("%s %s: CORS header %s present", c.method, c.target, name)
			}
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s %s: Cache-Control = %q", c.method, c.target, got)
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s %s: X-Content-Type-Options = %q", c.method, c.target, got)
		}
		if got := rec.Header().Get("Cross-Origin-Resource-Policy"); got != "same-origin" {
			t.Errorf("%s %s: Cross-Origin-Resource-Policy = %q", c.method, c.target, got)
		}
	}
	// A CORS preflight is simply refused.
	rec := e.do("OPTIONS", "/api/ping", nil, noToken, withHeader("Origin", "https://evil.example"))
	if rec.Code != 403 {
		t.Errorf("preflight status = %d", rec.Code)
	}
}

func TestMethodsAndUnknownEndpoints(t *testing.T) {
	e := newEnv(t)
	wantStatus(t, e.do("POST", "/api/ping", nil), 405, "invalid")
	wantStatus(t, e.do("GET", "/api/write", nil), 405, "invalid")
	wantStatus(t, e.do("GET", "/api/stat", nil), 405, "invalid")
	wantStatus(t, e.do("POST", "/api/store", nil), 405, "invalid")
	wantStatus(t, e.do("POST", "/api/store/key", nil), 405, "invalid")
	wantStatus(t, e.do("GET", "/api/nope", nil), 404, "not-found")
	wantStatus(t, e.do("GET", "/api", nil), 404, "not-found")
	wantStatus(t, e.do("GET", "/api/", nil), 404, "not-found")
	wantStatus(t, e.do("GET", "/api/ping/", nil), 404, "not-found")
}

// The general file API cannot delete anything. The only endpoints that
// delete are the two for parked files (parked.go); they take no file-system
// path, only a volume ID and names below GRMOD\parked-*, and cannot be
// pointed at a user's file.
func TestNoDeleteEndpointForUserFiles(t *testing.T) {
	e := newEnv(t)
	file := filepath.Join(e.card, "keep.txt")
	e.writeFile(file, "keep me")
	inGRMOD := filepath.Join(e.card, "GRMOD", "keep.txt")
	e.writeFile(inGRMOD, "keep me too")
	for _, name := range []string{"delete", "remove", "rm", "unlink", "rmdir", "trash", "erase", "format"} {
		for _, method := range []string{"GET", "POST", "PUT", "DELETE"} {
			wantStatus(t, e.do(method, q("/api/"+name, "path", file), map[string]string{"path": file}), 404, "not-found")
		}
	}
	for _, endpoint := range []string{"read", "write", "list", "stat", "move", "mkdir", "volumes", "reveal"} {
		wantStatus(t, e.do("DELETE", q("/api/"+endpoint, "path", file), map[string]string{"path": file}), 405, "invalid")
	}
	allowed := map[string]bool{"/api/parked/delete": true, "/api/backups/delete": true}
	for path := range e.srv.routes {
		for _, bad := range []string{"delete", "remove", "unlink", "erase", "trash"} {
			if strings.Contains(path, bad) && !allowed[path] {
				t.Errorf("route %s looks like a delete endpoint", path)
			}
		}
	}
	// the parked endpoints do not accept anything that names these files
	for _, route := range []string{"/api/parked/delete", "/api/backups/delete"} {
		for _, p := range []string{file, inGRMOD, "keep.txt", "../keep.txt", "GRMOD/keep.txt", "parked-x/../keep.txt", "parked-x/../../keep.txt", "..\\keep.txt", "parked-x\\..\\keep.txt"} {
			rec := e.do("POST", route, parkedRequest{Volume: "card", Paths: []string{p}})
			if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"deleted":[]`) {
				t.Errorf("%s with %q: %d %s", route, p, rec.Code, rec.Body.String())
			}
		}
	}
	if e.readFile(file) != "keep me" || e.readFile(inGRMOD) != "keep me too" {
		t.Error("file was modified")
	}
}

// pathCase is one row of the confinement table. Paths are built from the
// env so that the table works wherever the temp directory lives.
type pathCase struct {
	name string
	path func(e *env) string
	want int // 200 = allowed
}

func confinementCases() []pathCase {
	j := filepath.Join
	return []pathCase{
		{"volume root", func(e *env) string { return e.card }, 200},
		{"volume root with trailing slash", func(e *env) string { return e.card + "/" }, 200},
		{"directory in volume", func(e *env) string { return j(e.card, "DCIM") }, 200},
		{"dot segments inside", func(e *env) string { return e.card + "/./DCIM/../DCIM" }, 200},
		{"double separators", func(e *env) string { return e.card + "//DCIM" }, 200},
		{"symlink to inside", func(e *env) string { return j(e.card, "in") }, 200},
		{"fixed volume (allowed via all=1 listing)", func(e *env) string { return e.disk }, 200},

		{"outside directory", func(e *env) string { return e.outside }, 403},
		{"parent of volume", func(e *env) string { return e.base }, 403},
		{"filesystem root", func(e *env) string { return filepath.VolumeName(e.base) + string(filepath.Separator) }, 403},
		{"data directory", func(e *env) string { return e.data }, 403},
		{"sibling with same prefix", func(e *env) string { return e.card + "2" }, 403},
		{"dotdot to sibling", func(e *env) string { return e.card + "/../outside" }, 403},
		{"dotdot deep", func(e *env) string { return e.card + "/DCIM/../../outside" }, 403},
		{"dotdot above root", func(e *env) string { return e.card + strings.Repeat("/..", 40) + "/etc" }, 403},
		{"dotdot that comes back in (lexically clean)", func(e *env) string { return e.card + "/../card/DCIM" }, 200},
		{"relative", func(e *env) string { return "DCIM" }, 403},
		{"relative dotdot", func(e *env) string { return "../outside" }, 403},
		{"dot", func(e *env) string { return "." }, 403},
		{"symlink to outside", func(e *env) string { return j(e.card, "out") }, 403},
		{"below symlink to outside", func(e *env) string { return j(e.card, "out", "sub") }, 403},
		{"dangling symlink", func(e *env) string { return j(e.card, "dangling") }, 403},
		{"NUL byte", func(e *env) string { return e.card + "/a\x00b" }, 403},
		{"newline", func(e *env) string { return e.card + "/a\nb" }, 403},
	}
}

// posixOnlyCases use spellings whose meaning depends on the path syntax.
func posixOnlyCases() []pathCase {
	return []pathCase{
		{"backslash dotdot", func(e *env) string { return e.card + `\..\outside` }, 403},
		{"mixed separators", func(e *env) string { return e.card + `/DCIM\..\..\outside` }, 403},
		{"backslash path", func(e *env) string { return strings.ReplaceAll(e.outside, "/", `\`) }, 403},
		{"windows drive path", func(e *env) string { return `C:\Windows` }, 403},
		{"windows device path", func(e *env) string { return `\\?\C:\Windows` }, 403},
		{"unc path", func(e *env) string { return `\\server\share` }, 403},
		{"double slash unc", func(e *env) string { return `//server/share` }, 403},
	}
}

func setupConfinement(t *testing.T) *env {
	e := newEnv(t)
	if err := os.MkdirAll(filepath.Join(e.card, "DCIM"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(e.outside, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	e.writeFile(filepath.Join(e.outside, "secret.txt"), "top secret")
	symlinkOrSkip(t, e.outside, filepath.Join(e.card, "out"))
	symlinkOrSkip(t, filepath.Join(e.card, "DCIM"), filepath.Join(e.card, "in"))
	symlinkOrSkip(t, filepath.Join(e.outside, "missing"), filepath.Join(e.card, "dangling"))
	symlinkOrSkip(t, filepath.Join(e.outside, "secret.txt"), filepath.Join(e.card, "secretlink"))
	return e
}

func allConfinementCases() []pathCase {
	cases := confinementCases()
	if filepath.Separator == '/' {
		cases = append(cases, posixOnlyCases()...)
	}
	return cases
}

func TestPathConfinementList(t *testing.T) {
	e := setupConfinement(t)
	for _, c := range allConfinementCases() {
		t.Run(c.name, func(t *testing.T) {
			rec := e.do("GET", q("/api/list", "path", c.path(e)), nil)
			if c.want == 200 {
				wantStatus(t, rec, 200, "")
			} else {
				wantStatus(t, rec, c.want, "forbidden")
				if strings.Contains(rec.Body.String(), "secret") {
					t.Error("listing leaked outside names")
				}
			}
		})
	}
}

func TestPathConfinementStat(t *testing.T) {
	e := setupConfinement(t)
	for _, c := range allConfinementCases() {
		t.Run(c.name, func(t *testing.T) {
			rec := e.do("POST", "/api/stat", map[string]string{"path": c.path(e)})
			if c.want == 200 {
				wantStatus(t, rec, 200, "")
			} else {
				wantStatus(t, rec, c.want, "forbidden")
			}
		})
	}
}

// Every path-taking endpoint refuses the same escapes, and none of them
// touches anything outside while refusing.
func TestPathConfinementAllEndpoints(t *testing.T) {
	e := setupConfinement(t)
	before := tree(t, e.outside)
	inside := filepath.Join(e.card, "DCIM", "ok.bin")
	e.writeFile(inside, "inside")

	var escapes []string
	for _, c := range allConfinementCases() {
		if c.want == 403 {
			escapes = append(escapes, c.path(e))
		}
	}
	// File-level escapes on top of the directory-level ones.
	escapes = append(escapes,
		filepath.Join(e.outside, "secret.txt"),
		filepath.Join(e.outside, "new.txt"),
		e.card+"/../outside/secret.txt",
		e.card+"/DCIM/../../outside/new.txt",
		filepath.Join(e.card, "out", "secret.txt"),
		filepath.Join(e.card, "out", "new.txt"),
		filepath.Join(e.card, "out", "newdir", "new.txt"),
		filepath.Join(e.card, "secretlink"),
		filepath.Join(e.data, "log.txt"),
		filepath.Join(e.data, "store", "x"),
	)
	for _, p := range escapes {
		body := map[string]string{"path": p}
		checks := map[string]int{
			"read":      e.do("GET", q("/api/read", "path", p), nil).Code,
			"write":     e.do("PUT", q("/api/write", "path", p), "pwned").Code,
			"write-new": e.do("PUT", q("/api/write", "path", p, "overwrite", "0"), "pwned").Code,
			"list":      e.do("GET", q("/api/list", "path", p), nil).Code,
			"stat":      e.do("POST", "/api/stat", body).Code,
			"mkdir":     e.do("POST", "/api/mkdir", body).Code,
			"reveal":    e.do("POST", "/api/reveal", body).Code,
			"move-from": e.do("POST", "/api/move", map[string]string{"from": p, "to": filepath.Join(e.card, "stolen")}).Code,
			"move-to":   e.do("POST", "/api/move", map[string]string{"from": inside, "to": p}).Code,
		}
		for name, code := range checks {
			if code != 403 {
				t.Errorf("%s with %q: status %d, want 403", name, p, code)
			}
		}
	}
	if got := e.do("GET", q("/api/read", "path", filepath.Join(e.card, "secretlink")), nil); strings.Contains(got.Body.String(), "top secret") {
		t.Error("read followed a symlink out of the volume")
	}
	after := tree(t, e.outside)
	if strings.Join(before, "|") != strings.Join(after, "|") {
		t.Errorf("outside directory changed:\nbefore %v\nafter  %v", before, after)
	}
	if e.readFile(filepath.Join(e.outside, "secret.txt")) != "top secret" {
		t.Error("outside file was overwritten")
	}
	if exists(filepath.Join(e.card, "stolen")) {
		t.Error("something was moved out of a forbidden place")
	}
	if e.readFile(inside) != "inside" {
		t.Error("inside file was moved or changed by a refused request")
	}
	if len(e.host.revealed) != 0 {
		t.Errorf("reveal was called for forbidden paths: %v", e.host.revealed)
	}
	if entries, _ := os.ReadDir(e.data); len(entries) != 0 {
		t.Errorf("data directory was touched: %v", entries)
	}
}

// Symlinks that stay inside a volume are followed, and the operation acts on
// the real location.
func TestSymlinkInsideVolumeIsFollowed(t *testing.T) {
	e := setupConfinement(t)
	wantStatus(t, e.do("PUT", q("/api/write", "path", filepath.Join(e.card, "in", "via-link.bin")), "data"), 200, "")
	if e.readFile(filepath.Join(e.card, "DCIM", "via-link.bin")) != "data" {
		t.Error("write through an inside symlink did not land in its target")
	}
	rec := e.do("GET", q("/api/read", "path", filepath.Join(e.card, "in", "via-link.bin")), nil)
	if rec.Code != 200 || rec.Body.String() != "data" {
		t.Errorf("read through inside symlink: %d %q", rec.Code, rec.Body.String())
	}
}

// A volume disappears from the allowed roots as soon as the host stops
// listing it: roots are evaluated per request.
func TestRootsAreReevaluatedPerRequest(t *testing.T) {
	e := newEnv(t)
	file := filepath.Join(e.card, "a.txt")
	e.writeFile(file, "x")
	wantStatus(t, e.do("GET", q("/api/read", "path", file), nil), 200, "")

	e.host.mu.Lock()
	saved := e.host.removable
	e.host.removable = nil
	e.host.mu.Unlock()
	wantStatus(t, e.do("GET", q("/api/read", "path", file), nil), 403, "forbidden")
	wantStatus(t, e.do("PUT", q("/api/write", "path", file), "y"), 403, "forbidden")

	e.host.mu.Lock()
	e.host.removable = saved
	e.host.mu.Unlock()
	wantStatus(t, e.do("GET", q("/api/read", "path", file), nil), 200, "")

	// If enumeration itself fails nothing is allowed (but nothing crashes).
	e.host.mu.Lock()
	e.host.volErr = os.ErrPermission
	e.host.mu.Unlock()
	wantStatus(t, e.do("GET", q("/api/read", "path", file), nil), 403, "forbidden")
	wantStatus(t, e.do("GET", "/api/volumes", nil), 500, "io")
}
