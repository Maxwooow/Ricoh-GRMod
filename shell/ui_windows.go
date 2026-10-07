//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"

	"grmod/shell/internal/platform"
	"grmod/shell/internal/server"
)

// None of this file can be executed on the Linux build machine; see the
// README for the list of things to check on a real PC.

// runPlatform shows the UI, in this order of preference:
//
//  1. a WebView2 window (hosted in a worker process, see supervise.go),
//  2. Microsoft Edge in app mode,
//  3. the default browser.
func runPlatform(a *app) int {
	if a.cfg.worker {
		return runWebviewWorker(a)
	}
	if !a.cfg.browser {
		self, err := os.Executable()
		if err != nil {
			a.log.Printf("cannot locate the executable (%v); using a browser", err)
		} else {
			cmd := exec.Command(self, workerArgs(os.Args[1:])...)
			outcome, detail := superviseWorker(cmd, workerTimeout)
			if outcome == workerReady {
				_ = cmd.Process.Release()
				return 0 // the worker carries on alone
			}
			a.log.Printf("WebView2 window not available (%s); using a browser", detail)
		}
	}
	return runBrowser(a)
}

// runWebviewWorker hosts the server and the WebView2 window. It returns
// when the window has been closed. Every failure before the window exists
// ends the process with exitWebviewFailed so that the supervisor can fall
// back to a browser.
func runWebviewWorker(a *app) (code int) {
	defer func() {
		if r := recover(); r != nil {
			a.log.Printf("webview: panic: %v\n%s", r, debug.Stack())
			code = exitWebviewFailed
		}
	}()

	runtimeVersion, err := webviewloader.GetInstalledVersion()
	if err != nil {
		a.log.Printf("webview: cannot query the WebView2 runtime: %v", err)
		return exitWebviewFailed
	}
	if runtimeVersion == "" {
		a.log.Printf("webview: the WebView2 runtime is not installed")
		return exitWebviewFailed
	}

	host := platform.New()
	if err := a.start(host); err != nil {
		a.log.Printf("webview: startup failed: %v", err)
		return exitWebviewFailed
	}
	userData := filepath.Join(a.dataDir, "webview")
	if err := os.MkdirAll(userData, 0o755); err != nil {
		a.log.Printf("webview: cannot create %s: %v", userData, err)
		return exitWebviewFailed
	}

	screenW, screenH := systemMetric(smCxScreen), systemMetric(smCyScreen)
	size := fitWindow(systemDPI(), screenW, screenH, workAreaWidth(), workAreaHeight())
	// The binding centres with unsigned arithmetic, so centring is only safe
	// when the window is known to fit on the screen.
	center := screenW >= size.Width && screenH >= size.Height
	a.log.Printf("webview: runtime %s, window %dx%d (minimum %dx%d)", runtimeVersion, size.Width, size.Height, size.MinWidth, size.MinHeight)

	dark := systemUsesDarkApps()
	prepareWebviewEnvironment(dark)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     a.cfg.devtools,
		AutoFocus: true,
		DataPath:  userData,
		WindowOptions: webview2.WindowOptions{
			Title:  windowTitle,
			Width:  uint(size.Width),
			Height: uint(size.Height),
			IconId: iconResourceID,
			Center: center,
		},
	})
	if w == nil {
		a.log.Printf("webview: the WebView2 window could not be created")
		return exitWebviewFailed
	}
	hwnd := uintptr(w.Window())
	host.SetOwnerWindow(hwnd)
	w.SetSize(size.MinWidth, size.MinHeight, webview2.HintMin)

	// The title bar takes the colour of the interface: first a guess from the
	// system theme, then whatever the page reports (also when the theme
	// changes while the program runs).
	applyFrame(hwnd, defaultFrame(dark), a.log)
	a.srv.SetChromeHandler(func(c server.ChromeColors) {
		fc := frameColors{Caption: c.Caption, Text: c.Text, Dark: c.Dark}
		w.Dispatch(func() { applyFrame(hwnd, fc, a.log) })
	})

	// From here on the window exists: tell the supervisor it may leave.
	fmt.Fprintln(os.Stdout, readyLine)

	w.Navigate(a.url)
	w.Run() // returns when the window has been closed
	a.srv.SetChromeHandler(func(server.ChromeColors) {})
	host.SetOwnerWindow(0)
	a.log.Printf("webview: window closed")
	a.shutdown()
	return 0
}

