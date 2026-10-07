//go:build windows

package server

import (
	"errors"
	"os"
	"syscall"
	"time"
)

// Errors that a rename gets on Windows while another program (typically the
// virus scanner or the search indexer, which look at every freshly written
// file) still has the source or the destination open.
const (
	errorAccessDenied     = syscall.Errno(5)
	errorSharingViolation = syscall.Errno(32)
	errorLockViolation    = syscall.Errno(33)
)

// renameFile atomically renames oldpath to newpath, replacing a file that is
// already there. Transient "file in use" failures are retried for up to
// about two seconds before giving up.
func renameFile(oldpath, newpath string) error {
	var err error
	for attempt := 0; attempt < 12; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 30 * time.Millisecond)
		}
		err = os.Rename(oldpath, newpath)
		if err == nil || !isTransient(err) {
			return err
		}
	}
	return err
}

func isTransient(err error) bool {
	return errors.Is(err, errorAccessDenied) ||
		errors.Is(err, errorSharingViolation) ||
		errors.Is(err, errorLockViolation)
}
