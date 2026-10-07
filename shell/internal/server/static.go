package server

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"path"
	"runtime"
	"strconv"
	"strings"
)

// mimeTypes is deliberately a fixed table: the standard library would
// consult the Windows registry, where ".js" is sometimes registered as
// text/plain, which makes browsers refuse module scripts.
var mimeTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".htm":         "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".map":         "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".txt":         "text/plain; charset=utf-8",
	".xml":         "text/xml; charset=utf-8",
	".csv":         "text/csv; charset=utf-8",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".gif":         "image/gif",
	".webp":        "image/webp",
	".avif":        "image/avif",
	".bmp":         "image/bmp",
	".ico":         "image/x-icon",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
	".ttf":         "font/ttf",
	".otf":         "font/otf",
	".wasm":        "application/wasm",
	".pdf":         "application/pdf",
	".mp4":         "video/mp4",
	".webm":        "video/webm",
	".mp3":         "audio/mpeg",
	".wav":         "audio/wav",
}

// mimeFor returns the Content-Type for a file name.
func mimeFor(name string) string {
	if t, ok := mimeTypes[strings.ToLower(path.Ext(name))]; ok {
		return t
	}
	return "application/octet-stream"
}

const missingUI = `<!doctype html><meta charset="utf-8"><title>GR Mod</title>
<p>The user interface files are missing (no index.html).</p>
`

// serveStatic serves the UI files, falling back to index.html for every
// path that is not a file (single-page application routing).
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	data, found := s.readWeb(name)
	if !found {
		name = "index.html"
		data, found = s.readWeb(name)
	}
	status := http.StatusOK
	if !found {
		name, data, status = "index.html", []byte(missingUI), http.StatusNotFound
	}
	w.Header().Set("Content-Type", mimeFor(name))
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		w.Write(data)
	}
}

// readWeb returns the content of a regular UI file.
func (s *Server) readWeb(name string) ([]byte, bool) {
	if !fs.ValidPath(name) {
		return nil, false
	}
	f, err := s.opt.Web.Open(name)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return nil, false
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, false
	}
	return data, true
}

// buildHostJS renders the script behind GET /host.js.
func buildHostJS(kind, token, version string) []byte {
	// encoding/json escapes <, > and & so the value is safe inside a script.
	value, _ := json.Marshal(struct {
		Kind    string `json:"kind"`
		Token   string `json:"token"`
		Version string `json:"version"`
		OS      string `json:"os"`
	}{kind, token, version, runtime.GOOS})
	return []byte("window.__GRMOD_HOST__ = " + string(value) + ";\n")
}

// serveHostJS hands the API token to the page. The page loads it with a
// same-origin <script> tag. Browsers label every request with its relation
// to the page that makes it; anything that is not same-origin (or typed into
// the address bar) is turned away, so another site cannot include the script
// to learn the token.
func (s *Server) serveHostJS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(s.hostJS)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		w.Write(s.hostJS)
	}
}
