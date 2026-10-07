//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"grmod/shell/internal/platform"
)

// runPlatform is the headless development mode: no window, the address and
// the token go to standard output, and the server runs until the process is
// interrupted or killed.
func runPlatform(a *app) int {
	if err := a.start(platform.New()); err != nil {
		a.log.Printf("startup failed: %v", err)
		fatalMessage("GR Mod cannot start: " + err.Error())
		return 1
	}
	fmt.Printf("LISTEN %s TOKEN %s\n", a.url, a.token)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	sig := <-stop
	a.log.Printf("received %v", sig)
	a.shutdown()
	return 0
}

func fatalMessage(msg string) {
	fmt.Fprintln(os.Stderr, "grmod: "+msg)
}
