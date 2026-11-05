package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// gr3TestDataSuffix is the data folder of the GR III test builds (0.8.0-gr3exp.1 .. 0.8.4-gr3exp.1):
// the default data folder with this suffix.
const gr3TestDataSuffix = "-GR3-Experimental"

// gr3MigratedMarker marks a data folder whose GR III work was taken over (or found not to need it).
const gr3MigratedMarker = "gr3-migrated"

// migrateGR3TestData takes over, once, the GR III / IIIx work of the GR III test builds, which kept
// their own data folder: their project becomes project-gr3.json (the UI keeps GR III's work there,
// GR IV's in project.json), their presets gr3-preset-<slot> (GR III's films reuse the slot ids CY
// and CG), their pictures are copied as they are (random ids). Nothing is taken over when this
// folder already has GR III work or the test builds' project was a GR IV one; the test builds'
// folder itself is left unchanged. Errors leave the marker unwritten, so the next start tries again.
func migrateGR3TestData(dir string) (bool, error) {
	dst := filepath.Join(dir, "store")
	marker := filepath.Join(dst, gr3MigratedMarker)
	if _, err := os.Stat(marker); err == nil {
		return false, nil
	}
	src := filepath.Join(dir+gr3TestDataSuffix, "store")
	project, err := os.ReadFile(filepath.Join(src, "project.json"))
	if os.IsNotExist(err) {
		return false, nil // no test builds here
	}
	if err != nil {
		return false, err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return false, err
	}
	done := func() error { return os.WriteFile(marker, []byte("1\n"), 0o644) }
	var doc struct {
		V     int    `json:"v"`
		Model string `json:"model"`
	}
	if json.Unmarshal(project, &doc) != nil || doc.V != 1 || (doc.Model != "GR3_HDF" && doc.Model != "GR3X_HDF") {
		return false, done()
	}
	if _, err := os.Stat(filepath.Join(dst, "project-gr3.json")); err == nil {
		return false, done()
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		name := e.Name()
		var target string
		switch {
		case strings.HasPrefix(name, "preset-"):
			target = "gr3-" + name
		case strings.HasPrefix(name, "wall-"):
			target = name
		default:
			continue
		}
		if !e.Type().IsRegular() || len(target) > 64 {
			continue
		}
		if _, err := os.Stat(filepath.Join(dst, target)); err == nil {
			continue
		}
		if err := copyFileAtomic(filepath.Join(src, name), dst, target); err != nil {
			return false, err
		}
	}
	// The project last: a folder with project-gr3.json has its presets and pictures.
	if err := writeFileAtomic(dst, "project-gr3.json", project); err != nil {
		return false, err
	}
	return true, done()
}

func copyFileAtomic(from, dir, name string) error {
	b, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return writeFileAtomic(dir, name, b)
}

// writeFileAtomic writes dir/name through a temporary file starting with a dot (never a store key).
func writeFileAtomic(dir, name string, data []byte) error {
	f, err := os.CreateTemp(dir, ".migrate-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, werr := f.Write(data)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmp)
		if werr != nil {
			return werr
		}
		return cerr
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
