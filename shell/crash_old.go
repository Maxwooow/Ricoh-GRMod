//go:build !go1.23 && !windows

package main

import (
	"os"
	"syscall"
)

// setCrashOutput, for the older Go releases that the macOS Intel build uses so that it runs on
// macOS before 11 (see build.sh): those have no debug.SetCrashOutput, so standard error itself is
// pointed at the crash file. The program writes nothing else to standard error.
func setCrashOutput(f *os.File) {
	_ = syscall.Dup2(int(f.Fd()), 2)
}
