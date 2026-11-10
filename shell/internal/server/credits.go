package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// The acknowledgements shown in the About dialog (0.8.11) come from a JSON
// file the project keeps on GitHub, so that names can be added without a
// release. The page shows its own built-in list when none of the addresses
// answers; whatever is fetched is checked here and handed on as data only.

const (
	creditsTTL     = 30 * time.Minute
	creditsTimeout = 12 * time.Second
	maxCreditsJSON = 256 << 10
	maxCreditsText = 400
	maxCreditsItem = 500
)

// CreditsFile is the acknowledgements file (credits.json).
type CreditsFile struct {
	Version  int              `json:"version"`
	Updated  string           `json:"updated,omitempty"`
	Sections []CreditsSection `json:"sections"`
}

// CreditsSection is one heading and its names.
type CreditsSection struct {
	Title  map[string]string `json:"title"`
	People []CreditsPerson   `json:"people"`
}

// CreditsPerson is one name, an optional note per language and an optional https link.
type CreditsPerson struct {
	Name string            `json:"name"`
	Note map[string]string `json:"note,omitempty"`
	URL  string            `json:"url,omitempty"`
}

type creditsCache struct {
	mu      sync.Mutex
	file    *CreditsFile
	source  string
	fetched time.Time
}

// ParseCredits reads and checks an acknowledgements file: version 1, at most
// a few hundred names, short texts, links https only (others are dropped).
func ParseCredits(data []byte) (*CreditsFile, error) {
	if len(data) > maxCreditsJSON {
		return nil, fmt.Errorf("credits: too large")
	}
	var f CreditsFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("credits: %w", err)
	}
	if f.Version != 1 {
		return nil, fmt.Errorf("credits: version %d", f.Version)
	}
	if len(f.Sections) == 0 || len(f.Sections) > 20 {
		return nil, fmt.Errorf("credits: %d sections", len(f.Sections))
	}
	short := func(m map[string]string) bool {
		if len(m) > 30 {
			return false
		}
		for k, v := range m {
			if len(k) > 16 || len(v) > maxCreditsText {
				return false
			}
		}
		return true
	}
	people := 0
	for i := range f.Sections {
		sec := &f.Sections[i]
		if !short(sec.Title) || len(sec.Title) == 0 {
			return nil, fmt.Errorf("credits: section %d title", i+1)
		}
		people += len(sec.People)
		for j := range sec.People {
			p := &sec.People[j]
			p.Name = strings.TrimSpace(p.Name)
			if p.Name == "" || len(p.Name) > 100 || !short(p.Note) {
				return nil, fmt.Errorf("credits: section %d name %d", i+1, j+1)
			}
			if p.URL != "" && (!strings.HasPrefix(p.URL, "https://") || len(p.URL) > 300) {
				p.URL = ""
			}
		}
	}
	if people > maxCreditsItem {
		return nil, fmt.Errorf("credits: %d names", people)
	}
	return &f, nil
}

func fetchCredits(ctx context.Context, client *http.Client, address, agent string) (*CreditsFile, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", agent)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", address, res.Status)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxCreditsJSON+1))
	if err != nil {
		return nil, err
	}
	return ParseCredits(data)
}

// handleCredits answers GET /api/credits: the acknowledgements file from the
// first address that gives a valid one (kept for creditsTTL; the last good
// one is kept when none answers later).
func (s *Server) handleCredits(w http.ResponseWriter, r *http.Request) error {
	if len(s.opt.Credits) == 0 {
		return errf(http.StatusNotImplemented, codeInvalid, "this build has no acknowledgements source")
	}
	c := &s.credits
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.file == nil || time.Since(c.fetched) > creditsTTL {
		var last error
		for _, address := range s.opt.Credits {
			ctx, cancel := context.WithTimeout(r.Context(), creditsTimeout)
			f, err := fetchCredits(ctx, s.creditsClient, address, "GRMod/"+s.opt.Version)
			cancel()
			if err == nil {
				c.file, c.source, c.fetched = f, address, time.Now()
				last = nil
				break
			}
			last = err
			if r.Context().Err() != nil {
				return errf(statusClientClosed, codeCancelled, "request cancelled")
			}
		}
		if last != nil && c.file == nil {
			return errf(http.StatusBadGateway, codeNetwork, "%v", last)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"credits": c.file, "source": c.source})
	return nil
}
