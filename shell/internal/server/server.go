// Package server is the local HTTP server of the shell: it serves the UI
// files and the /api/ endpoints the page uses for everything a web page
// cannot do by itself.
package server

import (
	"crypto/subtle"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"grmod/shell/internal/pathguard"
	"grmod/shell/internal/platform"
)

// DefaultMaxBytes is the size limit for file reads, file writes and store
// values.
const DefaultMaxBytes = 256 << 20

// TokenHeader is the request header that carries the API token.
const TokenHeader = "X-GRMod-Token"

// Options configures a Server.
type Options struct {
	// Token is the secret every API request must present.
	Token string
	// Port is the TCP port the server listens on; it is needed to validate
	// the Host and Origin headers.
	Port int
	// Version is reported by /api/ping and /host.js.
	Version string
	// Web holds the UI files (index.html at its root).
	Web fs.FS
	// DataDir is the application's data directory; the key/value store
	// lives in its "store" subdirectory.
	DataDir string
	// Host is the operating-system side.
	Host platform.Host
	// SidecarDir is the directory of optional read-only companion files
	// (normally the executable's directory); empty disables them.
	SidecarDir string

	// Flavor is the path syntax; nil selects the native one.
	Flavor pathguard.Flavor
	// MaxBytes overrides DefaultMaxBytes (used by tests).
	MaxBytes int64
	// Log receives one line per API request; nil discards them.
	Log *log.Logger
	// Now is the clock for the heartbeat; nil selects time.Now.
	Now func() time.Time
}

// Server implements http.Handler.
type Server struct {
	opt       Options
	guard     pathguard.Guard
	hosts     map[string]bool
	origins   map[string]bool
	protected []string
	heartbeat *Heartbeat
	hostJS    []byte
	chrome    chromeHandler
	routes    map[string]route

	pickedMu sync.Mutex
	picked   []string

	// commitMu serialises the "does the destination exist?" check with the
	// rename that follows it, so that two API requests cannot both pass an
	// overwrite=0 check for the same file.
	commitMu sync.Mutex
	// picking is held while a folder dialog is open.
	picking sync.Mutex

	// rename is renameFile; tests replace it to simulate failures.
	rename func(oldpath, newpath string) error
}

type route struct {
	method string
	handle func(http.ResponseWriter, *http.Request) error
}

// New validates the options and returns a Server.
func New(opt Options) (*Server, error) {
	switch {
	case opt.Token == "":
		return nil, errors.New("server: empty token")
	case opt.Port <= 0 || opt.Port > 65535:
		return nil, errors.New("server: invalid port")
	case opt.Web == nil:
		return nil, errors.New("server: no UI files")
	case opt.Host == nil:
		return nil, errors.New("server: no host")
	case opt.DataDir == "":
		return nil, errors.New("server: no data directory")
	}
	if opt.Flavor == nil {
		opt.Flavor = pathguard.Native()
	}
	if opt.MaxBytes <= 0 {
		opt.MaxBytes = DefaultMaxBytes
	}
	if opt.Log == nil {
		opt.Log = log.New(io.Discard, "", 0)
	}
	s := &Server{
		opt:       opt,
		guard:     pathguard.Guard{Flavor: opt.Flavor, FS: pathguard.OS{}},
		hosts:     map[string]bool{},
		origins:   map[string]bool{},
		heartbeat: NewHeartbeat(opt.Now),
		rename:    renameFile,
	}
	port := strconv.Itoa(opt.Port)
	for _, name := range []string{"127.0.0.1", "localhost"} {
		s.hosts[name+":"+port] = true
		s.origins["http://"+name+":"+port] = true
	}
	for _, p := range append(opt.Host.ProtectedPaths(), opt.DataDir) {
		s.protected = append(s.protected, s.spellings(p)...)
	}
	s.hostJS = buildHostJS(opt.Host.Kind(), opt.Token, opt.Version)
	s.routes = map[string]route{
		"/api/ping":           {http.MethodGet, s.handlePing},
		"/api/volumes":        {http.MethodGet, s.handleVolumes},
		"/api/list":           {http.MethodGet, s.handleList},
		"/api/stat":           {http.MethodPost, s.handleStat},
		"/api/read":           {http.MethodGet, s.handleRead},
		"/api/write":          {http.MethodPut, s.handleWrite},
		"/api/move":           {http.MethodPost, s.handleMove},
		"/api/mkdir":          {http.MethodPost, s.handleMkdir},
		"/api/pick-directory": {http.MethodPost, s.handlePickDirectory},
		"/api/reveal":         {http.MethodPost, s.handleReveal},
		"/api/eject":          {http.MethodPost, s.handleEject},
		"/api/window/chrome":  {http.MethodPost, s.handleWindowChrome},
		"/api/parked":         {http.MethodGet, s.handleParkedList},
		"/api/parked/read":    {http.MethodGet, s.handleParkedRead},
		"/api/parked/delete":  {http.MethodPost, s.handleParkedDelete},
		"/api/parked/backup":  {http.MethodPost, s.handleParkedBackup},
		"/api/backups":        {http.MethodGet, s.handleBackupsList},
		"/api/backups/read":   {http.MethodGet, s.handleBackupsRead},
		"/api/backups/delete": {http.MethodPost, s.handleBackupsDelete},
		"/api/backups/reveal": {http.MethodPost, s.handleBackupsReveal},
	}
	return s, nil
}

