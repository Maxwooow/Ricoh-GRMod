package server

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"grmod/shell/internal/update"
)

// The update endpoints: the page asks whether a newer GR Mod has been
// released, has it downloaded and verified (see package update), and then
// asks for it to be installed, which replaces the program on disk and makes
// the shell start the new one.

const (
	updateCheckTimeout    = 30 * time.Second
	updateDownloadTimeout = 30 * time.Minute
	// DefaultReleasePage is shown when an update cannot be installed by the
	// program itself.
	DefaultReleasePage = "https://github.com/Maxwooow/Ricoh-GRMod/releases/latest"
)

type updateState struct {
	u *update.Updater

	mu     sync.Mutex
	info   *update.Info
	staged string // version that has been downloaded and staged

	notes releaseNotes

	downloading atomic.Bool
	installing  atomic.Bool
	received    atomic.Int64
	total       atomic.Int64
}

type updateCheckResult struct {
	*update.Info
	UpdatedFrom string `json:"updatedFrom,omitempty"`
	Ready       bool   `json:"ready"`
}

func (s *Server) updater() (*updateState, error) {
	if s.upd == nil {
		return nil, errf(http.StatusNotImplemented, codeInvalid, "this build has no updater")
	}
	return s.upd, nil
}

// handleUpdateCheck answers GET /api/update/check.
func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request) error {
	if s.upd == nil {
		writeJSON(w, http.StatusOK, updateCheckResult{Info: &update.Info{Current: s.opt.Version, Reason: update.ReasonUnsupported}, UpdatedFrom: s.opt.UpdatedFrom})
		return nil
	}
	ctx, cancel := context.WithTimeout(r.Context(), updateCheckTimeout)
	defer cancel()
	info, err := s.upd.u.Check(ctx)
	if err != nil {
		if r.Context().Err() != nil {
			return errf(statusClientClosed, codeCancelled, "request cancelled")
		}
		if errors.Is(err, update.ErrBadSignature) {
			s.opt.Log.Printf("update: %v", err)
		}
		return errf(http.StatusBadGateway, codeNetwork, "%v", err)
	}
	s.upd.mu.Lock()
	s.upd.info = info
	ready := s.upd.staged != "" && s.upd.staged == info.Latest
	s.upd.mu.Unlock()
	writeJSON(w, http.StatusOK, updateCheckResult{Info: info, UpdatedFrom: s.opt.UpdatedFrom, Ready: ready})
	return nil
}

// handleUpdateDownload answers POST /api/update/download: it downloads,
// verifies and stages the release found by the last check.
func (s *Server) handleUpdateDownload(w http.ResponseWriter, r *http.Request) error {
	st, err := s.updater()
	if err != nil {
		return err
	}
	st.mu.Lock()
	info := st.info
	st.mu.Unlock()
	if info == nil || !info.Available {
		return errInvalid("no update is available")
	}
	if !info.CanInstall {
		return errf(http.StatusConflict, codeInvalid, "this copy cannot update itself: %s", info.Reason)
	}
	if !st.downloading.CompareAndSwap(false, true) {
		return errf(http.StatusConflict, codeBusy, "a download is already running")
	}
	defer st.downloading.Store(false)
	st.received.Store(0)
	st.total.Store(info.Size)
	ctx, cancel := context.WithTimeout(r.Context(), updateDownloadTimeout)
	defer cancel()
	err = st.u.Download(ctx, info, func(n, total int64) {
		st.received.Store(n)
		st.total.Store(total)
	})
	if err != nil {
		if r.Context().Err() != nil {
			return errf(statusClientClosed, codeCancelled, "request cancelled")
		}
		if errors.Is(err, update.ErrMismatch) {
			s.opt.Log.Printf("update: %v", err)
			return errf(http.StatusBadGateway, "mismatch", "%v", err)
		}
		return errf(http.StatusBadGateway, codeNetwork, "%v", err)
	}
	st.mu.Lock()
	st.staged = info.Latest
	st.mu.Unlock()
	s.opt.Log.Printf("update: %s downloaded and verified", info.Latest)
	writeJSON(w, http.StatusOK, map[string]any{"ready": true, "version": info.Latest})
	return nil
}

// handleUpdateProgress answers GET /api/update/progress.
func (s *Server) handleUpdateProgress(w http.ResponseWriter, r *http.Request) error {
	st, err := s.updater()
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"active":   st.downloading.Load(),
		"received": st.received.Load(),
		"total":    st.total.Load(),
	})
	return nil
}

