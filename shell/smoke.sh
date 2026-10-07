#!/usr/bin/env bash
# End-to-end smoke test: starts the development build on a temporary
# directory and exercises the HTTP API with curl.
#
#   ./build.sh dev && ./smoke.sh [path/to/grmod-dev]
set -uo pipefail
cd "$(dirname "$0")"

bin="${1:-dist/grmod-dev}"
[ -x "$bin" ] || { echo "smoke: $bin not found; run ./build.sh dev first" >&2; exit 2; }

work="$(mktemp -d)"
pid=""
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/web" "$work/card/DCIM" "$work/outside" "$work/data"
printf '<!doctype html><title>smoke ui</title>' > "$work/web/index.html"
printf 'top secret' > "$work/outside/secret.txt"
head -c 300000 /dev/urandom > "$work/payload.bin"

GRMOD_DEV_VOLUMES="$work/card" GRMOD_DEV_PICK="" \
  "$bin" --web "$work/web" --data "$work/data" > "$work/stdout" 2> "$work/stderr" &
pid=$!

for _ in $(seq 100); do
  grep -q '^LISTEN ' "$work/stdout" 2>/dev/null && break
  sleep 0.05
done
if ! read -r word url tokenword token < "$work/stdout" || [ "$word" != LISTEN ] || [ "$tokenword" != TOKEN ]; then
  echo "smoke: no LISTEN line; stdout: $(cat "$work/stdout"); stderr: $(cat "$work/stderr")" >&2
  exit 1
fi
base="${url%/}"
echo "server:  $(cat "$work/stdout" | sed "s/$token/<token>/")"

fails=0
pass() { echo "ok      $1"; }
fail() { echo "FAIL    $1: $2"; fails=$((fails + 1)); }

# req NAME EXPECTED_STATUS [curl args...]  -- body ends up in $work/body
req() {
  local name="$1" want="$2" got
  shift 2
  got="$(curl -sS -o "$work/body" -w '%{http_code}' "$@" 2>"$work/curl.err")" || got="curl-error: $(cat "$work/curl.err")"
  if [ "$got" = "$want" ]; then pass "$name ($got)"; else fail "$name" "status $got, want $want; body: $(head -c 300 "$work/body")"; fi
}
# body_has NAME TEXT
body_has() {
  if grep -qF -- "$2" "$work/body"; then pass "$1"; else fail "$1" "body lacks '$2': $(head -c 300 "$work/body")"; fi
}
auth=(-H "X-GRMod-Token: $token")
enc() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

# --- static files and host.js
req "GET /" 200 "$base/"
body_has "index.html is served from --web" "smoke ui"
req "SPA fallback" 200 "$base/some/client/route"
body_has "fallback returns index.html" "smoke ui"
req "GET /host.js" 200 "$base/host.js"
body_has "host.js defines the host object" 'window.__GRMOD_HOST__ = {"kind":"dev","token":"'"$token"'"'
req "host.js refused cross-site" 403 -H "Sec-Fetch-Site: cross-site" "$base/host.js"
cc="$(curl -sS -o /dev/null -D - "$base/" | tr -d '\r' | grep -i '^cache-control:' | head -n 1)"
if [ "$cc" = "Cache-Control: no-store" ]; then pass "Cache-Control: no-store"; else fail "Cache-Control" "$cc"; fi

# --- security
req "ping without token" 403 "$base/api/ping"
body_has "error body has the forbidden code" '"code":"forbidden"'
req "ping with wrong token" 403 -H "X-GRMod-Token: 00000000000000000000000000000000" "$base/api/ping"
req "ping with foreign Host" 403 "${auth[@]}" -H "Host: evil.example" "$base/api/ping"
req "ping with foreign Origin" 403 "${auth[@]}" -H "Origin: https://evil.example" "$base/api/ping"
req "ping with own Origin" 200 "${auth[@]}" -H "Origin: $base" "$base/api/ping"
req "volumes without token" 403 "$base/api/volumes"
req "write without token" 403 -X PUT --data-binary x "$base/api/write?path=$(enc "$work/card/nope.bin")"
if [ -e "$work/card/nope.bin" ]; then fail "write without token" "file was created"; else pass "write without token created nothing"; fi
cors="$(curl -sS -o /dev/null -D - "${auth[@]}" -H "Origin: $base" "$base/api/ping" | grep -ci '^access-control-')"
if [ "$cors" = 0 ]; then pass "no CORS headers"; else fail "no CORS headers" "$cors found"; fi

# --- ping, volumes
req "ping" 200 "${auth[@]}" "$base/api/ping"
body_has "ping body" '{"ok":true,"version":"'
req "volumes" 200 "${auth[@]}" "$base/api/volumes"
body_has "volume from GRMOD_DEV_VOLUMES" '"id":"card","root":"'"$work/card"'"'
body_has "volume is DEV and removable" '"fs":"DEV"'
req "volumes all=1" 200 "${auth[@]}" "$base/api/volumes?all=1"

