package server

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Sidecar files are optional, read-only companions that sit next to the
// executable (for example a preview photo the user supplies). Only the fixed
// names below can be fetched; nothing else in that directory is reachable.
var sidecarNames = map[string]string{
	"preview.jpg": "image/jpeg",
}

const sidecarMaxBytes = 32 << 20

// handleSidecar answers GET /api/sidecar/<name>.
func (s *Server) handleSidecar(w http.ResponseWriter, r *http.Request) error {
	name := strings.TrimPrefix(r.URL.Path, "/api/sidecar/")
	ctype, ok := sidecarNames[name]
	if !ok || s.opt.SidecarDir == "" {
		return errNotFound("no such sidecar file")
	}
	file := filepath.Join(s.opt.SidecarDir, name)
	fi, err := os.Lstat(file)
	if err != nil || !fi.Mode().IsRegular() {
		return errNotFound("no such sidecar file")
	}
	if fi.Size() > sidecarMaxBytes {
		return errTooLarge(sidecarMaxBytes)
	}
	f, err := os.Open(file)
	if err != nil {
		return errNotFound("no such sidecar file")
	}
	defer f.Close()
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	w.WriteHeader(http.StatusOK)
	_, err = io.CopyN(w, f, fi.Size())
	return err
}
