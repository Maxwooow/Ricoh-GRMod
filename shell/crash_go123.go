//go:build go1.23

package main

import (
	"os"
	"runtime/debug"
)

// setCrashOutput sends Go runtime crash reports to f as well as to standard error.
func setCrashOutput(f *os.File) {
	_ = debug.SetCrashOutput(f, debug.CrashOptions{})
}
