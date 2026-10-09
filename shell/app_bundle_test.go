package main

import "testing"

func TestBesideBundle(t *testing.T) {
	cases := map[string]string{
		"/Applications/GR Mod.app/Contents/MacOS":       "/Applications",
		"/Users/me/Downloads/GR Mod.app/Contents/MacOS": "/Users/me/Downloads",
		"/opt/grmod":          "/opt/grmod",
		"/opt/Contents/MacOS": "/opt/Contents/MacOS", // not inside a .app
	}
	for in, want := range cases {
		if got := besideBundle(in); got != want {
			t.Errorf("besideBundle(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestChromiumLockPID(t *testing.T) {
	for in, want := range map[string]int{"MacBook-Pro.local-4242": 4242, "host-with-dashes-17": 17, "nopid": 0, "host-x": 0, "host-": 0, "host--3": 3} {
		if got := chromiumLockPID(in); got != want {
			t.Errorf("chromiumLockPID(%q) = %d, want %d", in, got, want)
		}
	}
}
