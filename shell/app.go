package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"grmod/shell/internal/logfile"
	"grmod/shell/internal/platform"
	"grmod/shell/internal/server"
)

// app is one running instance: data directory, log, and (once started) the
// HTTP server.
type app struct {
	cfg     config
	dataDir string
	web     fs.FS
	webName string

	logFile *logfile.File
	log     *log.Logger

	token string
	port  int
	url   string
	srv   *server.Server
	http  *http.Server
}

// newApp prepares the data directory, the log and the UI files. It does not
// open any socket yet.
func newApp(cfg config) (*app, error) {
	a := &app{cfg: cfg}

	dir := cfg.dataDir
	if dir == "" {
		home, _ := os.UserHomeDir()
		var err error
		if dir, err = platform.DataDirFor(runtime.GOOS, os.Getenv, home); err != nil {
			return nil, fmt.Errorf("no data directory: %w", err)
		}
	}
	dir, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("data directory: %w", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("data directory: %w", err)
	}
	a.dataDir = dir

	a.logFile, err = logfile.Open(filepath.Join(dir, "log.txt"), logfile.DefaultMaxBytes)
	if err != nil {
		return nil, fmt.Errorf("log file: %w", err)
	}
	a.log = log.New(a.logFile, fmt.Sprintf("[%d] ", os.Getpid()), log.LstdFlags|log.Lmsgprefix)
	// Libraries that use the standard logger end up in the same file.
	log.SetOutput(a.logFile)
	log.SetPrefix(fmt.Sprintf("[%d] ", os.Getpid()))
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)

	// A Go runtime crash normally goes to standard error, which does not
	// exist in a Windows GUI program. Keep a copy where it can be found.
	if f, err := os.OpenFile(filepath.Join(dir, crashFile), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		_ = debug.SetCrashOutput(f, debug.CrashOptions{})
		f.Close() // SetCrashOutput keeps its own duplicate
	}

	if cfg.webDir != "" {
		webDir, err := filepath.Abs(cfg.webDir)
		if err != nil {
			return nil, fmt.Errorf("--web: %w", err)
		}
		if fi, err := os.Stat(webDir); err != nil || !fi.IsDir() {
			return nil, fmt.Errorf("--web: %s is not a directory", webDir)
		}
		a.web, a.webName = os.DirFS(webDir), webDir
	} else {
		sub, err := fs.Sub(embeddedWeb, "web")
		if err != nil {
			return nil, fmt.Errorf("embedded UI: %w", err)
		}
		a.web, a.webName = sub, "embedded"
	}
	return a, nil
}

// start opens the listening socket and begins serving.
func (a *app) start(host platform.Host) error {
	ln, err := listen(a.dataDir, a.cfg.port)
	if err != nil {
		return err
	}
	a.port = ln.Addr().(*net.TCPAddr).Port
	a.url = "http://127.0.0.1:" + strconv.Itoa(a.port) + "/"

	a.token = a.cfg.token
	if a.token == "" {
		if a.token, err = newToken(); err != nil {
			ln.Close()
			return err
		}
	}
	// The development build can be pointed at a stand-in for Ricoh's site.
	firmwareSite := ""
	if host.Kind() == "dev" {
		firmwareSite = os.Getenv(envFirmwareSite)
	}
	a.srv, err = server.New(server.Options{
		Token:        a.token,
		Port:         a.port,
		Version:      version,
		Web:          a.web,
		DataDir:      a.dataDir,
		Host:         host,
		SidecarDir:   sidecarDir(a.cfg.sidecarDir),
		FirmwareSite: firmwareSite,
		Log:          a.log,
	})
	if err != nil {
		ln.Close()
		return err
	}
	a.http = &http.Server{
		Handler:           a.srv,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          a.log,
		// No read or write timeout: a 256 MB transfer to a slow card may
		// legitimately take minutes.
	}
	go func() {
		if err := a.http.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			a.log.Printf("http server stopped: %v", err)
		}
	}()
	a.log.Printf("grmod %s (%s/%s, %s) serving %s, ui: %s, data: %s",
		version, runtime.GOOS, runtime.GOARCH, host.Kind(), a.url, a.webName, a.dataDir)
	return nil
}

// shutdown stops the HTTP server, giving running requests a moment to end.
func (a *app) shutdown() {
	if a.http == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := a.http.Shutdown(ctx); err != nil {
		a.http.Close()
	}
	a.http = nil
	a.log.Printf("stopped")
}

func (a *app) close() {
	a.shutdown()
	if a.logFile != nil {
		a.logFile.Close()
	}
}

// newToken returns 32 random hexadecimal characters.
func newToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("cannot generate a token: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// envFirmwareSite replaces the address of Ricoh's site in the development
// build (see server.Options.FirmwareSite).
const envFirmwareSite = "GRMOD_FIRMWARE_SITE"

// Files in the data directory, next to log.txt and the store.
const (
	// portFile remembers the port of the previous run.
	portFile = "port"
	// crashFile receives the trace of a Go runtime crash, if one ever happens.
	crashFile = "crash.txt"
)

// listen opens the server socket on 127.0.0.1.
//
// With a fixed port that port is used or the call fails. Otherwise a free
// port is chosen by the operating system, except that the port of the
// previous run is tried first: the page's origin includes the port, and a
// browser keeps a page's storage (localStorage, IndexedDB) per origin, so a
// different port on every start would make the UI forget everything it
// stored itself.
func listen(dataDir string, fixedPort int) (net.Listener, error) {
	if fixedPort != 0 {
		ln, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(fixedPort))
		if err != nil {
			return nil, fmt.Errorf("cannot listen on port %d: %w", fixedPort, err)
		}
		return ln, nil
	}
	file := filepath.Join(dataDir, portFile)
	if data, err := os.ReadFile(file); err == nil {
		if p, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && p >= 1024 && p <= 65535 {
			if ln, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(p)); err == nil {
				return ln, nil
			}
		}
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("cannot listen on 127.0.0.1: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = os.WriteFile(file, []byte(strconv.Itoa(port)+"\n"), 0o644) // best effort
	return ln, nil
}

// sidecarDir is where optional companion files are looked for: the given
// directory, else the directory of the executable.
func sidecarDir(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	return besideBundle(filepath.Dir(exe))
}

// besideBundle maps the executable's folder inside a macOS application
// bundle (X.app/Contents/MacOS) to the folder that holds X.app, so that
// "next to the program" means next to the app as the Finder shows it: a
// file added inside the bundle would break its signature. Any other folder
// is returned unchanged.
func besideBundle(dir string) string {
	contents := filepath.Dir(dir)
	bundle := filepath.Dir(contents)
	if filepath.Base(dir) == "MacOS" && filepath.Base(contents) == "Contents" && strings.HasSuffix(bundle, ".app") {
		return filepath.Dir(bundle)
	}
	return dir
}
