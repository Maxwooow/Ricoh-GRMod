//go:build !windows

package server

import "os"

// renameFile atomically renames oldpath to newpath, replacing a file that is
// already there.
func renameFile(oldpath, newpath string) error { return os.Rename(oldpath, newpath) }
