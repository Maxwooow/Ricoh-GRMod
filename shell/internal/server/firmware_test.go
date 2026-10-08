package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
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
	mux := http.NewServeMux()
	mux.HandleFunc("/english/support/download_digital.html", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.lists++
		v := f.version
		f.mu.Unlock()
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
	wantStatus(t, e.do("GET", "/api/firmware/latest?model=GR3", nil), 400, codeInvalid)
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
