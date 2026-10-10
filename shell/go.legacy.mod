// Module file for the macOS Intel slice only, built with Go 1.20 (the last release that runs on
// macOS 10.13 / 10.14; see build.sh). Same requirements as go.mod, except golang.org/x/sys at
// a version that still accepts Go 1.20. Keep the two in step when dependencies change.

module grmod/shell

go 1.20

require (
	github.com/jchv/go-webview2 v0.0.0-20260205173254-56598839c808
	github.com/ncruces/zenity v0.10.14
	golang.org/x/sys v0.30.0
)

require (
	github.com/akavel/rsrc v0.10.2 // indirect
	github.com/dchest/jsmin v0.0.0-20220218165748-59f39799265f // indirect
	github.com/jchv/go-winloader v0.0.0-20250406163304-c1995be93bd1 // indirect
	github.com/josephspurrier/goversioninfo v1.4.1 // indirect
	github.com/randall77/makefat v0.0.0-20210315173500-7ddd0e42c844 // indirect
	golang.org/x/image v0.20.0 // indirect
)
