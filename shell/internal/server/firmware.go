package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"grmod/shell/internal/ricoh"
)

// The firmware endpoints let the page fetch the current official firmware
// update from Ricoh's site, which a web page cannot do by itself (the site
// sends no CORS headers). The page only names a camera model; every address
// comes from the site's own pages and stays on its host (see package ricoh).

const (
	codeBusy    = "busy"
	codeNetwork = "network"

	firmwareLookupTimeout   = 40 * time.Second
	firmwareDownloadTimeout = 30 * time.Minute
	firmwareCacheAge        = 10 * time.Minute
)

// HeaderFirmwareName and HeaderFirmwareVersion describe the body of
// POST /api/firmware/download.
const (
	HeaderFirmwareName    = "X-GRMod-Firmware-Name"
	HeaderFirmwareVersion = "X-GRMod-Firmware-Version"
)

// urlOpener is implemented by hosts that can show a web page in a browser.
type urlOpener interface {
	OpenURL(address string) error
}

// proxyChooser is implemented by hosts that know the system's proxy.
type proxyChooser interface {
	Proxy(*http.Request) (*url.URL, error)
}

// firmwareSource is the state behind the firmware endpoints.
type firmwareSource struct {
	client ricoh.Client

	mu     sync.Mutex
	cached map[string]cachedRelease

	downloading atomic.Bool
	received    atomic.Int64
	total       atomic.Int64
}

type cachedRelease struct {
	rel  *ricoh.Release
	when time.Time
}

func newFirmwareSource(opt Options) *firmwareSource {
	proxy := http.ProxyFromEnvironment
	if p, ok := opt.Host.(proxyChooser); ok {
		proxy = p.Proxy
	}
	transport := &http.Transport{
		Proxy:                 proxy,
		DialContext:           (&net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   20 * time.Second,
		ResponseHeaderTimeout: 40 * time.Second,
		IdleConnTimeout:       60 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	return &firmwareSource{
		client: ricoh.Client{Base: opt.FirmwareSite, HTTP: &http.Client{Transport: transport}},
		cached: map[string]cachedRelease{},
	}
}

// release returns what the site offers for a model, asking the site unless
// it was asked a moment ago.
func (f *firmwareSource) release(ctx context.Context, model string, now time.Time) (*ricoh.Release, error) {
	f.mu.Lock()
	c, ok := f.cached[model]
	f.mu.Unlock()
	if ok && now.Sub(c.when) < firmwareCacheAge {
		return c.rel, nil
	}
	ctx, cancel := context.WithTimeout(ctx, firmwareLookupTimeout)
	defer cancel()
	rel, err := f.client.Latest(ctx, model)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	f.cached[model] = cachedRelease{rel: rel, when: now}
	f.mu.Unlock()
	return rel, nil
}

// firmwareError maps the errors of package ricoh to API errors.
func firmwareError(r *http.Request, err error) error {
	switch {
	case errors.Is(err, ricoh.ErrUnknownModel):
		return errInvalid("unknown model")
	case errors.Is(err, ricoh.ErrNoRelease):
		return errNotFound("no firmware is listed for this model")
	case r.Context().Err() != nil:
		return errf(statusClientClosed, codeCancelled, "request cancelled")
	}
	return errf(http.StatusBadGateway, codeNetwork, "%v", err)
}

type firmwareLatest struct {
	Model   string `json:"model"`
	Name    string `json:"name"`
	Applies string `json:"applies"`
	Version string `json:"version"`
	Date    string `json:"date"`
	Page    string `json:"page"`
	File    string `json:"file"`
	Size    int64  `json:"size"`
}

func (s *Server) now() time.Time {
	if s.opt.Now != nil {
		return s.opt.Now()
	}
	return time.Now()
}

// handleFirmwareLatest answers GET /api/firmware/latest?model=HDF.
func (s *Server) handleFirmwareLatest(w http.ResponseWriter, r *http.Request) error {
	rel, err := s.firmware.release(r.Context(), r.URL.Query().Get("model"), s.now())
	if err != nil {
		return firmwareError(r, err)
	}
	writeJSON(w, http.StatusOK, firmwareLatest{
		Model: rel.Model, Name: rel.Name, Applies: rel.Applies, Version: rel.Version,
		Date: rel.Date, Page: rel.Page, File: rel.File, Size: rel.Size,
	})
	return nil
}

type firmwareRequest struct {
	Model string `json:"model"`
}

func (s *Server) firmwareModel(w http.ResponseWriter, r *http.Request) (string, error) {
	var req firmwareRequest
	body := http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		return "", errInvalid("malformed request body")
	}
	if _, ok := ricoh.Models[req.Model]; !ok {
		return "", errInvalid("unknown model")
	}
	return req.Model, nil
}

// handleFirmwareDownload answers POST /api/firmware/download {"model":...}
// with the firmware file itself. One download runs at a time.
func (s *Server) handleFirmwareDownload(w http.ResponseWriter, r *http.Request) error {
	model, err := s.firmwareModel(w, r)
	if err != nil {
		return err
	}
	f := s.firmware
	if !f.downloading.CompareAndSwap(false, true) {
		return errf(http.StatusConflict, codeBusy, "a download is already running")
	}
	defer f.downloading.Store(false)
	f.received.Store(0)
	f.total.Store(0)

	rel, err := f.release(r.Context(), model, s.now())
	if err != nil {
		return firmwareError(r, err)
	}
	f.total.Store(rel.Size)
	ctx, cancel := context.WithTimeout(r.Context(), firmwareDownloadTimeout)
	defer cancel()
	name, data, err := f.client.Download(ctx, rel, func(received, total int64) {
		f.received.Store(received)
		if total > 0 {
			f.total.Store(total)
		}
	})
	if err != nil {
		return firmwareError(r, err)
	}
	if int64(len(data)) > s.opt.MaxBytes {
		return errTooLarge(s.opt.MaxBytes)
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.Itoa(len(data)))
	h.Set(HeaderFirmwareName, name)
	h.Set(HeaderFirmwareVersion, rel.Version)
	w.WriteHeader(http.StatusOK)
	_, err = w.Write(data)
	return err
}

// handleFirmwareProgress answers GET /api/firmware/progress.
func (s *Server) handleFirmwareProgress(w http.ResponseWriter, r *http.Request) error {
	f := s.firmware
	writeJSON(w, http.StatusOK, map[string]any{
		"active":   f.downloading.Load(),
		"received": f.received.Load(),
		"total":    f.total.Load(),
	})
	return nil
}

// handleFirmwarePage answers POST /api/firmware/page {"model":...}: it shows
// the model's download page (with Ricoh's licence terms) in the browser.
func (s *Server) handleFirmwarePage(w http.ResponseWriter, r *http.Request) error {
	model, err := s.firmwareModel(w, r)
	if err != nil {
		return err
	}
	opener, ok := s.opt.Host.(urlOpener)
	if !ok {
		return errf(http.StatusNotImplemented, codeInvalid, "this build cannot open a browser")
	}
	rel, err := s.firmware.release(r.Context(), model, s.now())
	if err != nil {
		return firmwareError(r, err)
	}
	if err := opener.OpenURL(rel.Page); err != nil {
		return errIO("cannot open the browser: %v", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"page": rel.Page})
	return nil
}
