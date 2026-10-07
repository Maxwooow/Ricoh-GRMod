package logfile

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestAppendAndReopen(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "log.txt")
	l, err := Open(p, 1000)
	if err != nil {
		t.Fatal(err)
	}
	l.Write([]byte("one\n"))
	l.Close()
	l, err = Open(p, 1000)
	if err != nil {
		t.Fatal(err)
	}
	l.Write([]byte("two\n"))
	l.Close()
	if got := read(t, p); got != "one\ntwo\n" {
		t.Errorf("log = %q", got)
	}
	if _, err := os.Stat(p + ".1"); !os.IsNotExist(err) {
		t.Errorf("unexpected rotation: %v", err)
	}
}

func TestRotateOnWrite(t *testing.T) {
	p := filepath.Join(t.TempDir(), "log.txt")
	l, err := Open(p, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	line := strings.Repeat("a", 59) + "\n" // 60 bytes
	l.Write([]byte(line))
	l.Write([]byte(line)) // would reach 120 > 100: rotate first
	if got := read(t, p+".1"); got != line {
		t.Errorf("rotated file = %d bytes, want 60", len(got))
	}
	if got := read(t, p); got != line {
		t.Errorf("current file = %d bytes, want 60", len(got))
	}
	// A second rotation replaces the first backup.
	second := strings.Repeat("b", 59) + "\n"
	l.Write([]byte(second))
	if got := read(t, p+".1"); got != line {
		t.Errorf("backup after 2nd rotation = %q", got[:5])
	}
	if got := read(t, p); got != second {
		t.Errorf("current after 2nd rotation = %q", got[:5])
	}
	entries, _ := os.ReadDir(filepath.Dir(p))
	if len(entries) != 2 {
		t.Errorf("expected exactly log.txt and log.txt.1, got %d files", len(entries))
	}
}

func TestRotateOnOpenWhenTooLarge(t *testing.T) {
	p := filepath.Join(t.TempDir(), "log.txt")
	big := bytes.Repeat([]byte("x"), 500)
	if err := os.WriteFile(p, big, 0o644); err != nil {
		t.Fatal(err)
	}
	l, err := Open(p, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	l.Write([]byte("fresh\n"))
	if got := read(t, p); got != "fresh\n" {
		t.Errorf("current = %q", got)
	}
	if got := read(t, p+".1"); len(got) != 500 {
		t.Errorf("backup = %d bytes", len(got))
	}
}

func TestOversizedSingleWriteIsKept(t *testing.T) {
	p := filepath.Join(t.TempDir(), "log.txt")
	l, err := Open(p, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	msg := "a line longer than the whole limit\n"
	if n, err := l.Write([]byte(msg)); err != nil || n != len(msg) {
		t.Fatalf("Write = %d, %v", n, err)
	}
	if got := read(t, p); got != msg {
		t.Errorf("current = %q", got)
	}
}

func TestConcurrentWrites(t *testing.T) {
	p := filepath.Join(t.TempDir(), "log.txt")
	l, err := Open(p, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				l.Write([]byte("0123456789\n"))
			}
		}()
	}
	wg.Wait()
	l.Close()
	if got := read(t, p); len(got) != 20*50*11 || strings.Count(got, "0123456789\n") != 1000 {
		t.Errorf("log has %d bytes", len(got))
	}
}
