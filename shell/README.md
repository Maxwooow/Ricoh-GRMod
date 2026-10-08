# GR Mod shell

A small desktop shell for the GR Mod web UI, written in pure Go (no cgo).

- Serves the UI (HTML/JS built elsewhere) from files embedded in the executable.
- On Windows it shows the UI in a native WebView2 window, falling back to Microsoft Edge in app mode and then to the default browser.
- Gives the page a local HTTP API for what a web page cannot do: listing removable drives, reading and writing files on a memory card, a native folder picker, a key/value store, fetching the official firmware from Ricoh's site.
- On Linux the same program runs headless, so the API can be developed against and tested without Windows.

## Build

```sh
./build.sh dev        # dist/grmod-dev   Linux, headless
./build.sh windows    # dist/GRMod.exe   Windows x64, single file, no console window
./build.sh all
```

- Requires Go 1.24. Nothing else: the Windows build is cross-compiled with `CGO_ENABLED=0`.
- The version is `$VERSION`, else the `version` of `../package.json`, else `0.0.0`. It is compiled in with `-X main.version=…`.
- If `../ui/dist/index.html` exists, `web/` is first replaced by a copy of `../ui/dist/`. Otherwise the current `web/` is kept; if there is none, the placeholder page from `placeholder/` is used.
- `web/` must contain an `index.html` for the package to compile (`//go:embed all:web`). The repository ignores `shell/web`, so in a fresh checkout run `./build.sh dev` once before `go build` or `go test`.
- Icon, manifest (per-monitor-v2 DPI awareness, `asInvoker`, common controls 6, long paths) and version information come from `rsrc_windows_amd64.syso`, which `go build` links automatically. `build.sh` regenerates it from `winres/` when [go-winres](https://github.com/tc-hib/go-winres) is installed (`go install github.com/tc-hib/go-winres@v0.3.3`) and otherwise uses the file that is checked in.
- The icon PNGs in `winres/` are drawn by `go run ./tools/genicon -out winres`.

## Test

```sh
go test ./...                                  # unit and integration tests
GOOS=windows GOARCH=amd64 go vet ./...          # the Windows build compiles and vets
./build.sh dev && ./smoke.sh                   # end-to-end with curl against the dev build
```

## Command line

| Flag | Meaning |
| --- | --- |
| `--port N` | Listen on port N of 127.0.0.1. Default: the port of the previous run if it is free, else a free port. |
| `--token T` | Use T as the API token. Default: 32 random hex characters per run. |
| `--web DIR` | Serve the UI from DIR on disk instead of the embedded files (development). |
| `--data DIR` | Data directory. Default: `%LOCALAPPDATA%\GRMod` on Windows, `$XDG_DATA_HOME/grmod` or `~/.local/share/grmod` elsewhere. |
| `--browser` | Windows: skip WebView2 and open the UI in Edge app mode (or the default browser). |
| `--devtools` | Windows: enable the developer tools and the context menu in the WebView2 window. |
| `--version` | Print the version and exit. |

The development build prints one line, `LISTEN http://127.0.0.1:<port>/ TOKEN <token>`, and serves until it gets SIGINT or SIGTERM. Its volumes are the directories in `GRMOD_DEV_VOLUMES` (separated like `PATH`), and its folder picker "picks" `GRMOD_DEV_PICK`. `GRMOD_FIRMWARE_SITE` replaces the address of Ricoh's site (a local stand-in for tests), and the addresses the page asks to show in a browser are appended to the file named by `GRMOD_DEV_OPENED`. Neither variable is read by the Windows build.

Data directory contents: `log.txt` (rotated to `log.txt.1` above 1 MB; requests, paths and errors, never file contents or the token), `crash.txt` (trace of a Go runtime crash, normally empty), `port`, `store/`, and on Windows the browser profiles `webview/` and `edge/`.

## How the page talks to the shell

The page loads `<script src="/host.js">`, which sets

```js
window.__GRMOD_HOST__ = {"kind":"windows|dev","token":"…","version":"…","os":"windows|linux|…"};
```

and sends the token with every API request in the header `X-GRMod-Token`.

When the UI runs in Edge or the default browser, the shell cannot see the window close. It stops when no API request has arrived for 15 s (after at least one), or after 60 s if none ever arrives. The page should therefore call `GET /api/ping` every few seconds. Browsers slow timers down in hidden tabs; a ping from a Web Worker is not affected as much.

## API

All endpoints are under `/api/`. Request and response bodies are JSON unless noted.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/ping` | | `{"ok":true,"version":"…"}` |
| `GET /api/volumes[?all=1]` | | `{"volumes":[{"id":"E:","root":"E:\\","label":"GR_CARD","fs":"FAT32","total":…,"free":…,"removable":true,"bus":"SD"}]}` |
| `GET /api/list?path=DIR` | | `{"entries":[{"name":"…","dir":false,"size":123,"mtime":1700000000}]}`, sorted by name |
| `POST /api/stat` | `{"path":"…"}` | `{"exists":true,"dir":false,"size":123}` |
| `GET /api/read?path=FILE` | | raw bytes, `application/octet-stream` |
| `PUT /api/write?path=FILE[&overwrite=0]` | raw bytes | `{"size":N,"sha256":"…"}` of the file as read back from the medium |
| `POST /api/move` | `{"from":"…","to":"…"}` | `{"ok":true}` |
| `POST /api/mkdir` | `{"path":"…"}` | `{"ok":true}` (also when it already exists) |
| `POST /api/pick-directory` | `{"title":"…"}` (optional) | `{"path":"C:\\Users\\…"}`, or `{"path":""}` when cancelled |
| `POST /api/reveal` | `{"path":"…"}` | `{"ok":true}` |
| `POST /api/eject` | `{"id":"E:"}` | `{"ok":true}`; 501 `invalid` in the development build |
| `GET /api/store` | | `{"keys":[{"key":"…","size":N}]}` |
| `GET /api/store/KEY` | | raw bytes, or 404 |
| `PUT /api/store/KEY` | raw bytes | `{"ok":true,"size":N}` |
| `DELETE /api/store/KEY` | | `{"ok":true}` (also when the key did not exist) |
| `GET /api/firmware/latest?model=M` | `M` is `STANDARD`, `HDF` or `MONO` | `{"model":"HDF","name":"GR IV","applies":"RICOH GR IV / RICOH GR IV HDF","version":"1.11","date":"2026/02/13","page":"https://…/gr4_s.html","file":"gr4_v111.zip","size":34478368}`; 404 when Ricoh lists nothing for the model |
| `POST /api/firmware/download` | `{"model":"HDF"}` | the firmware file itself (`application/octet-stream`), its name and version in `X-GRMod-Firmware-Name` / `X-GRMod-Firmware-Version` |
| `GET /api/firmware/progress` | | `{"active":true,"received":N,"total":N}` of the running (or last) download |
| `POST /api/firmware/page` | `{"model":"HDF"}` | `{"page":"…"}` after showing the model's download page (with Ricoh's licence terms) in the default browser |

There is deliberately no endpoint that deletes user files.

Errors are `{"error":{"code":"…","message":"…"}}`:

| Code | Status | When |
| --- | --- | --- |
| `forbidden` | 403 | Missing or wrong token, unexpected `Host` or `Origin`, path outside the allowed locations or breaking a path rule |
| `not-found` | 404 | File, directory, key, volume or endpoint does not exist |
| `exists` | 409 | Destination exists (`overwrite=0`, move), or a file is where a directory is needed |
| `invalid` | 400 | Malformed request, wrong kind of file (a directory where a file is needed, …), cross-volume move, bad store key |
| `invalid` | 405 / 409 / 501 | Wrong HTTP method / a folder dialog is already open / eject not implemented on this platform |
| `busy` | 409 | A firmware download is already running |
| `network` | 502 | Ricoh's site could not be reached, or what it sent was not what was expected |
| `too-large` | 413 | More than 256 MiB (file read, file write, store value) or a JSON body over 1 MiB |
| `io` | 500 | The operating system reported an error (medium write-protected, disk full, volume in use, …) |
| `cancelled` | 499 | The upload broke off |

Details worth knowing:

- **write** streams the body to a temporary file (`.grmod-*.tmp`) in the destination directory, flushes it to the medium, renames it over the destination and then reads the destination back. The answer carries the size and SHA-256 of what was read back; if that differs from what was received the request fails with `io`. On any failure the temporary file is removed and the old destination is untouched. Parent directories are created.
- **move** is a rename: same volume only, never replaces anything, creates the destination's parents. On Windows a destination that differs from an existing name only in case counts as existing.
- **volumes**: removable drives, plus fixed drives on a USB, SD or MMC bus. With `all=1` also other fixed drives, marked `"removable":false`. The system drive and the drive that holds the data directory are never listed.
- **store** keys match `^[a-z0-9][a-z0-9._-]{0,63}$`. Values are files named exactly like the key in `<data dir>/store/`. Because of that, keys that Windows would not treat as plain file names are refused on every platform: keys ending in a dot and the device names (`nul`, `con`, `aux`, `prn`, `com0`–`com9`, `lpt0`–`lpt9`, with or without an extension).
- **firmware**: the page names a model and nothing else; the shell reads Ricoh's list of firmware downloads (`/english/support/download_digital.html`), follows the model's row to its page and takes the version, the release date and the link to the archive from there (`internal/ricoh`). Every request, including redirects, has to stay on `www.ricoh-imaging.co.jp` over HTTPS; the archive must be a zip holding exactly one `fwdc*.bin`, which is what the answer carries. Nothing is written to disk by the shell (the page keeps the file in the store). A release that does not name the model (the list has one row for the GR IV and the GR IV HDF) is not offered for it. Answers of the site are remembered for ten minutes. One download at a time; it stops when the page drops the request. Outgoing requests use the proxy from the usual environment variables, else, on Windows, the user's system proxy settings (a set-up script is not evaluated).
- **eject** (Windows) locks the volume, dismounts it and asks the drive to eject the medium. It fails with `io` and changes nothing if any file on the volume is still open. Only volumes of the default listing can be ejected.

## Security rules

- The server listens on `127.0.0.1` only.
- Every request must have `Host: 127.0.0.1:<port>` or `localhost:<port>` (this also covers the UI files and `/host.js`).
- Every `/api/` request must carry the token; an `Origin` header, if present, must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. No CORS headers are ever sent.
- `/host.js` is refused when the browser says the request does not come from the page itself (`Sec-Fetch-Site` other than `same-origin`/`none`), and all responses carry `Cross-Origin-Resource-Policy: same-origin`, so another site cannot include the script to read the token.
- The only outgoing connections are those of the firmware endpoints, to Ricoh's site, and they are made only when the page asks. The page cannot make the shell fetch or open any other address.
- File access is confined to *allowed roots*, evaluated anew for every request: the roots of the volumes currently listed (with `all=1`), plus the folders returned by the folder picker during this run.
- Paths are cleaned and checked before use (`internal/pathguard`):
  - must be absolute; `.` and `..` are resolved, `..` above the volume root is refused;
  - Windows: only `X:\…` drive paths. UNC and device paths (`\\server`, `\\?\`, `\\.\`), drive-relative paths, `:` in a component (alternate data streams), wildcard and reserved characters, components ending in a dot or space, and reserved device names are refused, not repaired;
  - symbolic links are resolved first; the result must still be inside an allowed root. A dangling link is refused. A link that stays inside the allowed roots is followed. Directory junctions and other reparse points in the path are refused;
  - nothing is ever read from or written over a link, device, pipe or socket; links are not moved.

The check and the file operation are separate steps; a local program that swaps a directory for a link in between could still redirect an operation. Such a program can already do anything the user can, so this is accepted.

## Layout

```
main.go, app.go        flags, data directory, log, listener, HTTP server
ui_windows.go          WebView2 window, Edge / default-browser fallback   (Windows only)
internal/server/parked.go  the only endpoints that delete: files below `<volume>\GRMOD\parked-*` and below `<data dir>\backups\parked-*`, addressed by volume ID and a validated relative name, never by path; also listing, reading and backing them up
chrome.go, chrome_windows.go  title-bar colours (DwmSetWindowAttribute) and the WebView2 switches that stop pinch zoom; `POST /api/window/chrome {caption,text,dark}` lets the page report its theme
ui_other.go            headless mode                                      (everything else)
supervise.go           worker-process supervision for the WebView2 window
window.go, browser.go  window sizes, Edge command line, heartbeat rule
internal/server        HTTP API, static files, store, heartbeat
internal/pathguard     path rules for POSIX and Windows, symlink resolution
internal/platform      volumes, folder picker, reveal, eject, system proxy, default browser: windows.go / dev.go; winlogic.go is the testable part
internal/ricoh         finds and fetches the current firmware update on Ricoh's download pages
internal/logfile       rotating log file
tools/genicon          draws the icon
winres/                icon PNGs and resource description; placeholder/ the placeholder page
```

### Why two processes at start-up on Windows

The WebView2 binding ends the process (`log.Fatal`) when the browser environment or controller cannot be created, and a crash in native WebView2 code does the same; neither can be caught. So `GRMod.exe` starts itself again with `--webview-worker`. The worker runs the server and the window; as soon as the window exists it says so and the first process exits. If the worker dies or stays silent for 60 s instead, the first process runs the Edge / default-browser fallback itself.

## Checking the Windows build on a real PC

Nothing Windows-specific can be executed on the Linux build machine. Things to verify by hand:

1. Double-click `GRMod.exe`: a window titled "GR Mod" opens centred, about 1180×800 at 100 % scaling (scaled up on high-DPI displays), cannot be made smaller than 980×640, has the icon, and shows the UI. Task Manager shows one `GRMod.exe` once the window is up. Closing the window ends the process.
2. Storage written by the page (`localStorage`) is still there after a restart.
3. `GRMod.exe --browser`: Edge opens an app window; the process ends about 15 s after that window is closed.
4. WebView2 failure: test on a PC without the WebView2 runtime, or make `%LOCALAPPDATA%\GRMod\webview` unusable (replace the folder by a file; separately, deny write access to it). Edge app mode must open instead, within a few seconds.
5. Insert an SD card: `GET /api/volumes` lists it with label, file system, sizes and bus (`SD` or `USB`); the system drive never appears, also not with `all=1`. An empty card reader produces no error dialog.
6. Write a file to the card through the UI and compare its SHA-256 on another machine; overwrite it; move it.
7. Folder picker: the dialog opens in front of the window and the returned folder becomes usable.
8. Reveal: Explorer opens with the file selected (try a path with spaces and a comma) and opens a folder.
9. Eject: afterwards Explorer shows the reader as empty or the drive as gone; with a file from the card open in another program it fails and the card stays usable.
10. Paths: `\\?\E:\x`, `E:\x.`, `E:\x:stream`, `E:\..\..\Windows` and a junction on an NTFS volume pointing to `C:\Windows` are all refused with 403.
11. Online firmware: the dialog shows version 1.11 with its date and size, the download ends with the firmware open (compare with a manual download: SHA-256 `a2f664df…5655f`), "cancel" during the download stops it, and the licence line opens Ricoh's page in the default browser. Repeat with a system proxy switched on (Settings > Network > Proxy), and offline (a message and "retry", no hang).
