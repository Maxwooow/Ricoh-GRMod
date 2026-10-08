package ricoh

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// The pages below follow the structure of the real ones (a list with one row
// per camera; a page per camera with a table of facts and a link to the
// archive behind the licence text).
const indexPage = `<html><body><table>
<tr><th>Model</th><th>OS</th><th>Version</th></tr>
<!-- <tr><td nowrap>GR IV</td><td><a href="digital/old.html">x</a></td><td>0.90</td></tr> -->
<tr>
	<td nowrap>GR IIIx</td>
	<td nowrap><a href="digital/gr3x_s.html" target="_top">Windows / Mac OS</a></td>
	<td align="center" nowrap>2.10</td>
</tr>
<tr>
	<td nowrap>GR&nbsp;IV</td>
	<td nowrap><a href="digital/gr4_s.html" target="_top">Windows / Mac OS</a></td>
	<td align="center" nowrap>%s</td>
</tr>
%s
</table></body></html>`

const modelPage = `<html><body>
<table>
	<tr><th width="12%%" nowrap="nowrap">Name</th><td width="88%%">Firmware Update Software for GR IV</td></tr>
	<tr><th>Registered name</th><td>Gr4_v111.zip (zip type file 33,671KB)</td></tr>
	<tr><th>Applied product</th><td>%s</td></tr>
	<tr><th>Release date</th>
		<td>2026/02/13</td></tr>
</table>
<p>For Windows/Macintosh<br /><a href="%s" onclick="gtag('event')"><img src="../image/b_accept2.gif" alt="Download"></a>
<a href="JavaScript:history.back();">back</a></p></body></html>`

func archive(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, data := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write(data)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type site struct {
	version string
	extra   string // more rows of the list
	applies string
	link    string
	zip     []byte
	hits    atomic.Int32
	noLen   bool
	// how the archive's size can be learnt: "head" (default), "range" (as the
	// real site: no length on HEAD, byte ranges work) or "page" (neither)
	sizeBy string
}

func (s *site) serve(t *testing.T) (*Client, func()) {
	mux := http.NewServeMux()
	mux.HandleFunc("/english/support/download_digital.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, indexPage, s.version, s.extra)
	})
	mux.HandleFunc("/english/support/digital/gr4_s.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, modelPage, s.applies, s.link)
	})
	mux.HandleFunc("/english/support/digital/gr4m_s.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, modelPage, "RICOH GR IV Monochrome", "/fw/gr4m_v100.zip")
	})
	mux.HandleFunc("/resources/japan/support/download/digital/FIRMWARE/gr4_v111.zip", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.Header.Get("Range") == "" {
			s.hits.Add(1)
		}
		if s.sizeBy == "range" || s.sizeBy == "page" {
			if r.Method == http.MethodHead {
				w.Header().Set("Transfer-Encoding", "chunked")
				return
			}
			if r.Header.Get("Range") != "" {
				if s.sizeBy == "page" {
					w.WriteHeader(http.StatusOK) // ranges ignored
					w.Write(s.zip)
					return
				}
				w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-0/%d", len(s.zip)))
				w.WriteHeader(http.StatusPartialContent)
				w.Write(s.zip[:1])
				return
			}
		}
		if s.noLen {
			w.Header().Set("Transfer-Encoding", "chunked")
			w.(http.Flusher).Flush()
		}
		w.Write(s.zip)
	})
	mux.HandleFunc("/fw/gr4m_v100.zip", func(w http.ResponseWriter, r *http.Request) { w.Write(s.zip) })
	srv := httptest.NewServer(mux)
	return &Client{Base: srv.URL, HTTP: srv.Client()}, srv.Close
}

func newSite(t *testing.T) *site {
	return &site{
		version: "1.11",
		applies: "RICOH GR IV / RICOH GR IV HDF",
		link:    "/resources/japan/support/download/digital/FIRMWARE/gr4_v111.zip",
		zip:     archive(t, map[string][]byte{"fwdc248b.bin": bytes.Repeat([]byte("firmware"), 4000)}),
	}
}

