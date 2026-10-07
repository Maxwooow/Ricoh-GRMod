// Package logfile is an append-only log file that is rotated by size.
package logfile

import (
	"os"
	"path/filepath"
	"sync"
)

// DefaultMaxBytes is the size above which the log is rotated.
const DefaultMaxBytes = 1 << 20

// File appends to a log file. When the file would grow beyond the limit it
// is renamed to "<name>.1" (replacing an older one) and started afresh, so at
// most two files exist. It is safe for concurrent use.
//
// A failed rotation (on Windows the rename fails while another process has
// the file open) is not an error: writing simply continues in the old file
// and rotation is attempted again later.
type File struct {
	mu   sync.Mutex
	path string
	max  int64
	f    *os.File
	size int64
}

// Open opens (creating it and its directory if needed) the log file at path.
// A file that is already over the limit is rotated right away.
func Open(path string, maxBytes int64) (*File, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	l := &File{path: path, max: maxBytes}
	if err := l.open(); err != nil {
		return nil, err
	}
	if l.size > l.max {
		l.rotate()
	}
	return l, nil
}

func (l *File) open() error {
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	l.f, l.size = f, fi.Size()
	return nil
}

// rotate must be called with the lock held (or before the File is shared).
func (l *File) rotate() {
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
	// Rename replaces an existing "<name>.1" on every platform.
	_ = os.Rename(l.path, l.path+".1")
	if err := l.open(); err != nil {
		l.f, l.size = nil, 0
	}
}

// Write appends p, rotating first when the limit would be exceeded.
func (l *File) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		if err := l.open(); err != nil {
			return 0, err
		}
	}
	if l.size > 0 && l.size+int64(len(p)) > l.max {
		l.rotate()
		if l.f == nil {
			return 0, os.ErrClosed
		}
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}

// Close closes the file.
func (l *File) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}
