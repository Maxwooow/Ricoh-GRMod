package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

func TestParseCreditsFile(t *testing.T) {
	data, err := os.ReadFile("../../../credits.json")
	if err != nil {
		t.Fatal(err)
	}
	f, err := ParseCredits(data)
	if err != nil {
		t.Fatalf("the repository's credits.json: %v", err)
	}
	if len(f.Sections) < 2 || f.Sections[0].Title["zh"] == "" {
		t.Fatalf("sections: %+v", f.Sections)
	}
	for _, bad := range []string{
		`{"version":2,"sections":[{"title":{"en":"x"},"people":[{"name":"a"}]}]}`,
		`{"version":1,"sections":[]}`,
		`{"version":1,"sections":[{"title":{},"people":[{"name":"a"}]}]}`,
		`{"version":1,"sections":[{"title":{"en":"x"},"people":[{"name":" "}]}]}`,
		`not json`,
	} {
		if _, err := ParseCredits([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	f, err = ParseCredits([]byte(`{"version":1,"sections":[{"title":{"en":"x"},"people":[{"name":"a","url":"javascript:alert(1)"}]}]}`))
	if err != nil || f.Sections[0].People[0].URL != "" {
		t.Fatalf("a link that is not https is dropped: %v %+v", err, f)
	}
}

func TestCreditsEndpoint(t *testing.T) {
	var hits atomic.Int32
	good := `{"version":1,"updated":"2026-11-10","sections":[{"title":{"zh":"鸣谢","en":"Thanks"},"people":[{"name":"someone"}]}]}`
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", http.StatusNotFound) }))
	defer down.Close()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Write([]byte(good))
	}))
	defer up.Close()
	e := newEnv(t, func(o *Options) { o.Credits = []string{down.URL, up.URL} })
	e.srv.creditsClient = http.DefaultClient
	rec := e.do("GET", "/api/credits", nil)
	wantStatus(t, rec, 200, "")
	var body struct {
		Credits CreditsFile `json:"credits"`
		Source  string      `json:"source"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Source != up.URL || body.Credits.Sections[0].People[0].Name != "someone" {
		t.Fatalf("got %+v", body)
	}
	// cached: no second fetch
	wantStatus(t, e.do("GET", "/api/credits", nil), 200, "")
	if hits.Load() != 1 {
		t.Fatalf("%d fetches", hits.Load())
	}
	// no source answers and nothing kept: 502
	e2 := newEnv(t, func(o *Options) { o.Credits = []string{down.URL} })
	e2.srv.creditsClient = http.DefaultClient
	wantStatus(t, e2.do("GET", "/api/credits", nil), 502, codeNetwork)
	// none configured
	e3 := newEnv(t)
	rec = e3.do("GET", "/api/credits", nil)
	if rec.Code != http.StatusNotImplemented || !strings.Contains(rec.Body.String(), "acknowledgements") {
		t.Fatalf("no sources: %d %s", rec.Code, rec.Body.String())
	}
}