func TestLatest(t *testing.T) {
	s := newSite(t)
	c, done := s.serve(t)
	defer done()
	for _, model := range []string{"STANDARD", "HDF"} {
		rel, err := c.Latest(context.Background(), model)
		if err != nil {
			t.Fatalf("%s: %v", model, err)
		}
		if rel.Model != model || rel.Name != "GR IV" || rel.Version != "1.11" || rel.Date != "2026/02/13" || rel.File != "gr4_v111.zip" ||
			rel.Applies != "RICOH GR IV / RICOH GR IV HDF" || !strings.HasSuffix(rel.Page, "/english/support/digital/gr4_s.html") ||
			!strings.HasSuffix(rel.URL, "/FIRMWARE/gr4_v111.zip") || rel.Size != int64(len(s.zip)) {
			t.Errorf("%s: %+v", model, rel)
		}
	}
	// the list has no row for the Monochrome and the GR IV release does not name it
	if _, err := c.Latest(context.Background(), "MONO"); !errors.Is(err, ErrNoRelease) {
		t.Errorf("MONO: %v", err)
	}
	if _, err := c.Latest(context.Background(), "GR3"); !errors.Is(err, ErrUnknownModel) {
		t.Errorf("unknown model: %v", err)
	}
	if s.hits.Load() != 0 {
		t.Errorf("Latest fetched the archive %d times", s.hits.Load())
	}
}

func TestArchiveSize(t *testing.T) {
	for _, c := range []struct {
		by   string
		want func(s *site) int64
	}{
		{"head", func(s *site) int64 { return int64(len(s.zip)) }},
		{"range", func(s *site) int64 { return int64(len(s.zip)) }},
		{"page", func(s *site) int64 { return 33671 * 1024 }},
	} {
		s := newSite(t)
		s.sizeBy = c.by
		cl, done := s.serve(t)
		rel, err := cl.Latest(context.Background(), "STANDARD")
		if err != nil || rel.Size != c.want(s) {
			t.Errorf("%s: size %d, want %d (%v)", c.by, rel.Size, c.want(s), err)
		}
		if s.hits.Load() != 0 {
			t.Errorf("%s: the archive was fetched to learn its size", c.by)
		}
		done()
	}
	for text, want := range map[string]int64{
		"Gr4_v111.zip (zip type file 33,671KB)": 33671 * 1024, "x.zip (900 kb)": 900 * 1024, "x.zip": 0, "x.zip (12 MB)": 0, "(999,999,999,999KB)": 0,
	} {
		if got := statedSize(text); got != want {
			t.Errorf("statedSize(%q) = %d, want %d", text, got, want)
		}
	}
}

func TestLatestFollowsTheSite(t *testing.T) {
	s := newSite(t)
	s.version = "1.20"
	s.extra = `<tr><td>GR IV Monochrome</td><td><a href="digital/gr4m_s.html">Windows / Mac OS</a></td><td>1.00</td></tr>`
	c, done := s.serve(t)
	defer done()
	rel, err := c.Latest(context.Background(), "HDF")
	if err != nil || rel.Version != "1.20" {
		t.Fatalf("%+v %v", rel, err)
	}
	// a row of its own wins
	rel, err = c.Latest(context.Background(), "MONO")
	if err != nil || rel.Name != "GR IV Monochrome" || rel.Version != "1.00" || rel.File != "gr4m_v100.zip" {
		t.Fatalf("%+v %v", rel, err)
	}
	// a release that stops naming the HDF is not offered for it
	s.applies = "RICOH GR IV"
	if _, err := c.Latest(context.Background(), "HDF"); !errors.Is(err, ErrNoRelease) {
		t.Errorf("HDF: %v", err)
	}
	if rel, err := c.Latest(context.Background(), "STANDARD"); err != nil || rel.Name != "GR IV" {
		t.Errorf("STANDARD: %+v %v", rel, err)
	}
}

func TestLatestRefusesOtherHosts(t *testing.T) {
	s := newSite(t)
	s.link = "https://example.com/gr4_v111.zip"
	c, done := s.serve(t)
	defer done()
	if _, err := c.Latest(context.Background(), "STANDARD"); err == nil || !strings.Contains(err.Error(), "leaves the site") {
		t.Errorf("link to another host: %v", err)
	}
	s.link = "gr4.exe"
	if _, err := c.Latest(context.Background(), "STANDARD"); err == nil || !strings.Contains(err.Error(), "no download link") {
		t.Errorf("no archive link: %v", err)
	}
}

