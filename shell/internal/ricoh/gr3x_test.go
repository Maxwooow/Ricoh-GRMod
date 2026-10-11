package ricoh

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGR3xHDFUsesItsOwnFamilyAndDownload(t *testing.T) {
	payload := []byte("GR IIIx official file supplied by the test")
	zip := archive(t, map[string][]byte{"fwdc243b.bin": payload})
	applies := "RICOH GR IIIx / RICOH GR IIIx Urban Edition / RICOH GR IIIx HDF"
	mux := http.NewServeMux()
	mux.HandleFunc(indexPath, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<table>
          <tr><td>GR IV</td><td><a href="digital/gr4_s.html">Download</a></td><td>1.11</td></tr>
          <tr><td>GR IIIx</td><td><a href="digital/gr3x_s.html">Download</a></td><td>1.60</td></tr>
        </table>`)
	})
	mux.HandleFunc("/english/support/digital/gr4_s.html", func(w http.ResponseWriter, r *http.Request) {
		t.Error("IIIx lookup must never fall back to a GR IV release")
		http.Error(w, "wrong family", 500)
	})
	mux.HandleFunc("/english/support/digital/gr3x_s.html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `<table><tr><th>Applied product</th><td>%s</td></tr></table><a href="/gr3x_v160.zip">Download</a>`, applies)
	})
	mux.HandleFunc("/gr3x_v160.zip", func(w http.ResponseWriter, r *http.Request) { w.Write(zip) })
	server := httptest.NewServer(mux)
	defer server.Close()
	client := &Client{Base: server.URL, HTTP: server.Client()}
	rel, err := client.Latest(context.Background(), "GR3X_HDF")
	if err != nil {
		t.Fatal(err)
	}
	if rel.Name != "GR IIIx" || rel.Version != "1.60" || !strings.HasSuffix(rel.URL, "/gr3x_v160.zip") {
		t.Fatalf("wrong IIIx release: %+v", rel)
	}
	name, data, err := client.Download(context.Background(), rel, nil)
	if err != nil || name != "fwdc243b.bin" || string(data) != string(payload) {
		t.Fatalf("wrong IIIx download: %s %q %v", name, data, err)
	}
	applies = "RICOH GR IIIx" // A shared file is not assumed to support HDF unless Ricoh says so.
	if _, err := client.Latest(context.Background(), "GR3X_HDF"); err != ErrNoRelease {
		t.Fatalf("missing explicit HDF compatibility: %v", err)
	}
}
