#!/usr/bin/env bash
# Builds the GR Mod shell.
#
#   ./build.sh dev       -> dist/grmod-dev   (Linux, headless, for development and tests)
#   ./build.sh windows   -> dist/GRMod.exe   (Windows x64, single file, no console)
#   ./build.sh all       -> both
#
# The version comes from $VERSION, else from ../package.json, else 0.0.0.
# Everything is pure Go: no C compiler and no Windows machine are needed.
set -euo pipefail
cd "$(dirname "$0")"

target="${1:-}"
case "$target" in
  dev|windows|all) ;;
  *) echo "usage: $0 dev|windows|all" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------- version
version="${VERSION:-}"
if [ -z "$version" ] && [ -f ../package.json ]; then
  version="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' ../package.json | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
fi
version="${version:-0.0.0}"
case "$version" in
  *[!0-9A-Za-z.+_-]*) echo "build.sh: unusable version '$version'" >&2; exit 2 ;;
esac

# --------------------------------------------------------------- UI files
# web/ is what gets embedded. If the UI has been built, web/ is replaced by
# a copy of it; otherwise whatever is there is kept (the placeholder page,
# which is recreated if web/ is missing, e.g. in a fresh checkout).
if [ -f ../ui/dist/index.html ]; then
  rm -rf web.new
  cp -R ../ui/dist web.new
  rm -rf web
  mv web.new web
  echo "ui:      copied ../ui/dist ($(find web -type f | wc -l | tr -d ' ') files)"
elif [ -f web/index.html ]; then
  echo "ui:      ../ui/dist/index.html not found, keeping the current web/"
else
  mkdir -p web
  cp placeholder/index.html web/index.html
  echo "ui:      ../ui/dist/index.html not found, using the placeholder page"
fi

mkdir -p dist

build_dev() {
  CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags "-X main.version=${version}" \
    -o dist/grmod-dev .
  echo "built:   dist/grmod-dev ($(wc -c < dist/grmod-dev | tr -d ' ') bytes, version ${version})"
}

# make_resources (re)generates rsrc_windows_amd64.syso, the object file that
# carries the icon, the manifest (per-monitor-v2 DPI awareness, asInvoker)
# and the version information. "go build" links any .syso it finds.
make_resources() {
  local winres
  winres="$(command -v go-winres || true)"
  if [ -z "$winres" ] && [ -x "$(go env GOPATH)/bin/go-winres" ]; then
    winres="$(go env GOPATH)/bin/go-winres"
  fi
  if [ -n "$winres" ]; then
    local args=(make --in winres/winres.json --arch amd64 --out rsrc)
    if [[ "$version" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]]; then
      args+=(--product-version "$version" --file-version "$version")
    fi
    "$winres" "${args[@]}"
    echo "winres:  generated rsrc_windows_amd64.syso"
  elif [ -f rsrc_windows_amd64.syso ]; then
    echo "winres:  go-winres not installed, using the existing rsrc_windows_amd64.syso"
    echo "         (go install github.com/tc-hib/go-winres@v0.3.3 to regenerate it)"
  else
    echo "winres:  WARNING: no go-winres and no .syso: building WITHOUT icon and manifest" >&2
  fi
}

build_windows() {
  make_resources
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
    -ldflags "-H windowsgui -s -w -X main.version=${version}" \
    -o dist/GRMod.exe .
  echo "built:   dist/GRMod.exe ($(wc -c < dist/GRMod.exe | tr -d ' ') bytes, version ${version})"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "sha256:  $(sha256sum dist/GRMod.exe | cut -d' ' -f1)"
  fi
}

case "$target" in
  dev)     build_dev ;;
  windows) build_windows ;;
  all)     build_dev; build_windows ;;
esac
