package server

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"grmod/shell/internal/ricoh"
)

// fakeSite stands in for Ricoh's web site.
type fakeSite struct {
	srv      *httptest.Server
	mu       sync.Mutex
	version  string
	lists    int           // how often the list page was fetched
	gate     chan struct{} // when set, the archive waits for it after its first bytes
	started  chan struct{}
	firmware []byte
	archive  []byte
	unlisted bool // the list has no GR IV row
}

func newFakeSite(t *testing.T) *fakeSite {
	t.Helper()
	f := &fakeSite{version: "1.11", firmware: make([]byte, 200_000)}
	x := uint32(1)
	for i := range f.firmware { // not compressible, so that the archive has a size worth a progress bar
		x = x*1664525 + 1013904223
		f.firmware[i] = byte(x >> 24)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("fwdc248b.bin")
	w.Write(f.firmware)
	zw.Close()
	archive := buf.Bytes()
	f.archive = archive
	mux := http.NewServeMux()
	mux.HandleFunc("/english/support/download_digital.html", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.lists++
		v := f.version
		unlisted := f.unlisted
		f.mu.Unlock()
		if unlisted {
			fmt.Fprint(w, `<table><tr><td>GR III</td><td><a href="digital/gr3_s.html">Windows / Mac OS</a></td><td>2.20</td></tr></table>`)
			return
		}
		fmt.Fprintf(w, `<table><tr><td>GR IV</td><td><a href="digital/gr4_s.html">Windows / Mac OS</a></td><td>%s</td></tr></table>`, v)
	})
	mux.HandleFunc("/english/support/digital/gr4_s.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<table><tr><th>Applied product</th><td>RICOH GR IV / RICOH GR IV HDF</td></tr><tr><th>Release date</th><td>2026/02/13</td></tr></table>
			<a href="/resources/FIRMWARE/gr4_v111.zip">Download</a>`)
	})
	mux.HandleFunc("/resources/FIRMWARE/gr4_v111.zip", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(archive)))
		if r.Method == http.MethodHead {
			return
		}
		f.mu.Lock()
		gate, started := f.gate, f.started
		f.mu.Unlock()
		if gate == nil {
			w.Write(archive)
			return
		}
		half := len(archive) / 2
		w.Write(archive[:half])
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-gate:
			w.Write(archive[half:])
		case <-r.Context().Done():
		}
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeSite) option(o *Options) { o.FirmwareSite = f.srv.URL }

// openingHost is a fakeHost that can show web pages.
type openingHost struct {
	*fakeHost
	opened []string
}

func (h *openingHost) OpenURL(address string) error {
	h.opened = append(h.opened, address)
	return nil
}

func TestFirmwareLatest(t *testing.T) {
	site := newFakeSite(t)
	now := time.Unix(1_800_000_000, 0)
	e := newEnv(t, site.option, func(o *Options) { o.Now = func() time.Time { return now } })

	for _, model := range []string{"STANDARD", "HDF"} {
		rec := e.do("GET", "/api/firmware/latest?model="+model, nil)
		if rec.Code != 200 {
			t.Fatalf("%s: %d %s", model, rec.Code, rec.Body)
		}
		var got firmwareLatest
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Model != model || got.Name != "GR IV" || got.Version != "1.11" || got.Date != "2026/02/13" || got.File != "gr4_v111.zip" ||
			got.Size == 0 || !strings.HasSuffix(got.Page, "/english/support/digital/gr4_s.html") {
			t.Errorf("%s: %+v", model, got)
		}
		if strings.Contains(rec.Body.String(), "/resources/") {
			t.Errorf("the archive's address is none of the page's business: %s", rec.Body)
		}
	}
	wantStatus(t, e.do("GET", "/api/firmware/latest?model=MONO", nil), 404, codeNotFound)
	wantStatus(t, e.do("GET", "/api/firmware/latest?model=GR2", nil), 400, codeInvalid)
	wantStatus(t, e.do("GET", "/api/firmware/latest", nil), 400, codeInvalid)
	wantStatus(t, e.do("POST", "/api/firmware/latest?model=HDF", nil), 405, codeInvalid)
	wantStatus(t, e.do("GET", "/api/firmware/latest?model=HDF", nil, noToken), 403, codeForbidden)

	// answers are remembered for a short while, then the site is asked again
	site.mu.Lock()
	lists := site.lists
	site.version = "1.20"
	site.mu.Unlock()
	if rec := e.do("GET", "/api/firmware/latest?model=HDF", nil); !strings.Contains(rec.Body.String(), `"version":"1.11"`) {
		t.Errorf("fresh answer was not reused: %s", rec.Body)
	}
	site.mu.Lock()
	if site.lists != lists {
		t.Errorf("the site was asked again within the cache time")
	}
	site.mu.Unlock()
	now = now.Add(firmwareCacheAge + time.Second)
	if rec := e.do("GET", "/api/firmware/latest?model=HDF", nil); !strings.Contains(rec.Body.String(), `"version":"1.20"`) {
		t.Errorf("stale answer was reused: %s", rec.Body)
	}
}

func TestFirmwareDownload(t *testing.T) {
	site := newFakeSite(t)
	e := newEnv(t, site.option)
	rec := e.do("POST", "/api/firmware/download", map[string]string{"model": "HDF"})
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), site.firmware) {
		t.Fatalf("%d, %d bytes", rec.Code, rec.Body.Len())
	}
	if h := rec.Header(); h.Get(HeaderFirmwareName) != "fwdc248b.bin" || h.Get(HeaderFirmwareVersion) != "1.11" || h.Get("Content-Type") != "application/octet-stream" {
		t.Errorf("headers: %v", h)
	}
	var p struct {
		Active          bool
		Received, Total int64
	}
	json.Unmarshal(e.do("GET", "/api/firmware/progress", nil).Body.Bytes(), &p)
	if p.Active || p.Received == 0 || p.Received != p.Total {
		t.Errorf("progress after a finished download: %+v", p)
	}
	wantStatus(t, e.do("POST", "/api/firmware/download", map[string]string{"model": "MONO"}), 404, codeNotFound)
	wantStatus(t, e.do("POST", "/api/firmware/download", map[string]string{"model": "x"}), 400, codeInvalid)
	wantStatus(t, e.do("POST", "/api/firmware/download", "{"), 400, codeInvalid)
	// the page cannot name an address
	wantStatus(t, e.do("POST", "/api/firmware/download", map[string]string{"url": site.srv.URL + "/resources/FIRMWARE/gr4_v111.zip"}), 400, codeInvalid)
	wantStatus(t, e.do("GET", "/api/firmware/download", nil), 405, codeInvalid)
}

func TestFirmwareDownloadOneAtATime(t *testing.T) {
	site := newFakeSite(t)
	site.gate, site.started = make(chan struct{}), make(chan struct{})
	e := newEnv(t, site.option)
	first := make(chan *httptest.ResponseRecorder)
	go func() { first <- e.do("POST", "/api/firmware/download", map[string]string{"model": "STANDARD"}) }()
	<-site.started
	// while the first one runs: progress is visible and a second one is refused
	var p struct {
		Active          bool
		Received, Total int64
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		json.Unmarshal(e.do("GET", "/api/firmware/progress", nil).Body.Bytes(), &p)
		if p.Received > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !p.Active || p.Received == 0 || p.Received >= p.Total {
		t.Errorf("progress during a download: %+v", p)
	}
	wantStatus(t, e.do("POST", "/api/firmware/download", map[string]string{"model": "STANDARD"}), 409, codeBusy)
	close(site.gate)
	if rec := <-first; rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), site.firmware) {
		t.Errorf("first download: %d", rec.Code)
	}
	site.mu.Lock()
	site.gate = nil
	site.mu.Unlock()
	if rec := e.do("POST", "/api/firmware/download", map[string]string{"model": "STANDARD"}); rec.Code != 200 {
		t.Errorf("download after the first one ended: %d %s", rec.Code, rec.Body)
	}
}

func TestFirmwareSiteDown(t *testing.T) {
	site := newFakeSite(t)
	e := newEnv(t, site.option)
	site.srv.Close()
	wantStatus(t, e.do("GET", "/api/firmware/latest?model=HDF", nil), 502, codeNetwork)
	wantStatus(t, e.do("POST", "/api/firmware/download", map[string]string{"model": "HDF"}), 502, codeNetwork)
	if rec := e.do("GET", "/api/firmware/progress", nil); !strings.Contains(rec.Body.String(), `"active":false`) {
		t.Errorf("a failed download left the endpoint busy: %s", rec.Body)
	}
}

func TestFirmwarePage(t *testing.T) {
	site := newFakeSite(t)
	// a host without a browser
	e := newEnv(t, site.option)
	wantStatus(t, e.do("POST", "/api/firmware/page", map[string]string{"model": "HDF"}), 501, codeInvalid)

	var host *openingHost
	e = newEnv(t, site.option, func(o *Options) {
		host = &openingHost{fakeHost: o.Host.(*fakeHost)}
		o.Host = host
	})
	if rec := e.do("POST", "/api/firmware/page", map[string]string{"model": "HDF"}); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if len(host.opened) != 1 || host.opened[0] != site.srv.URL+"/english/support/digital/gr4_s.html" {
		t.Errorf("opened: %v", host.opened)
	}
	wantStatus(t, e.do("POST", "/api/firmware/page", map[string]string{"model": "MONO"}), 404, codeNotFound)
	wantStatus(t, e.do("POST", "/api/firmware/page", map[string]string{"page": "https://example.com/"}), 400, codeInvalid)
	if len(host.opened) != 1 {
		t.Errorf("opened: %v", host.opened)
	}
}

// pin makes the fake site's archive the supported release.
func (f *fakeSite) pin(sum string) func(*Options) {
	return func(o *Options) {
		o.FirmwareArchive = &ricoh.Archive{
			Version: "1.11", Date: "2026/02/13", Path: "/resources/FIRMWARE/gr4_v111.zip", Size: int64(len(f.archive)),
			SHA256: sum, Models: []string{"STANDARD", "HDF"}, Applies: "RICOH GR IV / RICOH GR IV HDF", Page: "/english/support/digital/gr4_s.html",
		}
	}
}

func (f *fakeSite) sum() string {
	s := sha256.Sum256(f.archive)
	return hex.EncodeToString(s[:])
}

// The site offers a newer release: it is shown, and the supported one stays
// downloadable from its fixed address.
func TestFirmwareFallback(t *testing.T) {
	site := newFakeSite(t)
	site.version = "1.20"
	e := newEnv(t, site.option, site.pin(site.sum()))
	rec := e.do("GET", "/api/firmware/latest?model=HDF", nil)
	var got firmwareLatest
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if got.Version != "1.20" || got.Fallback == nil || got.Fallback.Version != "1.11" || got.Fallback.Date != "2026/02/13" ||
		got.Fallback.Size != int64(len(site.archive)) || got.Fallback.File != "gr4_v111.zip" {
		t.Errorf("%s", rec.Body)
	}
	if strings.Contains(rec.Body.String(), "/resources/") {
		t.Errorf("the archive's address is none of the page's business: %s", rec.Body)
	}
	rec = e.do("POST", "/api/firmware/download", map[string]string{"model": "HDF", "version": "1.11"})
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), site.firmware) || rec.Header().Get(HeaderFirmwareVersion) != "1.11" {
		t.Errorf("supported release: %d %v", rec.Code, rec.Header())
	}
	rec = e.do("POST", "/api/firmware/download", map[string]string{"model": "HDF"})
	if rec.Code != 200 || rec.Header().Get(HeaderFirmwareVersion) != "1.20" {
		t.Errorf("the site's release: %d %v", rec.Code, rec.Header())
	}
	wantStatus(t, e.do("POST", "/api/firmware/download", map[string]string{"model": "HDF", "version": "1.05"}), 404, codeNotFound)
	// the Monochrome has no supported release
	if rec := e.do("GET", "/api/firmware/latest?model=MONO", nil); rec.Code != 404 {
		t.Errorf("MONO: %d %s", rec.Code, rec.Body)
	}
	// no fallback when the site offers the supported release
	site.mu.Lock()
	site.version = "1.11"
	site.mu.Unlock()
	e = newEnv(t, site.option, site.pin(site.sum()))
	if rec := e.do("GET", "/api/firmware/latest?model=HDF", nil); strings.Contains(rec.Body.String(), "fallback") {
		t.Errorf("fallback with the supported release on the site: %s", rec.Body)
	}
}

func TestFirmwareFallbackChecksum(t *testing.T) {
	site := newFakeSite(t)
	site.version = "1.20"
	e := newEnv(t, site.option, site.pin(strings.Repeat("0", 64)))
	wantStatus(t, e.do("POST", "/api/firmware/download", map[string]string{"model": "STANDARD", "version": "1.11"}), 502, codeChecksum)
}

// The list has no row for the GR IV: the supported release is the answer.
func TestFirmwareUnlisted(t *testing.T) {
	site := newFakeSite(t)
	site.unlisted = true
	e := newEnv(t, site.option, site.pin(site.sum()))
	rec := e.do("GET", "/api/firmware/latest?model=STANDARD", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"version":"1.11"`) || strings.Contains(rec.Body.String(), "fallback") {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec := e.do("POST", "/api/firmware/download", map[string]string{"model": "STANDARD"}); rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), site.firmware) {
		t.Errorf("download: %d %s", rec.Code, rec.Body)
	}
	wantStatus(t, e.do("GET", "/api/firmware/latest?model=MONO", nil), 404, codeNotFound)
}

