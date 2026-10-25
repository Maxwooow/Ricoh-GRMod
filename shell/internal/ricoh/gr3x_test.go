package ricoh

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// GR III / IIIx support is built on exact older releases; the site's current release (a
// different program) must never be offered for them, and no GR IV page may be consulted.
func TestGR3FamilyUsesPinnedReleases(t *testing.T) {
	cases := []struct{ model, name, version, file, inner string }{
		{"GR3X_HDF", "GR IIIx", "1.60", "gr3x_v160.zip", "fwdc243b.bin"},
		{"GR3_HDF", "GR III", "2.10", "gr3_v210.zip", "fwdc239b.bin"},
	}
	for _, c := range cases {
		payload := []byte(c.name + " official file supplied by the test")
		zip := archive(t, map[string][]byte{c.inner: payload})
		mux := http.NewServeMux()
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			t.Errorf("%s: unexpected request %s", c.model, r.URL.Path)
			http.Error(w, "unexpected", 500)
		})
		mux.HandleFunc("/resources/japan/support/download/digital/FIRMWARE/"+c.file, func(w http.ResponseWriter, r *http.Request) { w.Write(zip) })
		server := httptest.NewServer(mux)
		client := &Client{Base: server.URL, HTTP: server.Client()}
		rel, err := client.Latest(context.Background(), c.model)
		if err != nil {
			t.Fatal(err)
		}
		if rel.Model != c.model || rel.Name != c.name || rel.Version != c.version || rel.File != c.file ||
			!strings.HasSuffix(rel.URL, "/FIRMWARE/"+c.file) || !strings.HasPrefix(rel.URL, server.URL) || rel.Size != int64(len(zip)) {
			t.Fatalf("wrong pinned release: %+v", rel)
		}
		name, data, err := client.Download(context.Background(), rel, nil)
		if err != nil || name != c.inner || string(data) != string(payload) {
			t.Fatalf("wrong download: %s %q %v", name, data, err)
		}
		server.Close()
	}
}
