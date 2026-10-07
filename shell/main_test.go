package main

import (
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestMain doubles as the fake worker process for the supervisor tests.
func TestMain(m *testing.M) {
	switch os.Getenv("GRMOD_TEST_WORKER") {
	case "":
		os.Exit(m.Run())
	case "ready":
		fmt.Println("some noise first")
		fmt.Println(readyLine)
		time.Sleep(30 * time.Second) // a window that stays open
	case "ready-then-exit":
		fmt.Println(readyLine)
	case "fail":
		fmt.Println("no window here")
		os.Exit(exitWebviewFailed)
	case "fatal":
		os.Exit(1) // what log.Fatal in the WebView2 binding does
	case "exit-zero":
	case "hang":
		time.Sleep(30 * time.Second)
	case "close-stdout-and-hang":
		os.Stdout.Close()
		time.Sleep(30 * time.Second)
	}
	os.Exit(0)
}

func fakeWorker(t *testing.T, mode string) *exec.Cmd {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(self)
	cmd.Env = append(os.Environ(), "GRMOD_TEST_WORKER="+mode)
	t.Cleanup(func() {
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
	})
	return cmd
}

func TestSuperviseWorker(t *testing.T) {
	cases := []struct {
		mode    string
		timeout time.Duration
		want    workerOutcome
		detail  string
		maxTime time.Duration
	}{
		{"ready", 20 * time.Second, workerReady, "", 10 * time.Second},
		{"ready-then-exit", 20 * time.Second, workerReady, "", 10 * time.Second},
		{"fail", 20 * time.Second, workerFailed, "exit status 3", 10 * time.Second},
		{"fatal", 20 * time.Second, workerFailed, "exit status 1", 10 * time.Second},
		{"exit-zero", 20 * time.Second, workerFailed, "without creating a window", 10 * time.Second},
		{"hang", 300 * time.Millisecond, workerFailed, "no window after", 10 * time.Second},
	}
	for _, c := range cases {
		t.Run(c.mode, func(t *testing.T) {
			cmd := fakeWorker(t, c.mode)
			start := time.Now()
			got, detail := superviseWorker(cmd, c.timeout)
			if got != c.want || !strings.Contains(detail, c.detail) {
				t.Errorf("outcome = %v (%q), want %v (%q)", got, detail, c.want, c.detail)
			}
			if d := time.Since(start); d > c.maxTime {
				t.Errorf("took %v", d)
			}
			if c.mode == "hang" {
				// The silent worker must have been killed.
				if cmd.ProcessState == nil {
					t.Error("hung worker was not reaped")
				}
			}
			if c.mode == "ready" {
				// A ready worker is left alone.
				if cmd.ProcessState != nil {
					t.Error("ready worker was waited for or killed")
				}
			}
		})
	}

	t.Run("cannot start", func(t *testing.T) {
		cmd := exec.Command(filepath.Join(t.TempDir(), "does-not-exist"))
		got, detail := superviseWorker(cmd, time.Second)
		if got != workerFailed || !strings.Contains(detail, "cannot start") {
			t.Errorf("outcome = %v (%q)", got, detail)
		}
	})
}

func TestWorkerArgs(t *testing.T) {
	in := []string{"--port", "1234", "--devtools"}
	got := workerArgs(in)
	if strings.Join(got, " ") != "--port 1234 --devtools --webview-worker" {
		t.Errorf("workerArgs = %v", got)
	}
	if len(in) != 3 {
		t.Error("workerArgs modified its input")
	}
	// The result must parse as a worker command line.
	cfg, err := parseFlags(got, io.Discard)
	if err != nil || !cfg.worker || cfg.port != 1234 || !cfg.devtools {
		t.Errorf("parsed worker args: %+v, %v", cfg, err)
	}
}

func TestParseFlags(t *testing.T) {
	cfg, err := parseFlags(nil, io.Discard)
	if err != nil || cfg != (config{}) {
		t.Errorf("no args: %+v, %v", cfg, err)
	}
	cfg, err = parseFlags([]string{"--port", "5000", "--token", "abc", "--web", "/w", "--data", "/d", "--browser"}, io.Discard)
	want := config{port: 5000, token: "abc", webDir: "/w", dataDir: "/d", browser: true}
	if err != nil || cfg != want {
		t.Errorf("all flags: %+v, %v", cfg, err)
	}
	// Single-dash and = spellings work too.
	cfg, err = parseFlags([]string{"-port=5001", "-token=T"}, io.Discard)
	if err != nil || cfg.port != 5001 || cfg.token != "T" {
		t.Errorf("single dash: %+v, %v", cfg, err)
	}
	for _, bad := range [][]string{
		{"--port", "-1"}, {"--port", "65536"}, {"--port", "abc"}, {"--token", "has space"},
		{"--token", "tab\there"}, {"--token", "ünï"}, {"--token", strings.Repeat("x", 129)},
		{"--nope"}, {"stray"}, {"--port"},
	} {
		if _, err := parseFlags(bad, io.Discard); err == nil {
			t.Errorf("parseFlags(%v) succeeded", bad)
		}
	}
}

func TestNewToken(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{32}$`)
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		tok, err := newToken()
		if err != nil || !re.MatchString(tok) {
			t.Fatalf("token %q, %v", tok, err)
		}
		if seen[tok] {
			t.Fatalf("token %q repeated", tok)
		}
		seen[tok] = true
	}
}

func portOf(ln net.Listener) int { return ln.Addr().(*net.TCPAddr).Port }

func TestListen(t *testing.T) {
	dir := t.TempDir()

	// First run: a free port on 127.0.0.1, remembered for the next run.
	ln1, err := listen(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	p1 := portOf(ln1)
	if host, _, _ := net.SplitHostPort(ln1.Addr().String()); host != "127.0.0.1" {
		t.Errorf("listening on %s, want 127.0.0.1 only", host)
	}
	saved, _ := os.ReadFile(filepath.Join(dir, portFile))
	if strings.TrimSpace(string(saved)) != strconv.Itoa(p1) {
		t.Errorf("port file = %q, want %d", saved, p1)
	}

	// A second instance while the first runs gets another port.
	ln2, err := listen(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	p2 := portOf(ln2)
	if p2 == p1 {
		t.Error("two listeners on the same port")
	}
	ln1.Close()
	ln2.Close()

	// Next run: the remembered port is reused (that of the last instance).
	ln3, err := listen(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	if portOf(ln3) != p2 {
		t.Errorf("port %d, want the remembered %d", portOf(ln3), p2)
	}

	// A fixed port is used exactly, and a busy one is an error.
	if _, err := listen(dir, p2); err == nil {
		t.Error("listening on a busy fixed port succeeded")
	}
	ln3.Close()
	ln4, err := listen(dir, p1)
	if err != nil || portOf(ln4) != p1 {
		t.Errorf("fixed port: %v", err)
	}
	ln4.Close()
	// A fixed port does not change what is remembered.
	saved, _ = os.ReadFile(filepath.Join(dir, portFile))
	if strings.TrimSpace(string(saved)) != strconv.Itoa(p2) {
		t.Errorf("port file after fixed port = %q", saved)
	}

	// Garbage in the port file is ignored.
	for _, junk := range []string{"", "abc", "0", "80", "70000", "-5", "12345678901234567890"} {
		os.WriteFile(filepath.Join(dir, portFile), []byte(junk), 0o644)
		ln, err := listen(dir, 0)
		if err != nil {
			t.Fatalf("port file %q: %v", junk, err)
		}
		ln.Close()
	}
}

func TestFitWindow(t *testing.T) {
	cases := []struct {
		name                           string
		dpi, sw, sh, ww, wh            int
		wantW, wantH, wantMinW, wantMH int
	}{
		{"full hd 100%", 96, 1920, 1080, 1920, 1040, 1180, 800, 980, 640},
		{"4k 200%", 192, 3840, 2160, 3840, 2080, 2360, 1600, 1960, 1280},
		{"full hd 150%", 144, 1920, 1080, 1920, 1032, 1770, 984, 1470, 960},
		{"laptop 1366x768", 96, 1366, 768, 1366, 728, 1180, 688, 980, 640},
		{"small 1280x720 at 150%", 144, 1280, 720, 1280, 672, 1280, 624, 1280, 624},
		{"taskbar on the left", 96, 1280, 1024, 1200, 1024, 1120, 800, 980, 640},
		{"unknown everything", 0, 0, 0, 0, 0, 1180, 800, 980, 640},
		{"unknown work area", 96, 1024, 768, 0, 0, 1024, 768, 980, 640},
		{"nonsense work area", 96, 1024, 768, 5000, 5000, 1024, 768, 980, 640},
		{"tiny screen", 96, 300, 200, 300, 150, 300, 200, 300, 200},
	}
	for _, c := range cases {
		got := fitWindow(c.dpi, c.sw, c.sh, c.ww, c.wh)
		want := windowSize{c.wantW, c.wantH, c.wantMinW, c.wantMH}
		if got != want {
			t.Errorf("%s: %+v, want %+v", c.name, got, want)
		}
		if got.MinWidth > got.Width || got.MinHeight > got.Height {
			t.Errorf("%s: minimum larger than the window: %+v", c.name, got)
		}
	}
}

func TestEdgeCandidatesAndArgs(t *testing.T) {
	env := map[string]string{
		"ProgramFiles(x86)": `C:\Program Files (x86)`,
		"ProgramFiles":      `C:\Program Files\`,
		"LOCALAPPDATA":      `C:\Users\me\AppData\Local`,
	}
	getenv := func(k string) string { return env[k] }
	got := edgeCandidates(getenv)
	want := []string{
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
		`C:\Users\me\AppData\Local\Microsoft\Edge\Application\msedge.exe`,
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("candidates = %q", got)
	}
	if got := edgeCandidates(func(string) string { return "" }); len(got) != 0 {
		t.Errorf("no environment: %q", got)
	}

	// The first existing candidate wins, in the documented order.
	if got := findEdge(getenv, func(p string) bool { return true }); got != want[0] {
		t.Errorf("findEdge(all exist) = %q", got)
	}
	if got := findEdge(getenv, func(p string) bool { return p == want[2] }); got != want[2] {
		t.Errorf("findEdge(only per-user) = %q", got)
	}
	if got := findEdge(getenv, func(p string) bool { return false }); got != "" {
		t.Errorf("findEdge(none) = %q", got)
	}

	args := edgeArgs("http://127.0.0.1:5000/", `C:\Users\me\AppData\Local\GRMod\edge`)
	wantArgs := `--app=http://127.0.0.1:5000/ --user-data-dir=C:\Users\me\AppData\Local\GRMod\edge --window-size=1180,800 --disable-pinch --overscroll-history-navigation=0 --no-first-run --no-default-browser-check`
	if strings.Join(args, " ") != wantArgs {
		t.Errorf("edge args = %q", args)
	}
}

func TestHeartbeatRuleConstants(t *testing.T) {
	if heartbeatIdle != 15*time.Second || heartbeatNever != 60*time.Second {
		t.Errorf("heartbeat rule = %v / %v, want 15 s / 60 s", heartbeatIdle, heartbeatNever)
	}
	if windowTitle != "GR Mod" || windowWidth != 1180 || windowHeight != 800 || windowMinWidth != 980 || windowMinHeight != 640 {
		t.Error("window constants differ from the specification")
	}
}

// The executable must always contain an index.html, placeholder or real.
func TestEmbeddedWebHasIndex(t *testing.T) {
	sub, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		t.Fatal(err)
	}
	data, err := fs.ReadFile(sub, "index.html")
	if err != nil || len(data) == 0 {
		t.Fatalf("embedded index.html: %v", err)
	}
}

func TestFrameColors(t *testing.T) {
	if got := colorref(0x112233); got != 0x332211 {
		t.Errorf("colorref(0x112233) = %#x", got)
	}
	if got := colorref(0xf7f7f5); got != 0xf5f7f7 {
		t.Errorf("colorref(0xf7f7f5) = %#x", got)
	}
	if d, l := defaultFrame(true), defaultFrame(false); !d.Dark || l.Dark || d.Caption != 0x202020 || l.Caption != 0xf7f7f5 {
		t.Errorf("default frames: %+v %+v", d, l)
	}
	if got := browserArguments(""); got != "--disable-pinch --overscroll-history-navigation=0 --disable-features=ElasticOverscroll" {
		t.Errorf("browserArguments(\"\") = %q", got)
	}
	if got := browserArguments("--foo  --disable-pinch"); got != "--foo --disable-pinch --overscroll-history-navigation=0 --disable-features=ElasticOverscroll" {
		t.Errorf("browserArguments keeps existing switches once: %q", got)
	}
	if backgroundColorValue(true) != "0xFF191919" || backgroundColorValue(false) != "0xFFFFFFFF" {
		t.Error("background colour values")
	}
}
