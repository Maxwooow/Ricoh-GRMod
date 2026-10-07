//go:build !windows

package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"grmod/shell/internal/platform"
)

// newDevEnv is like newEnv but with the real development host, which takes
// its volumes and its "picked" folder from the environment.
func newDevEnv(t *testing.T) *env {
	t.Helper()
	t.Setenv(platform.EnvDevVolumes, "")
	t.Setenv(platform.EnvDevPick, "")
	return newEnv(t, func(o *Options) { o.Host = platform.New() })
}

func TestDevVolumesFromEnvironment(t *testing.T) {
	e := newDevEnv(t)
	type resp struct {
		Volumes []platform.Volume `json:"volumes"`
	}
	if got := decode[resp](t, e.do("GET", "/api/volumes", nil)); len(got.Volumes) != 0 {
		t.Fatalf("volumes without %s: %+v", platform.EnvDevVolumes, got.Volumes)
	}
	file := filepath.Join(e.card, "a.txt")
	e.writeFile(file, "x")
	wantStatus(t, e.do("GET", q("/api/read", "path", file), nil), 403, "forbidden")

	// Two volumes, one path that does not exist, and one that must never
	// be offered because the data directory lives in it.
	list := []string{e.card, filepath.Join(e.base, "missing"), e.disk, e.base}
	t.Setenv(platform.EnvDevVolumes, strings.Join(list, string(os.PathListSeparator)))

	for _, target := range []string{"/api/volumes", "/api/volumes?all=1"} {
		got := decode[resp](t, e.do("GET", target, nil)).Volumes
		if len(got) != 2 {
			t.Fatalf("%s = %+v, want card and disk", target, got)
		}
		for i, want := range []string{"card", "disk"} {
			v := got[i]
			if v.ID != want || v.Root != filepath.Join(e.base, want) || v.FS != "DEV" || !v.Removable || v.Label != want {
				t.Errorf("volume %d = %+v", i, v)
			}
			if v.Total == 0 || v.Free > v.Total {
				t.Errorf("volume %d sizes: total %d free %d", i, v.Total, v.Free)
			}
		}
	}

	// The volumes are allowed roots; everything else stays forbidden.
	wantStatus(t, e.do("GET", q("/api/read", "path", file), nil), 200, "")
	wantStatus(t, e.do("PUT", q("/api/write", "path", filepath.Join(e.disk, "n.bin")), "n"), 200, "")
	wantStatus(t, e.do("GET", q("/api/list", "path", e.base), nil), 403, "forbidden")
	wantStatus(t, e.do("GET", q("/api/list", "path", e.outside), nil), 403, "forbidden")
	wantStatus(t, e.do("GET", q("/api/list", "path", e.data), nil), 403, "forbidden")
	wantStatus(t, e.do("GET", q("/api/list", "path", "/"), nil), 403, "forbidden")

	// "/" as a development volume is refused as well.
	t.Setenv(platform.EnvDevVolumes, "/")
	if got := decode[resp](t, e.do("GET", "/api/volumes?all=1", nil)); len(got.Volumes) != 0 {
		t.Errorf("/ was offered as a volume: %+v", got.Volumes)
	}
	wantStatus(t, e.do("GET", q("/api/list", "path", "/etc"), nil), 403, "forbidden")
}

func TestDevPickDirectory(t *testing.T) {
	e := newDevEnv(t)
	picked := filepath.Join(e.outside, "presets")
	e.writeFile(filepath.Join(picked, "a.xmp"), "xmp")

	rec := e.do("POST", "/api/pick-directory", map[string]string{"title": "x"})
	wantStatus(t, rec, 200, "")
	if strings.TrimSpace(rec.Body.String()) != `{"path":""}` {
		t.Errorf("without %s: %s", platform.EnvDevPick, rec.Body.String())
	}
	wantStatus(t, e.do("GET", q("/api/list", "path", picked), nil), 403, "forbidden")

	t.Setenv(platform.EnvDevPick, picked)
	rec = e.do("POST", "/api/pick-directory", map[string]string{"title": "x"})
	wantStatus(t, rec, 200, "")
	if got := decode[pathRequest](t, rec).Path; got != picked {
		t.Errorf("picked = %q, want %q", got, picked)
	}
	wantStatus(t, e.do("GET", q("/api/list", "path", picked), nil), 200, "")
	wantStatus(t, e.do("GET", q("/api/read", "path", filepath.Join(picked, "a.xmp")), nil), 200, "")
	wantStatus(t, e.do("GET", q("/api/list", "path", e.outside), nil), 403, "forbidden")

	// The folder stays allowed for the rest of the run.
	t.Setenv(platform.EnvDevPick, "")
	wantStatus(t, e.do("GET", q("/api/list", "path", picked), nil), 200, "")
}

func TestDevRevealAndEject(t *testing.T) {
	e := newDevEnv(t)
	t.Setenv(platform.EnvDevVolumes, e.card)
	wantStatus(t, e.do("POST", "/api/reveal", map[string]string{"path": e.card}), 200, "")
	wantStatus(t, e.do("POST", "/api/eject", map[string]string{"id": "card"}), 501, "invalid")
	wantStatus(t, e.do("POST", "/api/eject", map[string]string{"id": "nope"}), 404, "not-found")
}
