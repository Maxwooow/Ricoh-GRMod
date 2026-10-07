//go:build windows

package server

import (
	"errors"
	"syscall"
)

// errorNotSameDevice is ERROR_NOT_SAME_DEVICE.
const errorNotSameDevice = syscall.Errno(17)

// isCrossDevice reports whether a rename failed because source and
// destination are on different volumes.
func isCrossDevice(err error) bool { return errors.Is(err, errorNotSameDevice) }
