package server

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"grmod/shell/internal/pathguard"
)

// keyPattern is the syntax of store keys.
var keyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// ValidKey reports whether key may be used in the store. Besides the
// documented pattern, two kinds of keys are refused because the key is used
// verbatim as a file name and Windows would not treat them as ordinary
// names: keys ending in a dot ("a." and "a" are the same file there) and the
// reserved device names ("nul", "con.txt", "com1", ...). They are refused on
// every platform so that a UI developed on Linux behaves the same on
// Windows.
func ValidKey(key string) bool {
	return keyPattern.MatchString(key) &&
		!strings.HasSuffix(key, ".") &&
		!pathguard.IsReservedWindowsName(key)
}

func (s *Server) storeDir() string { return filepath.Join(s.opt.DataDir, "store") }

// handleStore serves /api/store and /api/store/<key>.
func (s *Server) handleStore(w http.ResponseWriter, r *http.Request) error {
	if r.URL.Path == "/api/store" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			return errf(http.StatusMethodNotAllowed, codeInvalid, "/api/store requires GET")
		}
		return s.storeList(w)
	}
	key := strings.TrimPrefix(r.URL.Path, "/api/store/")
	if !ValidKey(key) {
		return errInvalid("invalid key (expected %s, not a reserved name)", keyPattern)
	}
	file := filepath.Join(s.storeDir(), key)
	switch r.Method {
	case http.MethodGet:
		return s.storeGet(w, file)
	case http.MethodPut:
		return s.storePut(w, r, file)
	case http.MethodDelete:
		if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
			return err
		}
		return ok(w)
	}
	w.Header().Set("Allow", "GET, PUT, DELETE")
	return errf(http.StatusMethodNotAllowed, codeInvalid, "/api/store/<key> supports GET, PUT and DELETE")
}

func (s *Server) storeList(w http.ResponseWriter) error {
	type keyInfo struct {
		Key  string `json:"key"`
		Size int64  `json:"size"`
	}
	keys := []keyInfo{}
	entries, err := os.ReadDir(s.storeDir())
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, e := range entries {
		// Temporary files of unfinished writes start with a dot and are
		// therefore never valid keys.
		if !ValidKey(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		keys = append(keys, keyInfo{Key: e.Name(), Size: info.Size()})
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].Key < keys[j].Key })
	writeJSON(w, http.StatusOK, struct {
		Keys []keyInfo `json:"keys"`
	}{keys})
	return nil
}

func (s *Server) storeGet(w http.ResponseWriter, file string) error {
	f, err := os.Open(file)
	if err != nil {
		if os.IsNotExist(err) {
			return errNotFound("no such key")
		}
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return errNotFound("no such key")
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	w.WriteHeader(http.StatusOK)
	_, err = io.CopyN(w, f, fi.Size())
	return err
}

func (s *Server) storePut(w http.ResponseWriter, r *http.Request, file string) error {
	if r.ContentLength > s.opt.MaxBytes {
		return errTooLarge(s.opt.MaxBytes)
	}
	dir := s.storeDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	n, _, err := s.writeAtomic(dir, file, http.MaxBytesReader(w, r.Body, s.opt.MaxBytes), true)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, struct {
		OK   bool  `json:"ok"`
		Size int64 `json:"size"`
	}{true, n})
	return nil
}
