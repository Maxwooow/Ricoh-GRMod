package main

// Design sizes of the window, in device-independent pixels (96 per inch).
const (
	windowTitle     = "GR Mod"
	windowWidth     = 1180
	windowHeight    = 800
	windowMinWidth  = 980
	windowMinHeight = 640
)

// iconResourceID is the resource ID of the application icon; it must match
// winres/winres.json.
const iconResourceID = 1

type windowSize struct {
	Width, Height       int
	MinWidth, MinHeight int
}

// fitWindow converts the design sizes to physical pixels for the given DPI
// and shrinks them to what the primary monitor can show.
//
// The process is per-monitor DPI aware, so Windows does not scale the window
// for it: 1180 raw pixels would be a tiny window on a 200 % display. The
// window is created centred on the screen, hence the limit is the largest
// size that stays inside the work area (the screen minus the taskbar) when
// centred. The minimum size never exceeds the initial size, otherwise the
// window could not be made to fit a small screen at all.
//
// Unknown values (zero or negative) leave the corresponding step out.
func fitWindow(dpi, screenW, screenH, workW, workH int) windowSize {
	if dpi <= 0 {
		dpi = 96
	}
	scale := func(v int) int { return (v*dpi + 48) / 96 }
	s := windowSize{
		Width: scale(windowWidth), Height: scale(windowHeight),
		MinWidth: scale(windowMinWidth), MinHeight: scale(windowMinHeight),
	}
	limit := func(v, screen, work int) int {
		if screen <= 0 {
			return v
		}
		if work <= 0 || work > screen {
			work = screen
		}
		max := work - (screen - work)
		if max < 200 {
			max = 200
		}
		if v > max {
			return max
		}
		return v
	}
	s.Width = limit(s.Width, screenW, workW)
	s.Height = limit(s.Height, screenH, workH)
	if s.MinWidth > s.Width {
		s.MinWidth = s.Width
	}
	if s.MinHeight > s.Height {
		s.MinHeight = s.Height
	}
	return s
}
