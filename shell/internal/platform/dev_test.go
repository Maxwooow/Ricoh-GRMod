//go:build !windows

package platform

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDevHostVolumes(t *testing.T) {
	base := t.TempDir()
	card := filepath.Join(base, "GR_CARD")
	other := filepath.Join(base, "other")
	file := filepath.Join(base, "file.txt")
	for _, d := range []string{card, other} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(file, []byte("x"), 0o644)
	h := New()
	if h.Kind() != "dev" {
		t.Errorf("Kind = %q", h.Kind())
	}

	t.Setenv(EnvDevVolumes, "")
	if vols, err := h.Volumes(true); err != nil || vols == nil || len(vols) != 0 {
		t.Errorf("unset: %v, %v (want an empty, non-nil list)", vols, err)
	}

	sep := string(os.PathListSeparator)
	t.Setenv(EnvDevVolumes, strings.Join([]string{
		card + "/", "", filepath.Join(base, "missing"), file, other, card, // trailing slash, empty, missing, not a dir, dup
	}, sep))
	for _, all := range []bool{false, true} {
		vols, err := h.Volumes(all)
		if err != nil || len(vols) != 2 {
			t.Fatalf("all=%v: %+v, %v", all, vols, err)
		}
		v := vols[0]
		if v.ID != "GR_CARD" || v.Root != card || v.Label != "GR_CARD" || v.FS != "DEV" || !v.Removable {
			t.Errorf("first volume = %+v", v)
		}
		if vols[1].ID != "other" || vols[1].Root != other {
			t.Errorf("second volume = %+v", vols[1])
		}
		if v.Total == 0 || v.Free == 0 || v.Free > v.Total {
			t.Errorf("sizes: total %d free %d", v.Total, v.Free)
		}
	}

	// Relative entries are made absolute.
	t.Chdir(base)
	t.Setenv(EnvDevVolumes, "GR_CARD")
	if vols, _ := h.Volumes(false); len(vols) != 1 || !filepath.IsAbs(vols[0].Root) || filepath.Base(vols[0].Root) != "GR_CARD" {
		t.Errorf("relative entry: %+v", vols)
	}
}

func TestDevHostPickRevealEject(t *testing.T) {
	h := New()
	t.Setenv(EnvDevPick, "")
	if p, err := h.PickDirectory("title"); p != "" || err != nil {
		t.Errorf("unset: %q, %v", p, err)
	}
	dir := t.TempDir()
	t.Setenv(EnvDevPick, dir)
	if p, err := h.PickDirectory("title"); p != dir || err != nil {
		t.Errorf("set: %q, %v", p, err)
	}
	if err := h.Reveal(dir, true); err != nil {
		t.Errorf("Reveal = %v", err)
	}
	if err := h.Eject(Volume{ID: "x"}); !errors.Is(err, ErrUnsupported) {
		t.Errorf("Eject = %v, want ErrUnsupported", err)
	}
	if got := h.ProtectedPaths(); len(got) != 1 || got[0] != "/" {
		t.Errorf("ProtectedPaths = %v", got)
	}
}
