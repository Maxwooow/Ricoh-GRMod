package server

import (
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"grmod/shell/internal/pathguard"
)

// Files that were in the way of a write are moved into GRMOD\parked-<stamp>\
// on the card. The endpoints in this file are the only ones that can delete
// anything, and they can reach exactly two places:
//
//   - <volume root>\GRMOD\parked-<stamp>\...   on a listed volume, and
//   - <data directory>\backups\parked-<stamp>\...   (copies made from there).
//
// Every path is given relative to that base as "parked-<stamp>/<name>" or
// "parked-<stamp>/<directory>/<name>", is matched against a strict pattern
// and is walked component by component without following links.

const (
	parkRootName   = "GRMOD"
	backupsDirName = "backups"
	parkedMaxFiles = 2000
)

var (
	parkedFolderRE = regexp.MustCompile(`^parked-[0-9A-Za-z_-]{1,40}$`)
	parkedNameRE   = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$`)
)

// parkedRel splits and validates a relative path below a parked base.
func parkedRel(p string) ([]string, bool) {
	parts := strings.Split(p, "/")
	if len(parts) < 2 || len(parts) > 3 || !parkedFolderRE.MatchString(parts[0]) {
		return nil, false
	}
	for _, name := range parts[1:] {
		if !parkedNameRE.MatchString(name) || strings.HasSuffix(name, ".") || strings.Contains(name, "..") || pathguard.IsReservedWindowsName(name) {
			return nil, false
		}
	}
	return parts, true
}

type parkedEntry struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

type parkedFailure struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// realDir reports whether path is a directory and not a link to one.
func realDir(path string) bool {
	fi, err := os.Lstat(path)
	return err == nil && fi.IsDir() && fi.Mode()&fs.ModeSymlink == 0
}

// walkParked lists the regular files below base\parked-*\ (two levels).
func walkParked(base string) ([]parkedEntry, error) {
	out := []parkedEntry{}
	if !realDir(base) {
		return out, nil
	}
	folders, err := os.ReadDir(base)
	if err != nil {
		return nil, err
	}
	add := func(rel, file string) {
		fi, err := os.Lstat(file)
		if err != nil || !fi.Mode().IsRegular() || len(out) >= parkedMaxFiles {
			return
		}
		out = append(out, parkedEntry{Path: rel, Size: fi.Size(), Mtime: fi.ModTime().UnixMilli()})
	}
	for _, f := range folders {
		if !parkedFolderRE.MatchString(f.Name()) || !realDir(filepath.Join(base, f.Name())) {
			continue
		}
		items, err := os.ReadDir(filepath.Join(base, f.Name()))
		if err != nil {
			continue
		}
		for _, it := range items {
			if _, ok := parkedRel(f.Name() + "/" + it.Name()); !ok {
				continue
			}
			full := filepath.Join(base, f.Name(), it.Name())
			if realDir(full) {
				subs, err := os.ReadDir(full)
				if err != nil {
					continue
				}
				for _, sub := range subs {
					rel := f.Name() + "/" + it.Name() + "/" + sub.Name()
					if _, ok := parkedRel(rel); ok {
						add(rel, filepath.Join(full, sub.Name()))
					}
				}
				continue
			}
			add(f.Name()+"/"+it.Name(), full)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// parkedFile resolves a validated relative path to a regular file below
// base, refusing links anywhere on the way.
func parkedFile(base string, parts []string) (string, fs.FileInfo, error) {
	if !realDir(base) {
		return "", nil, errNotFound("no such file")
	}
	dir := base
	for _, name := range parts[:len(parts)-1] {
		dir = filepath.Join(dir, name)
		if !realDir(dir) {
			return "", nil, errNotFound("no such file")
		}
	}
	file := filepath.Join(dir, parts[len(parts)-1])
	fi, err := os.Lstat(file)
	if err != nil || !fi.Mode().IsRegular() {
		return "", nil, errNotFound("no such file")
	}
	return file, fi, nil
}

// deleteParked removes the given files below base and then every directory
// that has become empty (the parked folders, never anything above base).
func (s *Server) deleteParked(base string, rels []string) (deleted []string, failed []parkedFailure) {
	deleted = []string{}
	failed = []parkedFailure{}
	touched := map[string]bool{}
	for _, rel := range rels {
		parts, ok := parkedRel(rel)
		if !ok {
			failed = append(failed, parkedFailure{rel, "invalid path"})
			continue
		}
		file, _, err := parkedFile(base, parts)
		if err != nil {
			failed = append(failed, parkedFailure{rel, "not found"})
			continue
		}
		if err := os.Remove(file); err != nil {
			failed = append(failed, parkedFailure{rel, err.Error()})
			continue
		}
		s.opt.Log.Printf("deleted %s", file)
		deleted = append(deleted, rel)
		touched[parts[0]] = true
		if len(parts) == 3 {
			_ = os.Remove(filepath.Join(base, parts[0], parts[1])) // only succeeds when empty
		}
	}
	for folder := range touched {
		_ = os.Remove(filepath.Join(base, folder)) // only succeeds when empty
	}
	return deleted, failed
}

func (s *Server) backupsDir() string { return filepath.Join(s.opt.DataDir, backupsDirName) }

// parkedBase returns <root>\GRMOD of the volume with the given ID.
func (s *Server) parkedBase(id string) (string, error) {
	if id == "" {
		return "", errInvalid("missing volume")
	}
	vols, err := s.volumes(true)
	if err != nil {
		return "", errIO("cannot list volumes: %v", err)
	}
	for _, v := range vols {
		if strings.EqualFold(v.ID, id) {
			return filepath.Join(v.Root, parkRootName), nil
		}
	}
	return "", errNotFound("no such volume: %s", id)
}

type parkedRequest struct {
	Volume string   `json:"volume"`
	Paths  []string `json:"paths"`
}

func (r parkedRequest) check() error {
	if len(r.Paths) == 0 {
		return errInvalid("no paths")
	}
	if len(r.Paths) > parkedMaxFiles {
		return errInvalid("too many paths")
	}
	return nil
}

// handleParkedList answers GET /api/parked?volume=<id>.
func (s *Server) handleParkedList(w http.ResponseWriter, r *http.Request) error {
	base, err := s.parkedBase(r.URL.Query().Get("volume"))
	if err != nil {
		return err
	}
	entries, err := walkParked(base)
	if err != nil {
		return errIO("cannot list %s: %v", base, err)
	}
	writeJSON(w, http.StatusOK, struct {
		Entries []parkedEntry `json:"entries"`
	}{entries})
	return nil
}

// handleParkedDelete answers POST /api/parked/delete.
func (s *Server) handleParkedDelete(w http.ResponseWriter, r *http.Request) error {
	var req parkedRequest
	if err := readJSON(w, r, &req, false); err != nil {
		return err
	}
	if err := req.check(); err != nil {
		return err
	}
	base, err := s.parkedBase(req.Volume)
	if err != nil {
		return err
	}
	s.commitMu.Lock()
	deleted, failed := s.deleteParked(base, req.Paths)
	_ = os.Remove(base) // GRMOD itself, when nothing is left in it
	s.commitMu.Unlock()
	writeJSON(w, http.StatusOK, struct {
		Deleted []string        `json:"deleted"`
		Failed  []parkedFailure `json:"failed"`
	}{deleted, failed})
	return nil
}

type backupResult struct {
	Path string `json:"path"`
	// Dest is where the copy is, relative to the backups directory.
	Dest string `json:"dest"`
	// Existed is set when an identical copy was already there.
	Existed bool `json:"existed"`
}

// backupOne copies one parked file into the backups directory and verifies
// the copy by reading it back.
func (s *Server) backupOne(base string, rel string) (backupResult, error) {
	parts, ok := parkedRel(rel)
	if !ok {
		return backupResult{}, errors.New("invalid path")
	}
	src, fi, err := parkedFile(base, parts)
	if err != nil {
		return backupResult{}, errors.New("not found")
	}
	if fi.Size() > s.opt.MaxBytes {
		return backupResult{}, errors.New("file too large")
	}
	_, srcHash, err := hashFile(src)
	if err != nil {
		return backupResult{}, err
	}
	// The same folder name may come from another card: keep both.
	for n := 1; n < 100; n++ {
		folder := parts[0]
		if n > 1 {
			folder += "-" + strconv.Itoa(n)
		}
		if !parkedFolderRE.MatchString(folder) {
			break
		}
		destParts := append([]string{folder}, parts[1:]...)
		dest := filepath.Join(append([]string{s.backupsDir()}, destParts...)...)
		destRel := strings.Join(destParts, "/")
		if dfi, err := os.Lstat(dest); err == nil {
			if dfi.Mode().IsRegular() && dfi.Size() == fi.Size() {
				if _, h, err := hashFile(dest); err == nil && h == srcHash {
					return backupResult{Path: rel, Dest: destRel, Existed: true}, nil
				}
			}
			continue
		}
		dir := filepath.Dir(dest)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return backupResult{}, err
		}
		f, err := os.Open(src)
		if err != nil {
			return backupResult{}, err
		}
		_, written, err := s.writeAtomic(dir, dest, io.LimitReader(f, s.opt.MaxBytes+1), false)
		f.Close()
		if err != nil {
			return backupResult{}, err
		}
		_, onDisk, err := hashFile(dest)
		if err != nil || written != srcHash || onDisk != srcHash {
			os.Remove(dest)
			return backupResult{}, errors.New("the copy does not match the original")
		}
		s.opt.Log.Printf("backed up %s -> %s (%d bytes, sha256 %s)", src, dest, fi.Size(), srcHash)
		return backupResult{Path: rel, Dest: destRel}, nil
	}
	return backupResult{}, errors.New("too many backups with this name")
}

// handleParkedBackup answers POST /api/parked/backup.
func (s *Server) handleParkedBackup(w http.ResponseWriter, r *http.Request) error {
	var req parkedRequest
	if err := readJSON(w, r, &req, false); err != nil {
		return err
	}
	if err := req.check(); err != nil {
		return err
	}
	base, err := s.parkedBase(req.Volume)
	if err != nil {
		return err
	}
	saved := []backupResult{}
	failed := []parkedFailure{}
	for _, rel := range req.Paths {
		res, err := s.backupOne(base, rel)
		if err != nil {
			failed = append(failed, parkedFailure{rel, err.Error()})
			continue
		}
		saved = append(saved, res)
	}
	writeJSON(w, http.StatusOK, struct {
		Saved  []backupResult  `json:"saved"`
		Failed []parkedFailure `json:"failed"`
	}{saved, failed})
	return nil
}

// handleBackupsList answers GET /api/backups.
func (s *Server) handleBackupsList(w http.ResponseWriter, r *http.Request) error {
	entries, err := walkParked(s.backupsDir())
	if err != nil {
		return errIO("cannot list the backups: %v", err)
	}
	writeJSON(w, http.StatusOK, struct {
		Dir     string        `json:"dir"`
		Entries []parkedEntry `json:"entries"`
	}{s.backupsDir(), entries})
	return nil
}

// serveParkedFile sends one file below base.
func (s *Server) serveParkedFile(w http.ResponseWriter, base, rel string) error {
	parts, ok := parkedRel(rel)
	if !ok {
		return errInvalid("invalid path")
	}
	file, fi, err := parkedFile(base, parts)
	if err != nil {
		return err
	}
	if fi.Size() > s.opt.MaxBytes {
		return errTooLarge(s.opt.MaxBytes)
	}
	f, err := os.Open(file)
	if err != nil {
		return errNotFound("no such file")
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	w.WriteHeader(http.StatusOK)
	_, err = io.CopyN(w, f, fi.Size())
	return err
}

// handleParkedRead answers GET /api/parked/read?volume=<id>&path=<rel>.
func (s *Server) handleParkedRead(w http.ResponseWriter, r *http.Request) error {
	base, err := s.parkedBase(r.URL.Query().Get("volume"))
	if err != nil {
		return err
	}
	return s.serveParkedFile(w, base, r.URL.Query().Get("path"))
}

// handleBackupsRead answers GET /api/backups/read?path=<rel>.
func (s *Server) handleBackupsRead(w http.ResponseWriter, r *http.Request) error {
	return s.serveParkedFile(w, s.backupsDir(), r.URL.Query().Get("path"))
}

// handleBackupsDelete answers POST /api/backups/delete.
func (s *Server) handleBackupsDelete(w http.ResponseWriter, r *http.Request) error {
	var req parkedRequest
	if err := readJSON(w, r, &req, false); err != nil {
		return err
	}
	if err := req.check(); err != nil {
		return err
	}
	s.commitMu.Lock()
	deleted, failed := s.deleteParked(s.backupsDir(), req.Paths)
	s.commitMu.Unlock()
	writeJSON(w, http.StatusOK, struct {
		Deleted []string        `json:"deleted"`
		Failed  []parkedFailure `json:"failed"`
	}{deleted, failed})
	return nil
}

// handleBackupsReveal answers POST /api/backups/reveal: it shows the backups
// folder (or one backup in it) in the file manager.
func (s *Server) handleBackupsReveal(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Path string `json:"path"`
	}
	if err := readJSON(w, r, &req, true); err != nil {
		return err
	}
	target, isDir := s.backupsDir(), true
	if req.Path != "" {
		parts, ok := parkedRel(req.Path)
		if !ok {
			return errInvalid("invalid path")
		}
		file, _, err := parkedFile(s.backupsDir(), parts)
		if err != nil {
			return err
		}
		target, isDir = file, false
	} else if err := os.MkdirAll(target, 0o755); err != nil {
		return errIO("cannot create the backups folder: %v", err)
	}
	if err := s.opt.Host.Reveal(target, isDir); err != nil {
		return errIO("cannot open the file manager: %v", err)
	}
	return ok(w)
}