// GR III / IIIx: a newer release the site lists is offered with the pinned earlier one as the
// fallback (as GR IV's 1.20 with 1.11); without one, the pinned release alone.
func TestFirmwareLatestPinnedNewer(t *testing.T) {
	for _, listed := range []bool{true, false} {
		mux := http.NewServeMux()
		mux.HandleFunc("/english/support/download_digital.html", func(w http.ResponseWriter, r *http.Request) {
			if listed {
				fmt.Fprint(w, `<table><tr><td>GR III</td><td><a href="digital/gr3_s.html">Windows / Mac OS</a></td><td>2.20</td></tr></table>`)
				return
			}
			fmt.Fprint(w, `<table></table>`)
		})
		mux.HandleFunc("/english/support/digital/gr3_s.html", func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, `<table><tr><th>Applied product</th><td>RICOH GR III / RICOH GR III HDF</td></tr><tr><th>Release date</th><td>2026/10/21</td></tr></table>
				<a href="/resources/FIRMWARE/gr3_v220.zip">Download</a>`)
		})
		var mu sync.Mutex
		var got []string
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet {
				mu.Lock()
				got = append(got, r.URL.Path)
				mu.Unlock()
			}
			w.Header().Set("Content-Length", "1000")
		})
		srv := httptest.NewServer(mux)
		e := newEnv(t, func(o *Options) { o.FirmwareSite = srv.URL })
		// Both releases can be downloaded, each by its version; without one, the site's.
		last := func() string {
			mu.Lock()
			defer mu.Unlock()
			if len(got) == 0 {
				return ""
			}
			return got[len(got)-1]
		}
		e.do("POST", "/api/firmware/download", map[string]string{"model": "GR3", "version": "2.10"})
		if !strings.HasSuffix(last(), "gr3_v210.zip") {
			t.Errorf("listed=%v: 2.10 was not downloaded: %v", listed, got)
		}
		e.do("POST", "/api/firmware/download", map[string]string{"model": "GR3"})
		if want := map[bool]string{true: "gr3_v220.zip", false: "gr3_v210.zip"}[listed]; !strings.HasSuffix(last(), want) {
			t.Errorf("listed=%v: the site's release was not downloaded: %v", listed, got)
		}
		if listed {
			e.do("POST", "/api/firmware/download", map[string]string{"model": "GR3", "version": "2.20"})
			if !strings.HasSuffix(last(), "gr3_v220.zip") {
				t.Errorf("2.20 was not downloaded: %v", got)
			}
		} else {
			wantStatus(t, e.do("POST", "/api/firmware/download", map[string]string{"model": "GR3", "version": "2.20"}), 404, codeNotFound)
		}
		for _, model := range []string{"GR3", "GR3_HDF"} {
			rec := e.do("GET", "/api/firmware/latest?model="+model, nil)
			if rec.Code != 200 {
				t.Fatalf("%s: status %d %s", model, rec.Code, rec.Body)
			}
			var got struct {
				Version  string `json:"version"`
				Fallback *struct {
					Version string `json:"version"`
					File    string `json:"file"`
				} `json:"fallback"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if listed && (got.Version != "2.20" || got.Fallback == nil || got.Fallback.Version != "2.10" || got.Fallback.File != "gr3_v210.zip") {
				t.Errorf("%s listed: %s", model, rec.Body)
			}
			if !listed && (got.Version != "2.10" || got.Fallback != nil) {
				t.Errorf("%s unlisted: %s", model, rec.Body)
			}
		}
		srv.Close()
	}
}
