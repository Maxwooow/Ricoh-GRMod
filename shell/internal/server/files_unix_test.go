//go:build !windows

package server

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

var crossDeviceErrno = syscall.EXDEV

// Special files are never opened: reading a FIFO would block forever.
func TestSpecialFilesAreRefused(t *testing.T) {
	e := newEnv(t)
	fifo := filepath.Join(e.card, "pipe")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Skipf("cannot create a FIFO: %v", err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		wantStatus(t, e.do("GET", q("/api/read", "path", fifo), nil), 400, "invalid")
		wantStatus(t, e.do("PUT", q("/api/write", "path", fifo), "x"), 400, "invalid")
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("request on a FIFO blocked")
	}
	if fi, err := os.Lstat(fifo); err != nil || fi.Mode()&os.ModeNamedPipe == 0 {
		t.Error("the FIFO was replaced")
	}
	noTempFiles(t, e.card)
}

// A write that cannot create its temporary file fails cleanly.
func TestWriteIntoReadOnlyDirectory(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	e := newEnv(t)
	dir := filepath.Join(e.card, "ro")
	os.Mkdir(dir, 0o555)
	defer os.Chmod(dir, 0o755)
	wantStatus(t, e.do("PUT", q("/api/write", "path", filepath.Join(dir, "f.bin")), "x"), 500, "io")
	noTempFiles(t, e.card)
}