// handleUpdateInstall answers POST /api/update/install: the staged program
// replaces the running one, and the shell is asked to restart. The answer is
// sent before the restart begins.
func (s *Server) handleUpdateInstall(w http.ResponseWriter, r *http.Request) error {
	st, err := s.updater()
	if err != nil {
		return err
	}
	st.mu.Lock()
	staged := st.staged
	st.mu.Unlock()
	if staged == "" {
		return errInvalid("no update has been downloaded")
	}
	if s.opt.Restart == nil {
		return errf(http.StatusNotImplemented, codeInvalid, "this build cannot restart itself")
	}
	if !st.installing.CompareAndSwap(false, true) {
		return errf(http.StatusConflict, codeBusy, "the update is already being installed")
	}
	if err := st.u.Target.Swap(); err != nil {
		st.installing.Store(false)
		s.opt.Log.Printf("update: install failed: %v", err)
		return errIO("%v", err)
	}
	s.opt.Log.Printf("update: %s installed, restarting", staged)
	writeJSON(w, http.StatusOK, map[string]any{"restarting": true, "version": staged})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go func() {
		// Let the answer reach the page before the window goes away.
		time.Sleep(300 * time.Millisecond)
		s.opt.Restart()
	}()
	return nil
}

// handleUpdatePage answers POST /api/update/page: it shows the release page
// in the browser, for updates the program cannot install by itself.
func (s *Server) handleUpdatePage(w http.ResponseWriter, r *http.Request) error {
	opener, ok := s.opt.Host.(urlOpener)
	if !ok {
		return errf(http.StatusNotImplemented, codeInvalid, "this build cannot open a browser")
	}
	var req struct {
		Version string `json:"version"`
	}
	if err := readJSON(w, r, &req, true); err != nil {
		return err
	}
	page := DefaultReleasePage
	if s.upd != nil {
		s.upd.mu.Lock()
		if s.upd.info != nil && validPage(s.upd.info.Page) {
			page = s.upd.info.Page
		}
		s.upd.mu.Unlock()
	}
	if req.Version != "" {
		// A release's own page (what's new), on the project's release site only.
		if !releaseTag.MatchString(req.Version) {
			return errInvalid("unusable version %q", req.Version)
		}
		page = ReleasePagePrefix + "v" + req.Version
	}
	if err := opener.OpenURL(page); err != nil {
		return errIO("cannot open the browser: %v", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"page": page})
	return nil
}

// ReleasePagePrefix + "v1.2.3" is a release's page.
const ReleasePagePrefix = "https://github.com/Maxwooow/Ricoh-GRMod/releases/tag/"

var releaseTag = regexp.MustCompile(`^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$`)

// releaseNotesTTL is how long a fetched release list is reused.
const releaseNotesTTL = 10 * time.Minute

type releaseNotes struct {
	mu      sync.Mutex
	fetched time.Time
	list    []update.Release
}

// handleUpdateState answers GET /api/update/state: the running version and,
// in the first run after an update, the version it replaced. Nothing is
// fetched.
func (s *Server) handleUpdateState(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, http.StatusOK, map[string]any{"current": s.opt.Version, "updatedFrom": s.opt.UpdatedFrom})
	return nil
}

// handleUpdateNotes answers GET /api/update/notes: the published releases with
// their text, newest first, for "what's new".
func (s *Server) handleUpdateNotes(w http.ResponseWriter, r *http.Request) error {
	if s.upd == nil || s.opt.Update.ReleaseNotes == "" {
		return errf(http.StatusNotImplemented, codeInvalid, "this build has no release notes source")
	}
	n := &s.upd.notes
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.list == nil || time.Since(n.fetched) > releaseNotesTTL {
		ctx, cancel := context.WithTimeout(r.Context(), updateCheckTimeout)
		defer cancel()
		list, err := update.FetchReleases(ctx, s.upd.u.HTTP, s.opt.Update.ReleaseNotes, "GRMod/"+s.opt.Version)
		if err != nil {
			if r.Context().Err() != nil {
				return errf(statusClientClosed, codeCancelled, "request cancelled")
			}
			if n.list == nil {
				return errf(http.StatusBadGateway, codeNetwork, "%v", err)
			}
		} else {
			n.list, n.fetched = list, time.Now()
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"current": s.opt.Version, "updatedFrom": s.opt.UpdatedFrom, "releases": n.list})
	return nil
}

// validPage accepts https addresses only (the page comes from the signed
// manifest, this is belt and braces).
func validPage(p string) bool {
	return len(p) > 8 && p[:8] == "https://"
}

// UpdateOptions configures the updater.
type UpdateOptions struct {
	// Key verifies release manifests.
	Key []byte
	// Sources are the base addresses of the release files, tried in order.
	Sources []string
	// Platform selects the package (update.PlatformWindows, ...).
	Platform string
	// Target is the installed program; nil means updates are only offered.
	Target update.Target
	// LatestPage redirects to the newest release (see update.Updater).
	LatestPage string
	// ReleaseNotes is a GitHub "list releases" address, for what's new.
	ReleaseNotes string
	// Below ends this copy's line of releases (see update.Updater.Below).
	Below string
}

func newUpdateState(opt Options) *updateState {
	if opt.Update == nil {
		return nil
	}
	return &updateState{u: &update.Updater{
		Current:  opt.Version,
		Sources:  opt.Update.Sources,
		Key:      opt.Update.Key,
		Platform: opt.Update.Platform,
		HTTP:     outgoingClient(opt),
		Target:   opt.Update.Target,

		LatestPage: opt.Update.LatestPage,
		Below:      opt.Update.Below,
	}}
}
