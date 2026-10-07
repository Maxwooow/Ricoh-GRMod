package main

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Why the WebView2 window lives in a child process
//
// The WebView2 binding (github.com/jchv/go-webview2) reports several
// failures by calling log.Fatal, i.e. os.Exit: an environment or controller
// that cannot be created ends the process on the spot, and a crash inside
// the native WebView2 code does the same. Neither can be caught with
// recover, so "fall back to a browser when WebView2 does not work" cannot be
// implemented inside the process that tries WebView2.
//
// Therefore the program starts itself once more with --webview-worker. That
// worker runs the server and the window. As soon as the window exists it
// prints readyLine, and the first process (the supervisor) simply exits:
// from then on there is exactly one process, as if there had never been
// two. If the worker dies or stays silent instead, the supervisor takes
// over and runs the browser fallback itself.
//
// This file is platform-independent so that the logic is tested on Linux.

// readyLine is what the worker prints on standard output once its window
// has been created.
const readyLine = "GRMOD-WINDOW-READY"

// workerTimeout is how long the supervisor waits for readyLine. Creating a
// WebView2 for the very first time can take several seconds on a slow PC.
const workerTimeout = 60 * time.Second

// exitWebviewFailed is the worker's exit code when it could not create the
// window (any other failure exit is treated the same way).
const exitWebviewFailed = 3

type workerOutcome int

const (
	// workerReady: the window is up; the supervisor is no longer needed.
	workerReady workerOutcome = iota
	// workerFailed: the worker ended (or could not be started, or had to be
	// stopped after the timeout) without ever announcing its window.
	workerFailed
)

// superviseWorker starts cmd and waits until it announces its window, ends,
// or the timeout passes. In the last case the worker is killed. The second
// result describes a failure for the log.
func superviseWorker(cmd *exec.Cmd, timeout time.Duration) (workerOutcome, string) {
	pr, pw, err := os.Pipe()
	if err != nil {
		return workerFailed, "cannot create a pipe: " + err.Error()
	}
	defer pr.Close()
	cmd.Stdout = pw
	err = cmd.Start()
	pw.Close() // the child holds its own copy
	if err != nil {
		return workerFailed, "cannot start the worker: " + err.Error()
	}

	ready := make(chan bool, 1)
	go func() {
		sc := bufio.NewScanner(pr)
		for sc.Scan() {
			if strings.TrimSpace(sc.Text()) == readyLine {
				ready <- true
				return
			}
		}
		ready <- false
	}()
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case ok := <-ready:
		if ok {
			return workerReady, ""
		}
		// Standard output was closed without the ready line. The worker is
		// on its way out; give it a moment so that the exit code can be
		// reported, then make sure it is gone.
		select {
		case err := <-exited:
			return workerFailed, describeExit(err)
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
			<-exited
			return workerFailed, "the worker closed its output without creating a window"
		}
	case err := <-exited:
		// It may have announced the window and ended right after; the line
		// is then still in the pipe.
		select {
		case ok := <-ready:
			if ok {
				return workerReady, ""
			}
		case <-time.After(500 * time.Millisecond):
		}
		return workerFailed, describeExit(err)
	case <-timer.C:
		cmd.Process.Kill()
		<-exited
		return workerFailed, "no window after " + timeout.String()
	}
}

func describeExit(err error) string {
	if err == nil {
		return "the worker ended without creating a window"
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return "the worker ended with " + ee.Error()
	}
	return "the worker failed: " + err.Error()
}

// workerArgs returns the command line for the worker: the supervisor's own
// arguments plus the worker flag.
func workerArgs(args []string) []string {
	out := append([]string{}, args...)
	return append(out, "--"+workerFlag)
}
