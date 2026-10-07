package server

import (
	"net/http"
	"strconv"
	"sync/atomic"
)

// ChromeColors are the colours the page asks the native window frame to
// take, so that the title bar continues the interface.
type ChromeColors struct {
	// Caption and Text are 0xRRGGBB.
	Caption uint32
	Text    uint32
	// Dark tells whether the interface is in its dark theme.
	Dark bool
}

// chromeHandler holds the func(ChromeColors) installed by SetChromeHandler.
type chromeHandler struct{ v atomic.Value }

// SetChromeHandler installs the function that applies frame colours to the
// native window. Without one (a UI running in a browser) requests are
// accepted and ignored.
func (s *Server) SetChromeHandler(f func(ChromeColors)) { s.chrome.v.Store(f) }

// parseHexColor reads "#rrggbb".
func parseHexColor(v string) (uint32, bool) {
	if len(v) != 7 || v[0] != '#' {
		return 0, false
	}
	n, err := strconv.ParseUint(v[1:], 16, 32)
	if err != nil {
		return 0, false
	}
	return uint32(n), true
}

// handleWindowChrome answers POST /api/window/chrome.
func (s *Server) handleWindowChrome(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Caption string `json:"caption"`
		Text    string `json:"text"`
		Dark    bool   `json:"dark"`
	}
	if err := readJSON(w, r, &req, false); err != nil {
		return err
	}
	caption, ok1 := parseHexColor(req.Caption)
	text, ok2 := parseHexColor(req.Text)
	if !ok1 || !ok2 {
		return errInvalid("caption and text must be colours of the form #rrggbb")
	}
	f, _ := s.chrome.v.Load().(func(ChromeColors))
	if f != nil {
		f(ChromeColors{Caption: caption, Text: text, Dark: req.Dark})
	}
	writeJSON(w, http.StatusOK, struct {
		Applied bool `json:"applied"`
	}{f != nil})
	return nil
}
