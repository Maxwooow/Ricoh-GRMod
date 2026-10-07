package server

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"
)

const indexHTML = "<!doctype html><title>test ui</title>"

func TestStaticFilesAndMIMETypes(t *testing.T) {
	e := newEnv(t)
	cases := []struct{ target, ctype, body string }{
		{"/", "text/html; charset=utf-8", indexHTML},
		{"/index.html", "text/html; charset=utf-8", indexHTML},
		{"/assets/app.js", "text/javascript; charset=utf-8", "console.log('app')"},
		{"/assets/style.css", "text/css; charset=utf-8", "body{}"},
		{"/assets/logo.svg", "image/svg+xml", "<svg/>"},
		{"/assets/mod.wasm", "application/wasm", "\x00asm"},
		{"/assets/font.woff2", "font/woff2", "wOF2"},
		{"/assets/data.cube", "application/octet-stream", "LUT"},
		{"/assets/../assets/app.js", "text/javascript; charset=utf-8", "console.log('app')"},
		{"//assets//app.js", "text/javascript; charset=utf-8", "console.log('app')"},
		{"/assets/app.js?v=123", "text/javascript; charset=utf-8", "console.log('app')"},
	}
	for _, c := range cases {
		rec := e.do("GET", c.target, nil, noToken) // static files need no token
		if rec.Code != 200 || rec.Body.String() != c.body {
			t.Errorf("GET %s: %d %q", c.target, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Type"); got != c.ctype {
			t.Errorf("GET %s: Content-Type %q, want %q", c.target, got, c.ctype)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("GET %s: Cache-Control %q", c.target, got)
		}
	}
	rec := e.do("HEAD", "/assets/app.js", nil, noToken)
	if rec.Code != 200 || rec.Body.Len() != 0 || rec.Header().Get("Content-Length") != "18" {
		t.Errorf("HEAD: %d, %d bytes, Content-Length %q", rec.Code, rec.Body.Len(), rec.Header().Get("Content-Length"))
	}
	for _, method := range []string{"POST", "PUT", "DELETE", "PATCH"} {
		if rec := e.do(method, "/index.html", "x", noToken); rec.Code != 405 {
			t.Errorf("%s /index.html: %d", method, rec.Code)
		}
	}
}

func TestSPAFallback(t *testing.T) {
	e := newEnv(t)
	for _, target := range []string{
		"/presets", "/presets/42/edit", "/card/", "/assets", "/assets/", "/assets/missing.js",
		"/favicon.ico", "/apiary", "/api-docs", "/store/x", "/../../etc/passwd", "/..%2f..%2fetc%2fpasswd",
		"/index.html/extra", "/%00", "/C:/Windows/win.ini", `/assets\app.js`,
	} {
		rec := e.do("GET", target, nil, noToken)
		if rec.Code != 200 || rec.Body.String() != indexHTML {
			t.Errorf("GET %s: %d %q, want index.html", target, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
			t.Errorf("GET %s: Content-Type %q", target, got)
		}
	}
	// API paths never fall back to the page.
	for _, target := range []string{"/api", "/api/", "/api/nope", "/api/presets/1"} {
		rec := e.do("GET", target, nil)
		if rec.Code != 404 || strings.Contains(rec.Body.String(), "test ui") {
			t.Errorf("GET %s: %d %q", target, rec.Code, rec.Body.String())
		}
	}
}

func TestMissingIndex(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.Web = fstest.MapFS{"readme.txt": {Data: []byte("hi")}} })
	if rec := e.do("GET", "/", nil); rec.Code != 404 || !strings.Contains(rec.Body.String(), "missing") {
		t.Errorf("GET / without index.html: %d %q", rec.Code, rec.Body.String())
	}
	if rec := e.do("GET", "/readme.txt", nil); rec.Code != 200 || rec.Body.String() != "hi" {
		t.Errorf("GET /readme.txt: %d", rec.Code)
	}
}

func TestStaticRequiresKnownHost(t *testing.T) {
	e := newEnv(t)
	for _, target := range []string{"/", "/host.js", "/assets/app.js"} {
		if rec := e.do("GET", target, nil, withHost("evil.example:4321")); rec.Code != 403 || strings.Contains(rec.Body.String(), testToken) {
			t.Errorf("GET %s with foreign Host: %d", target, rec.Code)
		}
	}
}

func TestHostJS(t *testing.T) {
	e := newEnv(t)
	rec := e.do("GET", "/host.js", nil, noToken)
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/javascript; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}
	body := rec.Body.String()
	const prefix = "window.__GRMOD_HOST__ = "
	if !strings.HasPrefix(body, prefix) || !strings.HasSuffix(body, ";\n") {
		t.Fatalf("host.js = %q", body)
	}
	raw := strings.TrimSuffix(strings.TrimPrefix(body, prefix), ";\n")
	want := `{"kind":"dev","token":"` + testToken + `","version":"1.2.3-test","os":"` + runtime.GOOS + `"}`
	if raw != want {
		t.Errorf("host.js value = %s\nwant            %s", raw, want)
	}
	var v map[string]string
	if err := json.Unmarshal([]byte(raw), &v); err != nil || len(v) != 4 {
		t.Errorf("value is not a 4-field JSON object: %v", err)
	}

	// The embed's own host.js (if the UI ships one) never shadows it.
	e2 := newEnv(t, func(o *Options) {
		o.Web = fstest.MapFS{"index.html": {Data: []byte("x")}, "host.js": {Data: []byte("alert(1)")}}
	})
	if got := e2.do("GET", "/host.js", nil).Body.String(); !strings.HasPrefix(got, prefix) {
		t.Errorf("embedded host.js shadowed the generated one: %q", got)
	}

	// Same-origin script loads and direct navigation pass; inclusion by any
	// other page is refused, so the token cannot be read cross-site.
	for site, want := range map[string]int{"same-origin": 200, "none": 200, "cross-site": 403, "same-site": 403} {
		rec := e.do("GET", "/host.js", nil, noToken, withHeader("Sec-Fetch-Site", site))
		if rec.Code != want {
			t.Errorf("Sec-Fetch-Site %s: %d, want %d", site, rec.Code, want)
		}
		if want == 403 && strings.Contains(rec.Body.String(), testToken) {
			t.Errorf("Sec-Fetch-Site %s leaked the token", site)
		}
	}
	if rec := e.do("POST", "/host.js", nil); rec.Code != 405 {
		t.Errorf("POST /host.js: %d", rec.Code)
	}
}

func TestHostJSEscapesValues(t *testing.T) {
	js := string(buildHostJS("windows", "tok", `1.0</script><script>alert("x")`))
	if strings.Contains(js, "</script>") || strings.Contains(js, "<script>") {
		t.Errorf("host.js is not safe inside a script element: %s", js)
	}
	if !strings.Contains(js, `"kind":"windows"`) {
		t.Errorf("kind missing: %s", js)
	}
}

func TestMimeFor(t *testing.T) {
	for name, want := range map[string]string{
		"index.html": "text/html; charset=utf-8", "a.JS": "text/javascript; charset=utf-8",
		"a.mjs": "text/javascript; charset=utf-8", "x.json": "application/json; charset=utf-8",
		"x.png": "image/png", "x.JPG": "image/jpeg", "x.ico": "image/x-icon", "x.webmanifest": "application/manifest+json; charset=utf-8",
		"noext": "application/octet-stream", "x.unknown": "application/octet-stream", "a.tar.gz": "application/octet-stream",
	} {
		if got := mimeFor(name); got != want {
			t.Errorf("mimeFor(%q) = %q, want %q", name, got, want)
		}
	}
}
