package main

import "strings"

// frameColors are the colours of the native title bar, 0xRRGGBB.
type frameColors struct {
	Caption uint32
	Text    uint32
	Dark    bool
}

// defaultFrame is what the title bar gets before the page has loaded and
// reported its own colours. The values are the sidebar and text colours of
// the two themes in ui/src/styles.css.
func defaultFrame(dark bool) frameColors {
	if dark {
		return frameColors{Caption: 0x202020, Text: 0xd6d6d6, Dark: true}
	}
	return frameColors{Caption: 0xf7f7f5, Text: 0x37352f, Dark: false}
}

// colorref converts 0xRRGGBB to the Win32 COLORREF layout 0x00BBGGRR.
func colorref(rgb uint32) uint32 {
	return (rgb&0xff)<<16 | (rgb & 0xff00) | (rgb>>16)&0xff
}

// noZoomArgs are Chromium switches that make the embedded page behave like
// a native window: no pinch zoom, no swipe to navigate, no rubber-band
// overscroll.
var noZoomArgs = []string{
	"--disable-pinch",
	"--overscroll-history-navigation=0",
	"--disable-features=ElasticOverscroll",
}

// browserArguments appends noZoomArgs to whatever the environment already
// asks for (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).
func browserArguments(existing string) string {
	parts := strings.Fields(existing)
	for _, a := range noZoomArgs {
		found := false
		for _, p := range parts {
			if p == a {
				found = true
			}
		}
		if !found {
			parts = append(parts, a)
		}
	}
	return strings.Join(parts, " ")
}

// backgroundColorValue is the WEBVIEW2_DEFAULT_BACKGROUND_COLOR value
// (0xAARRGGBB) that keeps the window from flashing white before the page
// has painted: the content panel colour of the theme.
func backgroundColorValue(dark bool) string {
	if dark {
		return "0xFF191919"
	}
	return "0xFFFFFFFF"
}
