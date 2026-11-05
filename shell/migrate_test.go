package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeStore(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	store := filepath.Join(dir, "store")
	if err := os.MkdirAll(store, 0o755); err != nil {
		t.Fatal(err)
	}
	for k, v := range files {
		if err := os.WriteFile(filepath.Join(store, k), []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func readStore(t *testing.T, dir, key string) (string, bool) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "store", key))
	if os.IsNotExist(err) {
		return "", false
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(b), true
}

func TestMigrateGR3TestData(t *testing.T) {
	base := filepath.Join(t.TempDir(), "GRMod")
	gr3 := `{"v":1,"model":"GR3_HDF","slots":{"CY":{"names":{"en":"Film"}}}}`
	writeStore(t, base+gr3TestDataSuffix, map[string]string{
		"project.json": gr3, "preset-cy": "three", "wall-abc": "jpeg", "firmware.bin": "fw", "builds.json": "[]",
	})
	writeStore(t, base, map[string]string{"project.json": `{"v":1,"model":"HDF"}`, "preset-cy": "four"})
	moved, err := migrateGR3TestData(base)
	if err != nil || !moved {
		t.Fatalf("moved %v, err %v", moved, err)
	}
	for key, want := range map[string]string{"project-gr3.json": gr3, "gr3-preset-cy": "three", "wall-abc": "jpeg", "preset-cy": "four", "project.json": `{"v":1,"model":"HDF"}`} {
		if got, ok := readStore(t, base, key); !ok || got != want {
			t.Errorf("%s = %q (%v), want %q", key, got, ok, want)
		}
	}
	if _, ok := readStore(t, base, "firmware.bin"); ok {
		t.Error("the test builds' firmware file is not taken over")
	}
	// Once only: later changes in the test builds' folder are not taken over again.
	writeStore(t, base+gr3TestDataSuffix, map[string]string{"preset-cg": "later"})
	if moved, err := migrateGR3TestData(base); err != nil || moved {
		t.Fatalf("second run: moved %v, err %v", moved, err)
	}
	if _, ok := readStore(t, base, "gr3-preset-cg"); ok {
		t.Error("taken over twice")
	}
	// The test builds' folder is left as it was.
	if got, _ := readStore(t, base+gr3TestDataSuffix, "preset-cy"); got != "three" {
		t.Error("the test builds' folder changed")
	}
}

func TestMigrateGR3TestDataSkips(t *testing.T) {
	// No test builds: nothing, and no marker (so a later install of them is not missed... nor needed).
	base := filepath.Join(t.TempDir(), "GRMod")
	if moved, err := migrateGR3TestData(base); err != nil || moved {
		t.Fatalf("moved %v, err %v", moved, err)
	}
	// A GR IV project in the test builds' folder: GR IV work is not GR III's.
	writeStore(t, base+gr3TestDataSuffix, map[string]string{"project.json": `{"v":1,"model":"HDF"}`, "preset-cy": "four"})
	if moved, err := migrateGR3TestData(base); err != nil || moved {
		t.Fatalf("GR IV project: moved %v, err %v", moved, err)
	}
	if _, ok := readStore(t, base, "gr3-preset-cy"); ok {
		t.Error("GR IV preset taken as GR III's")
	}
	// GR III work already here: kept.
	other := filepath.Join(t.TempDir(), "GRMod")
	writeStore(t, other+gr3TestDataSuffix, map[string]string{"project.json": `{"v":1,"model":"GR3X_HDF"}`, "preset-cy": "old"})
	writeStore(t, other, map[string]string{"project-gr3.json": `{"v":1}`, "gr3-preset-cy": "new"})
	if moved, err := migrateGR3TestData(other); err != nil || moved {
		t.Fatalf("existing work: moved %v, err %v", moved, err)
	}
	if got, _ := readStore(t, other, "gr3-preset-cy"); got != "new" {
		t.Error("existing GR III work replaced")
	}
}
