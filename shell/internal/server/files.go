package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"

	"grmod/shell/internal/pathguard"
	"grmod/shell/internal/platform"
)

// tempPattern names the temporary files of atomic writes. They are created
// in the destination's directory so that the final rename never crosses a
// volume boundary.
const tempPattern = ".grmod-*.tmp"

// maxJSONBody bounds the JSON request bodies.
const maxJSONBody = 1 << 20

// special are the file types the API never reads from or writes over.
const special = fs.ModeSymlink | fs.ModeNamedPipe | fs.ModeSocket | fs.ModeDevice | fs.ModeCharDevice

// readJSON decodes a JSON object from the request body. An empty body is
// treated as an empty object when optional is set.
func readJSON(w http.ResponseWriter, r *http.Request, v any, optional bool) error {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxJSONBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return errTooLarge(maxJSONBody)
		}
		return errInvalid("cannot read the request body: %v", err)
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		if optional {
			return nil
		}
		return errInvalid("the request body must be a JSON object")
	}
	if err := json.Unmarshal(data, v); err != nil {
		return errInvalid("the request body is not valid JSON: %v", err)
	}
	return nil
}

func ok(w http.ResponseWriter) error {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

// lstat describes a resolved path without following a link in its last
// component. The allowed root itself is the exception: the user chose it, so
// if it happens to be a link or junction it is followed.
func lstat(res pathguard.Resolved) (fs.FileInfo, error) {
	if res.IsRoot {
		return os.Stat(res.Path)
	}
	return os.Lstat(res.Path)
}

// ------------------------------------------------------------------- ping

func (s *Server) handlePing(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, http.StatusOK, struct {
		OK      bool   `json:"ok"`
		Version string `json:"version"`
	}{true, s.opt.Version})
	return nil
}

// ---------------------------------------------------------------- volumes

func (s *Server) handleVolumes(w http.ResponseWriter, r *http.Request) error {
	all, err := boolParam(r, "all", false)
	if err != nil {
		return err
	}
	vols, err := s.volumes(all)
	if err != nil {
		return errIO("cannot list volumes: %v", err)
	}
	writeJSON(w, http.StatusOK, struct {
		Volumes []platform.Volume `json:"volumes"`
	}{vols})
	return nil
}

// boolParam reads a 0/1 query parameter.
func boolParam(r *http.Request, name string, def bool) (bool, error) {
	switch r.URL.Query().Get(name) {
	case "":
		return def, nil
	case "1", "true":
		return true, nil
	case "0", "false":
		return false, nil
	}
	return false, errInvalid("%s must be 0 or 1", name)
}

// ------------------------------------------------------------------- list