# --- write, read, list, stat
file="$work/card/DCIM/100RICOH/fw.bin"
want_sha="$(sha256sum "$work/payload.bin" | cut -d' ' -f1)"
req "write (creates parents)" 200 "${auth[@]}" -X PUT --data-binary "@$work/payload.bin" "$base/api/write?path=$(enc "$file")"
body_has "write returns the read-back sha256" '"sha256":"'"$want_sha"'"'
body_has "write returns the size" '"size":300000'
if cmp -s "$work/payload.bin" "$file"; then pass "file on disk is identical"; else fail "file on disk" "differs"; fi
if find "$work/card" -name '.grmod-*' | grep -q .; then fail "temp files" "left behind"; else pass "no temp file left behind"; fi
req "write overwrite=0 on existing" 409 "${auth[@]}" -X PUT --data-binary x "$base/api/write?overwrite=0&path=$(enc "$file")"
body_has "error code exists" '"code":"exists"'
req "read" 200 "${auth[@]}" "$base/api/read?path=$(enc "$file")"
if cmp -s "$work/payload.bin" "$work/body"; then pass "read returns the same bytes"; else fail "read" "bytes differ"; fi
req "read missing" 404 "${auth[@]}" "$base/api/read?path=$(enc "$work/card/missing.bin")"
req "list" 200 "${auth[@]}" "$base/api/list?path=$(enc "$work/card/DCIM/100RICOH")"
body_has "list entry" '{"name":"fw.bin","dir":false,"size":300000,"mtime":'
req "list missing dir" 404 "${auth[@]}" "$base/api/list?path=$(enc "$work/card/none")"
req "stat" 200 "${auth[@]}" -X POST -d "{\"path\":\"$file\"}" "$base/api/stat"
body_has "stat body" '{"exists":true,"dir":false,"size":300000}'
req "mkdir" 200 "${auth[@]}" -X POST -d "{\"path\":\"$work/card/a/b\"}" "$base/api/mkdir"
[ -d "$work/card/a/b" ] && pass "mkdir created the directory" || fail "mkdir" "directory missing"

# --- move
req "move" 200 "${auth[@]}" -X POST -d "{\"from\":\"$file\",\"to\":\"$work/card/moved/fw2.bin\"}" "$base/api/move"
if [ ! -e "$file" ] && cmp -s "$work/payload.bin" "$work/card/moved/fw2.bin"; then pass "move renamed the file"; else fail "move" "result wrong"; fi
req "move missing source" 404 "${auth[@]}" -X POST -d "{\"from\":\"$file\",\"to\":\"$work/card/x.bin\"}" "$base/api/move"
printf other > "$work/card/other.bin"
req "move onto existing" 409 "${auth[@]}" -X POST -d "{\"from\":\"$work/card/other.bin\",\"to\":\"$work/card/moved/fw2.bin\"}" "$base/api/move"

# --- confinement
req "read outside the volume" 403 "${auth[@]}" "$base/api/read?path=$(enc "$work/outside/secret.txt")"
req "read with .." 403 "${auth[@]}" "$base/api/read?path=$(enc "$work/card/../outside/secret.txt")"
req "write outside the volume" 403 "${auth[@]}" -X PUT --data-binary x "$base/api/write?path=$(enc "$work/outside/new.txt")"
req "list the data directory" 403 "${auth[@]}" "$base/api/list?path=$(enc "$work/data")"
req "relative path" 403 "${auth[@]}" "$base/api/list?path=card"
ln -s "$work/outside" "$work/card/link"
req "read through a symlink leaving the volume" 403 "${auth[@]}" "$base/api/read?path=$(enc "$work/card/link/secret.txt")"
req "write through a symlink leaving the volume" 403 "${auth[@]}" -X PUT --data-binary x "$base/api/write?path=$(enc "$work/card/link/new.txt")"
if [ "$(cat "$work/outside/secret.txt")" = "top secret" ] && [ "$(ls "$work/outside")" = "secret.txt" ]; then pass "outside directory untouched"; else fail "outside directory" "changed"; fi
req "no delete endpoint" 404 "${auth[@]}" -X POST -d "{\"path\":\"$work/card/other.bin\"}" "$base/api/delete"
req "DELETE on a file endpoint" 405 "${auth[@]}" -X DELETE "$base/api/read?path=$(enc "$work/card/other.bin")"
[ -f "$work/card/other.bin" ] && pass "user file still there" || fail "user file" "gone"

# --- pick-directory (development build: nothing picked), reveal, eject
req "pick-directory" 200 "${auth[@]}" -X POST -d '{"title":"Pick"}' "$base/api/pick-directory"
body_has "pick-directory cancelled" '{"path":""}'
req "reveal" 200 "${auth[@]}" -X POST -d "{\"path\":\"$work/card\"}" "$base/api/reveal"
req "eject (not implemented in the dev build)" 501 "${auth[@]}" -X POST -d '{"id":"card"}' "$base/api/eject"

# --- store
req "store get missing" 404 "${auth[@]}" "$base/api/store/settings.json"
req "store put" 200 "${auth[@]}" -X PUT --data-binary '{"theme":"dark"}' "$base/api/store/settings.json"
req "store get" 200 "${auth[@]}" "$base/api/store/settings.json"
body_has "store value" '{"theme":"dark"}'
[ "$(cat "$work/data/store/settings.json")" = '{"theme":"dark"}' ] && pass "store file is in <data>/store" || fail "store file" "missing or wrong"
req "store list" 200 "${auth[@]}" "$base/api/store"
body_has "store list body" '{"keys":[{"key":"settings.json","size":16}]}'
req "store bad key" 400 "${auth[@]}" -X PUT --data-binary x "$base/api/store/Bad%20Key"
req "store delete" 200 "${auth[@]}" -X DELETE "$base/api/store/settings.json"
req "store get after delete" 404 "${auth[@]}" "$base/api/store/settings.json"

# --- log
if [ -s "$work/data/log.txt" ]; then pass "log.txt written"; else fail "log.txt" "missing or empty"; fi
if grep -qF "$token" "$work/data/log.txt"; then fail "log.txt" "contains the token"; else pass "log.txt does not contain the token"; fi

# --- shutdown
kill -TERM "$pid"; wait "$pid"; code=$?; pid=""
if [ "$code" = 0 ]; then pass "clean exit on SIGTERM"; else fail "exit" "code $code"; fi

echo
if [ "$fails" = 0 ]; then echo "smoke test passed"; else echo "smoke test: $fails check(s) FAILED"; exit 1; fi