// Heartbeat returns the tracker fed by the API requests.
func (s *Server) Heartbeat() *Heartbeat { return s.heartbeat }

// spellings returns the cleaned form of a path as given and with symbolic
// links resolved (when it exists), without duplicates.
func (s *Server) spellings(p string) []string {
	var out []string
	if c, err := s.opt.Flavor.Clean(p); err == nil {
		out = append(out, c)
	}
	if ev, err := s.guard.FS.EvalSymlinks(p); err == nil {
		if c, err := s.opt.Flavor.Clean(ev); err == nil && (len(out) == 0 || out[0] != c) {
			out = append(out, c)
		}
	}
	return out
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	// Not a CORS header: it tells browsers that no other origin may embed
	// anything served here (in particular /host.js, which holds the token).
	h.Set("Cross-Origin-Resource-Policy", "same-origin")

	isAPI := r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/")

	// The Host check applies to every request, not only to the API: it is
	// what defeats DNS rebinding, and /host.js needs that protection too.
	if !s.hosts[strings.ToLower(r.Host)] {
		if isAPI {
			s.fail(w, r, time.Now(), errForbidden("unexpected Host header"))
		} else {
			http.Error(w, "forbidden", http.StatusForbidden)
		}
		return
	}
	switch {
	case isAPI:
		s.serveAPI(w, r)
	case r.URL.Path == "/host.js":
		s.serveHostJS(w, r)
	default:
		s.serveStatic(w, r)
	}
}

