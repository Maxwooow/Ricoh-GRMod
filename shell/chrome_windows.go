//go:build windows

package main

import (
	"log"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// None of this file can be executed on the Linux build machine. Every call
// is optional: when one fails the window simply keeps the system's frame.

var (
	dwmapi                    = windows.NewLazySystemDLL("dwmapi.dll")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
	procSetWindowPos          = user32.NewProc("SetWindowPos")
)

const (
	dwmwaUseImmersiveDarkModeOld = 19 // Windows 10 before 2004
	dwmwaUseImmersiveDarkMode    = 20
	dwmwaCaptionColor            = 35 // Windows 11
	dwmwaTextColor               = 36 // Windows 11

	swpNoSize       = 0x0001
	swpNoMove       = 0x0002
	swpNoZOrder     = 0x0004
	swpNoActivate   = 0x0010
	swpFrameChanged = 0x0020
)

// systemUsesDarkApps reports the "app mode" colour setting of Windows.
func systemUsesDarkApps() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("AppsUseLightTheme")
	return err == nil && v == 0
}

// prepareWebviewEnvironment sets the environment the WebView2 runtime reads
// when it starts. It must run before the window is created.
func prepareWebviewEnvironment(dark bool) {
	const args = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
	_ = os.Setenv(args, browserArguments(os.Getenv(args)))
	const bg = "WEBVIEW2_DEFAULT_BACKGROUND_COLOR"
	if os.Getenv(bg) == "" {
		_ = os.Setenv(bg, backgroundColorValue(dark))
	}
}

func dwmSet(hwnd uintptr, attr uintptr, value uint32) uintptr {
	hr, _, _ := procDwmSetWindowAttribute.Call(hwnd, attr, uintptr(unsafe.Pointer(&value)), unsafe.Sizeof(value))
	return hr
}

// applyFrame colours the title bar of the window. It must be called on the
// thread that owns the window. lg may be nil.
func applyFrame(hwnd uintptr, c frameColors, lg *log.Logger) {
	if hwnd == 0 || procDwmSetWindowAttribute.Find() != nil {
		return
	}
	var dark uint32
	if c.Dark {
		dark = 1
	}
	hrDark := dwmSet(hwnd, dwmwaUseImmersiveDarkMode, dark)
	if hrDark != 0 {
		hrDark = dwmSet(hwnd, dwmwaUseImmersiveDarkModeOld, dark)
	}
	hrCaption := dwmSet(hwnd, dwmwaCaptionColor, colorref(c.Caption))
	hrText := dwmSet(hwnd, dwmwaTextColor, colorref(c.Text))
	if procSetWindowPos.Find() == nil {
		procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoZOrder|swpNoActivate|swpFrameChanged)
	}
	if lg != nil {
		lg.Printf("webview: title bar caption #%06x text #%06x dark=%v (results: dark 0x%x, caption 0x%x, text 0x%x)", c.Caption, c.Text, c.Dark, hrDark, hrCaption, hrText)
	}
}