// runBrowser serves the UI to Microsoft Edge in app mode or, failing that,
// to the default browser, until the page stops sending heartbeats.
func runBrowser(a *app) int {
	host := platform.New()
	if err := a.start(host); err != nil {
		a.log.Printf("startup failed: %v", err)
		fatalMessage("GR Mod cannot start: " + err.Error())
		return 1
	}
	heartbeat := a.srv.Heartbeat()
	heartbeat.Restart()

	opened := false
	if edge := findEdge(os.Getenv, isFile); edge != "" {
		cmd := exec.Command(edge, edgeArgs(a.url, filepath.Join(a.dataDir, "edge"))...)
		if err := cmd.Start(); err != nil {
			a.log.Printf("browser: cannot start %s: %v", edge, err)
		} else {
			a.log.Printf("browser: started Microsoft Edge in app mode")
			go cmd.Wait()
			opened = true
		}
	} else {
		a.log.Printf("browser: Microsoft Edge not found")
	}
	if !opened {
		rundll32 := filepath.Join(host.WindowsDir(), "System32", "rundll32.exe")
		cmd := exec.Command(rundll32, "url.dll,FileProtocolHandler", a.url)
		if err := cmd.Start(); err != nil {
			a.log.Printf("browser: cannot open the default browser: %v", err)
			fatalMessage("GR Mod could not open a browser window.\n\nOpen this address in a browser within a minute to use it:\n\n" + a.url)
			heartbeat.Restart()
		} else {
			a.log.Printf("browser: opened the default browser")
			go cmd.Wait()
		}
	}

	_ = heartbeat.Wait(context.Background(), heartbeatIdle, heartbeatNever, heartbeatPoll)
	if heartbeat.Seen() {
		a.log.Printf("browser: the page stopped sending heartbeats")
	} else {
		a.log.Printf("browser: no page ever connected")
	}
	a.shutdown()
	return 0
}

func isFile(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
}

// fatalMessage reports a fatal problem. The program is built for the GUI
// subsystem and has no console, so a message box is the only way to say
// anything.
func fatalMessage(msg string) {
	text, err1 := windows.UTF16PtrFromString(msg)
	caption, err2 := windows.UTF16PtrFromString(windowTitle)
	if err1 != nil || err2 != nil {
		return
	}
	windows.MessageBox(0, text, caption, windows.MB_OK|windows.MB_ICONERROR|windows.MB_SETFOREGROUND)
}

// ------------------------------------------------------ screen measurement

var (
	user32                    = windows.NewLazySystemDLL("user32.dll")
	procGetDpiForSystem       = user32.NewProc("GetDpiForSystem") // Windows 10 1607 and later
	procGetSystemMetrics      = user32.NewProc("GetSystemMetrics")
	procSystemParametersInfoW = user32.NewProc("SystemParametersInfoW")
)

const (
	smCxScreen     = 0      // SM_CXSCREEN
	smCyScreen     = 1      // SM_CYSCREEN
	spiGetWorkArea = 0x0030 // SPI_GETWORKAREA
)

// systemDPI returns the DPI of the primary monitor, or 0 when unknown.
func systemDPI() int {
	if procGetDpiForSystem.Find() != nil {
		return 0
	}
	dpi, _, _ := procGetDpiForSystem.Call()
	return int(dpi)
}

func systemMetric(index uintptr) int {
	v, _, _ := procGetSystemMetrics.Call(index)
	return int(int32(v))
}

type rect struct{ left, top, right, bottom int32 }

// workArea returns the primary monitor's work area (the screen without the
// taskbar), or a zero rect when unknown.
func workArea() rect {
	var r rect
	ok, _, _ := procSystemParametersInfoW.Call(spiGetWorkArea, 0, uintptr(unsafe.Pointer(&r)), 0)
	if ok == 0 {
		return rect{}
	}
	return r
}

func workAreaWidth() int  { r := workArea(); return int(r.right - r.left) }
func workAreaHeight() int { r := workArea(); return int(r.bottom - r.top) }