func (s *Server) serveAPI(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	if origins, present := r.Header["Origin"]; present {
		if len(origins) != 1 || !s.origins[strings.ToLower(origins[0])] {
			s.fail(w, r, start, errForbidden("unexpected Origin header"))
			return
		}
	}
	token := r.Header.Get(TokenHeader)
	if subtle.ConstantTimeCompare([]byte(token), []byte(s.opt.Token)) != 1 {
		s.fail(w, r, start, errForbidden("missing or wrong %s header", TokenHeader))
		return
	}

	s.heartbeat.Begin()
	defer s.heartbeat.End()

	rt, ok := s.routes[r.URL.Path]
	if !ok {
		if r.URL.Path == "/api/store" || strings.HasPrefix(r.URL.Path, "/api/store/") {
			rt = route{method: r.Method, handle: s.handleStore}
		} else if strings.HasPrefix(r.URL.Path, "/api/sidecar/") {
			rt = route{method: http.MethodGet, handle: s.handleSidecar}
		} else {
			s.fail(w, r, start, errNotFound("no such endpoint: %s", r.URL.Path))
			return
		}
	}
	if r.Method != rt.method {
		w.Header().Set("Allow", rt.method)
		s.fail(w, r, start, errf(http.StatusMethodNotAllowed, codeInvalid, "%s requires %s", r.URL.Path, rt.method))
		return
	}

	sw := &statusWriter{ResponseWriter: w}
	if err := rt.handle(sw, r); err != nil {
		if sw.status == 0 {
			e := toAPIError(err)
			if e.code != codeCancelled {
				s.drain(w, r)
			}
			s.fail(sw, r, start, e)
		} else {
			// The response had already started (a download broke off).
			s.opt.Log.Printf("%s %s -> aborted after %d bytes: %v", r.Method, r.URL.Path, sw.bytes, err)
		}
		return
	}
	if r.URL.Path != "/api/ping" {
		s.opt.Log.Printf("%s %s -> %d (%d bytes, %s)", r.Method, r.URL.Path, sw.status, sw.bytes, time.Since(start).Round(time.Millisecond))
	}
}

// drain reads what is left of an upload before an error is answered. A
// browser that is still sending a large body when the answer arrives tends
// to report a network error instead of showing the answer; with the body
// consumed (it comes from the same machine, so this is quick) the page gets
// the JSON error. At most the upload limit is read; anything beyond that
// makes the server close the connection, which is the right answer to a
// client that ignores the limit.
func (s *Server) drain(w http.ResponseWriter, r *http.Request) {
	if r.Body == nil || r.Body == http.NoBody {
		return
	}
	io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, s.opt.MaxBytes))
}

// fail writes an API error and logs it.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, start time.Time, e *apiError) {
	writeError(w, e)
	s.opt.Log.Printf("%s %s -> %d %s: %s (%s)", r.Method, r.URL.Path, e.status, e.code, e.message, time.Since(start).Round(time.Millisecond))
}

// statusWriter remembers the status code and the size of the response.
type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	return n, err
}

// ------------------------------------------------------------ allowed roots

// volumes returns the host's volumes minus everything that must never be
// offered: volumes with an unusable root and volumes that contain a
// protected location (the operating system, the data directory). The host
// already leaves those out on Windows; this second, platform-independent
// filter is what the tests exercise.
func (s *Server) volumes(all bool) ([]platform.Volume, error) {
	vols, err := s.opt.Host.Volumes(all)
	if err != nil {
		return nil, err
	}
	out := make([]platform.Volume, 0, len(vols))
next:
	for _, v := range vols {
		roots := s.spellings(v.Root)
		if len(roots) == 0 {
			continue
		}
		for _, root := range roots {
			for _, p := range s.protected {
				if pathguard.Within(s.opt.Flavor, root, p) {
					continue next
				}
			}
		}
		out = append(out, v)
	}
	return out, nil
}

// roots returns the allowed roots for this very moment: the roots of all
// current volumes plus the folders picked during this run.
func (s *Server) roots() []string {
	var roots []string
	vols, err := s.volumes(true)
	if err != nil {
		s.opt.Log.Printf("volume enumeration failed: %v", err)
	}
	for _, v := range vols {
		roots = append(roots, v.Root)
	}
	s.pickedMu.Lock()
	roots = append(roots, s.picked...)
	s.pickedMu.Unlock()
	return roots
}

func (s *Server) addPicked(clean string) {
	s.pickedMu.Lock()
	defer s.pickedMu.Unlock()
	for _, p := range s.picked {
		if p == clean {
			return
		}
	}
	s.picked = append(s.picked, clean)
}

// resolve confines a user-supplied path to the allowed roots.
func (s *Server) resolve(p string) (pathguard.Resolved, error) {
	if p == "" {
		return pathguard.Resolved{}, errInvalid("missing path")
	}
	return s.guard.Resolve(p, s.roots())
}