func TestDownload(t *testing.T) {
	for _, noLen := range []bool{false, true} {
		s := newSite(t)
		s.noLen = noLen
		c, done := s.serve(t)
		rel, err := c.Latest(context.Background(), "STANDARD")
		if err != nil {
			t.Fatal(err)
		}
		var last, total int64
		name, data, err := c.Download(context.Background(), rel, func(r, tt int64) {
			if r < last {
				t.Errorf("progress went back: %d after %d", r, last)
			}
			last, total = r, tt
		})
		if err != nil || name != "fwdc248b.bin" || len(data) != 32000 || !bytes.HasPrefix(data, []byte("firmwarefirmware")) {
			t.Errorf("noLen=%v: %q %d %v", noLen, name, len(data), err)
		}
		if last != int64(len(s.zip)) || (!noLen && total != last) || (noLen && total != 0) {
			t.Errorf("noLen=%v: progress ended at %d of %d (archive %d)", noLen, last, total, len(s.zip))
		}
		// an address that is not on the site is never fetched
		rel.URL = "https://example.com/x.zip"
		if _, _, err := c.Download(context.Background(), rel, nil); err == nil || !strings.Contains(err.Error(), "not on the site") {
			t.Errorf("foreign address: %v", err)
		}
		done()
	}
}

func TestDownloadCancelled(t *testing.T) {
	s := newSite(t)
	c, done := s.serve(t)
	defer done()
	rel, err := c.Latest(context.Background(), "STANDARD")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := c.Download(ctx, rel, nil); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled download: %v", err)
	}
}

func TestUnpack(t *testing.T) {
	fw := []byte("0123456789")
	cases := []struct {
		name  string
		files map[string][]byte
		want  string
		err   string
	}{
		{"plain", map[string][]byte{"fwdc248b.bin": fw}, "fwdc248b.bin", ""},
		{"in a folder, with a readme", map[string][]byte{"Gr4_v111/FWDC248B.BIN": fw, "Gr4_v111/readme.txt": []byte("x")}, "FWDC248B.BIN", ""},
		{"nothing", map[string][]byte{"readme.txt": []byte("x")}, "", "no firmware file"},
		{"another .bin", map[string][]byte{"setup.bin": fw}, "", "no firmware file"},
		{"two", map[string][]byte{"fwdc248b.bin": fw, "a/fwdc249b.bin": fw}, "", "more than one"},
		{"empty", map[string][]byte{"fwdc248b.bin": {}}, "", "unusable size"},
	}
	for _, c := range cases {
		name, data, err := Unpack(archive(t, c.files))
		if c.err != "" {
			if err == nil || !strings.Contains(err.Error(), c.err) {
				t.Errorf("%s: %v", c.name, err)
			}
			continue
		}
		if err != nil || name != c.want || !bytes.Equal(data, fw) {
			t.Errorf("%s: %q %q %v", c.name, name, data, err)
		}
	}
	if _, _, err := Unpack([]byte("<html>not found</html>")); err == nil || !strings.Contains(err.Error(), "not a zip") {
		t.Errorf("html instead of an archive: %v", err)
	}
}

func TestAppliesTo(t *testing.T) {
	for _, c := range []struct {
		applies, name string
		want          bool
	}{
		{"RICOH GR IV / RICOH GR IV HDF", "GR IV", true},
		{"RICOH GR IV / RICOH GR IV HDF", "GR IV HDF", true},
		{"RICOH GR IV / RICOH GR IV HDF", "GR IV Monochrome", false},
		{"RICOH GR IV, RICOH GR IV HDF, ricoh gr iv monochrome", "GR IV Monochrome", true},
		{"RICOH GR IV HDF", "GR IV", false},
		{"", "GR IV", false},
	} {
		if got := appliesTo(c.applies, c.name); got != c.want {
			t.Errorf("appliesTo(%q, %q) = %v", c.applies, c.name, got)
		}
	}
}