type listEntry struct {
	Name  string `json:"name"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) error {
	res, err := s.resolve(r.URL.Query().Get("path"))
	if err != nil {
		return err
	}
	fi, err := lstat(res)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return errInvalid("not a directory")
	}
	dirEntries, err := os.ReadDir(res.Path)
	if err != nil {
		return err
	}
	entries := make([]listEntry, 0, len(dirEntries))
	for _, de := range dirEntries {
		info, err := de.Info() // does not follow links
		if err != nil {
			continue // vanished while listing
		}
		e := listEntry{Name: de.Name(), Dir: info.IsDir(), Mtime: info.ModTime().Unix()}
		if !e.Dir {
			e.Size = info.Size()
		}
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	writeJSON(w, http.StatusOK, struct {
		Entries []listEntry `json:"entries"`
	}{entries})
	return nil
}

// ------------------------------------------------------------------- stat

type pathRequest struct {
	Path string `json:"path"`
}

func (s *Server) handleStat(w http.ResponseWriter, r *http.Request) error {
	var req pathRequest
	if err := readJSON(w, r, &req, false); err != nil {
		return err
	}
	res, err := s.resolve(req.Path)
	if err != nil {
		return err
	}
	out := struct {
		Exists bool  `json:"exists"`
		Dir    bool  `json:"dir"`
		Size   int64 `json:"size"`
	}{}
	fi, err := lstat(res)
	switch {
	case err == nil:
		out.Exists, out.Dir = true, fi.IsDir()
		if !out.Dir {
			out.Size = fi.Size()
		}
	case !isMissing(err):
		return err
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

func isMissing(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR)
}

// ------------------------------------------------------------------- read

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request) error {
	res, err := s.resolve(r.URL.Query().Get("path"))
	if err != nil {
		return err
	}
	// Look before opening: opening a FIFO or a device could block forever.
	fi, err := lstat(res)
	if err != nil {
		return err
	}
	if fi.IsDir() {
		return errInvalid("is a directory")
	}
	if fi.Mode()&special != 0 {
		return errInvalid("not a regular file")
	}
	f, err := os.Open(res.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	if fi, err = f.Stat(); err != nil {
		return err
	}
	if fi.IsDir() {
		return errInvalid("is a directory")
	}
	size := fi.Size()
	if size > s.opt.MaxBytes {
		return errTooLarge(s.opt.MaxBytes)
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.WriteHeader(http.StatusOK)
	_, err = io.CopyN(w, f, size)
	return err
}

// ------------------------------------------------------------------ write

func (s *Server) handleWrite(w http.ResponseWriter, r *http.Request) error {
	overwrite, err := boolParam(r, "overwrite", true)
	if err != nil {
		return err
	}
	res, err := s.resolve(r.URL.Query().Get("path"))
	if err != nil {
		return err
	}
	if res.IsRoot {
		return errInvalid("the path is a directory")
	}
	if r.ContentLength > s.opt.MaxBytes {
		return errTooLarge(s.opt.MaxBytes)
	}
	if err := s.checkDestination(res.Path, overwrite); err != nil {
		return err
	}
	dir := filepath.Dir(res.Path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return mkdirError(err)
	}
	written, sum, err := s.writeAtomic(dir, res.Path, http.MaxBytesReader(w, r.Body, s.opt.MaxBytes), overwrite)
	if err != nil {
		return err
	}

	// Read the destination back: the answer describes what is on the
	// medium now, not what was sent.
	size, readSum, err := hashFile(res.Path)
	if err != nil {
		return errIO("the file was written but cannot be read back: %v", err)
	}
	if size != written || readSum != sum {
		return errIO("verification failed: the file read back differs from the data sent (%d bytes sent, %d read)", written, size)
	}
	s.opt.Log.Printf("wrote %s (%d bytes, sha256 %s)", res.Path, size, readSum)
	writeJSON(w, http.StatusOK, struct {
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	}{size, readSum})
	return nil
}

// checkDestination refuses destinations that must not be replaced.
func (s *Server) checkDestination(path string, overwrite bool) error {
	fi, err := os.Lstat(path)
	if err != nil {
		if isMissing(err) {
			return nil
		}
		return err
	}
	switch {
	case fi.IsDir():
		return errInvalid("the destination is a directory")
	case fi.Mode()&special != 0:
		return errInvalid("the destination is not a regular file")
	case !overwrite:
		return errExists("the destination already exists")
	}
	return nil
}

// mkdirError maps a failed MkdirAll: a file standing where a directory is
// needed is reported as "exists".
func mkdirError(err error) error {
	if errors.Is(err, syscall.ENOTDIR) || errors.Is(err, fs.ErrExist) {
		return errExists("a file is in the way: %v", err)
	}
	return err
}

// bodyReader remembers whether reading the request body failed, so that a
// broken upload can be told apart from a failing disk.
type bodyReader struct {
	r   io.Reader
	err error
}

func (b *bodyReader) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	if err != nil && err != io.EOF {
		b.err = err
	}
	return n, err
}

// writeAtomic stores body as dest without ever exposing a partial file:
// the data goes to a temporary file in dir (dest's directory), is flushed to
// the medium, and only then renamed over dest. On any failure the temporary
// file is removed and dest is untouched. It returns the number of bytes and
// the SHA-256 of the data received.
func (s *Server) writeAtomic(dir, dest string, body io.Reader, overwrite bool) (int64, string, error) {
	tmp, err := os.CreateTemp(dir, tempPattern)
	if err != nil {
		return 0, "", err
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()

	src := &bodyReader{r: body}
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, hash), src)
	if err != nil {
		var tooLarge *http.MaxBytesError
		switch {
		case errors.As(err, &tooLarge):
			return 0, "", errTooLarge(tooLarge.Limit)
		case src.err != nil:
			return 0, "", errf(statusClientClosed, codeCancelled, "the upload was interrupted: %v", src.err)
		}
		return 0, "", err
	}
	_ = tmp.Chmod(0o644) // CreateTemp makes it 0600; best effort
	if err := tmp.Sync(); err != nil {
		return 0, "", err
	}
	if err := tmp.Close(); err != nil {
		return 0, "", err
	}

	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	if err := s.checkDestination(dest, overwrite); err != nil {
		return 0, "", err
	}
	if err := s.rename(tmpName, dest); err != nil {
		return 0, "", err
	}
	committed = true
	return n, hex.EncodeToString(hash.Sum(nil)), nil
}

func hashFile(path string) (int64, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, f)
	if err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(hash.Sum(nil)), nil
}

// ------------------------------------------------------------------- move

func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := readJSON(w, r, &req, false); err != nil {
		return err
	}
	if req.From == "" || req.To == "" {
		return errInvalid("both from and to are required")
	}
	// Both paths are checked before anything else, and a refusal wins over
	// every other problem: a forbidden destination is reported as such even
	// when the source does not exist.
	from, errFrom := s.resolve(req.From)
	to, errTo := s.resolve(req.To)
	for _, err := range []error{errFrom, errTo} {
		if pathguard.KindOf(err) == pathguard.Forbidden {
			return err
		}
	}
	if errFrom != nil {
		return errFrom
	}
	if errTo != nil {
		return errTo
	}
	if from.IsRoot || to.IsRoot {
		return errInvalid("a volume or picked folder itself cannot be moved or replaced")
	}
	// A rename acts on the link, not on what it points to, which is not what
	// "from" was resolved to. Links are simply not moved.
	if fi, err := os.Lstat(from.Lexical); err == nil && fi.Mode()&fs.ModeSymlink != 0 {
		return errForbidden("symbolic links cannot be moved")
	}
	src, err := os.Lstat(from.Path)
	if err != nil {
		if isMissing(err) {
			return errNotFound("the source does not exist")
		}
		return err
	}
	f := s.opt.Flavor
	if !pathguard.SameVolume(f, from.Path, to.Path) {
		return errInvalid("the destination is on a different volume")
	}
	if src.IsDir() && pathguard.Within(f, from.Path, to.Path) && from.Path != to.Path {
		return errInvalid("a directory cannot be moved into itself")
	}
	if err := os.MkdirAll(filepath.Dir(to.Path), 0o755); err != nil {
		return mkdirError(err)
	}

	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	if _, err := os.Lstat(to.Path); err == nil {
		return errExists("the destination already exists")
	} else if !isMissing(err) {
		return err
	}
	if err := s.rename(from.Path, to.Path); err != nil {
		if isCrossDevice(err) {
			return errInvalid("the destination is on a different volume")
		}
		return err
	}
	s.opt.Log.Printf("moved %s -> %s", from.Path, to.Path)
	return ok(w)
}

// ------------------------------------------------------------------ mkdir

func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) error {
	var req pathRequest
	if err := readJSON(w, r, &req, false); err != nil {
		return err
	}
	res, err := s.resolve(req.Path)
	if err != nil {
		return err
	}
	if fi, err := lstat(res); err == nil {
		if fi.IsDir() {
			return ok(w)
		}
		return errExists("a file with that name already exists")
	}
	if err := os.MkdirAll(res.Path, 0o755); err != nil {
		return mkdirError(err)
	}
	return ok(w)
}

// --------------------------------------------------------- pick-directory

func (s *Server) handlePickDirectory(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Title string `json:"title"`
	}
	if err := readJSON(w, r, &req, true); err != nil {
		return err
	}
	if !s.picking.TryLock() {
		return errf(http.StatusConflict, codeInvalid, "a folder dialog is already open")
	}
	defer s.picking.Unlock()

	picked, err := s.opt.Host.PickDirectory(req.Title)
	if err != nil {
		return errIO("the folder dialog failed: %v", err)
	}
	out := pathRequest{}
	if picked != "" {
		clean, err := s.opt.Flavor.Clean(picked)
		if err != nil {
			return errInvalid("this location cannot be used (%v)", err)
		}
		s.addPicked(clean)
		s.opt.Log.Printf("picked folder %s", clean)
		out.Path = clean
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

// ----------------------------------------------------------------- reveal

func (s *Server) handleReveal(w http.ResponseWriter, r *http.Request) error {
	var req pathRequest
	if err := readJSON(w, r, &req, false); err != nil {
		return err
	}
	res, err := s.resolve(req.Path)
	if err != nil {
		return err
	}
	fi, err := lstat(res)
	if err != nil {
		return err
	}
	if err := s.opt.Host.Reveal(res.Path, fi.IsDir()); err != nil {
		return errIO("cannot open the file manager: %v", err)
	}
	return ok(w)
}

// ------------------------------------------------------------------ eject

func (s *Server) handleEject(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		ID string `json:"id"`
	}
	if err := readJSON(w, r, &req, false); err != nil {
		return err
	}
	if req.ID == "" {
		return errInvalid("missing id")
	}
	// Only volumes of the default (removable) listing can be ejected.
	vols, err := s.volumes(false)
	if err != nil {
		return errIO("cannot list volumes: %v", err)
	}
	for _, v := range vols {
		if !strings.EqualFold(v.ID, req.ID) || !v.Removable {
			continue
		}
		err := s.opt.Host.Eject(v)
		switch {
		case errors.Is(err, platform.ErrUnsupported):
			return errf(http.StatusNotImplemented, codeInvalid, "ejecting is not implemented on this platform")
		case err != nil:
			return errIO("cannot eject %s: %v", v.ID, err)
		}
		s.opt.Log.Printf("ejected %s", v.ID)
		return ok(w)
	}
	return errNotFound("no removable volume %q", req.ID)
}
