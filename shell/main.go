// Command grmod-shell is the desktop shell of GR Mod: it serves the web UI
// from files embedded in the executable, shows it in a native window on
// Windows and gives the page a small local HTTP API for what a web page
// cannot do by itself (removable drives, file access on a memory card, a
// folder picker, a key/value store).
//
// On other systems the same program runs headless, for development and
// tests: it prints where it listens and serves until it is killed.
package main

import (
	"embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

// The UI files. build.sh replaces the placeholder in web/ with the real UI
// before compiling.
//
//go:embed all:web
var embeddedWeb embed.FS

// config is the parsed command line.
type config struct {
	port        int
	token       string
	webDir      string
	dataDir     string
	sidecarDir  string
	browser     bool
	devtools    bool
	worker      bool
	showVersion bool
}

// workerFlag marks the child process that hosts the WebView2 window; see
// supervise.go.
const workerFlag = "webview-worker"

func parseFlags(args []string, errOut io.Writer) (config, error) {
	var c config
	fs := flag.NewFlagSet("grmod", flag.ContinueOnError)
	fs.SetOutput(errOut)
	fs.IntVar(&c.port, "port", 0, "listen on this TCP `port` of 127.0.0.1 instead of choosing a free one")
	fs.StringVar(&c.token, "token", "", "use this API `token` instead of a random one")
	fs.StringVar(&c.webDir, "web", "", "serve the UI from this `directory` instead of the embedded files")
	fs.StringVar(&c.dataDir, "data", "", "use this data `directory` (log, store, browser profile)")
	fs.StringVar(&c.sidecarDir, "sidecar", "", "look for companion files (preview.jpg) in this `directory` instead of next to the program")
	fs.BoolVar(&c.browser, "browser", false, "Windows: open the UI in Microsoft Edge (app mode) instead of a WebView2 window")
	fs.BoolVar(&c.devtools, "devtools", false, "Windows: enable the developer tools and the context menu of the WebView2 window")
	fs.BoolVar(&c.worker, workerFlag, false, "internal: host the WebView2 window in this process")
	fs.BoolVar(&c.showVersion, "version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return c, err
	}
	if fs.NArg() > 0 {
		return c, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if c.port < 0 || c.port > 65535 {
		return c, fmt.Errorf("invalid port %d", c.port)
	}
	if err := checkToken(c.token); err != nil {
		return c, err
	}
	return c, nil
}

// checkToken accepts what can travel in an HTTP header without surprises.
func checkToken(token string) error {
	if len(token) > 128 {
		return errors.New("token is longer than 128 characters")
	}
	for _, r := range token {
		if r <= ' ' || r > '~' {
			return errors.New("token may only contain printable ASCII characters without spaces")
		}
	}
	return nil
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	cfg, err := parseFlags(args, os.Stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fatalMessage("Invalid command line: " + err.Error())
		return 2
	}
	if cfg.showVersion {
		fmt.Println(strings.TrimSpace("grmod " + version))
		return 0
	}
	a, err := newApp(cfg)
	if err != nil {
		fatalMessage("GR Mod cannot start: " + err.Error())
		return 1
	}
	defer a.close()
	return runPlatform(a)
}
