#!/usr/bin/env bash
# Builds the GR Mod shell.
#
#   ./build.sh dev       -> dist/grmod-dev   (Linux, headless, for development and tests)
#   ./build.sh windows   -> dist/GRMod.exe   (Windows x64, single file, no console)
#   ./build.sh macos     -> dist/GR Mod.app (native architecture, local browser UI)
#   ./build.sh all       -> both
#
# The version comes from $VERSION, else from ../package.json, else 0.0.0.
# Everything is pure Go: no C compiler and no Windows machine are needed.
set -euo pipefail
cd "$(dirname "$0")"

target="${1:-}"
case "$target" in
  dev|windows|macos|all) ;;
  *) echo "usage: $0 dev|windows|macos|all" >&2; exit 2 ;;
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

build_macos() {
  [ "$(uname -s)" = Darwin ] || { echo 'macos packaging requires macOS' >&2; exit 2; }
  local bundle='dist/GR Mod.app'
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
  CGO_ENABLED=0 GOOS=darwin go build -trimpath \
    -ldflags "-s -w -X main.version=${version}" -o "$bundle/Contents/MacOS/grmod" .
  cat > "$bundle/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.maxwooow.grmod.local-gr3x</string>
<key>CFBundleName</key><string>GR Mod</string>
<key>CFBundleDisplayName</key><string>GR Mod</string>
<key>CFBundleExecutable</key><string>grmod</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version%%-*}</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSUIElement</key><true/>
</dict></plist>
EOF
  local icons='dist/AppIcon.iconset'
  mkdir -p "$icons"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" winres/icon256.png --out "$icons/icon_${size}x${size}.png" >/dev/null
    local double=$((size * 2))
    sips -z "$double" "$double" winres/icon256.png --out "$icons/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$icons" -o "$bundle/Contents/Resources/AppIcon.icns"
  cp ../LICENSE "$bundle/Contents/Resources/LICENSE.txt"
  cp ../docs/GR3X_ADJ9_TEST.txt "$bundle/Contents/Resources/ADJ9-T4.txt"
  cp ../docs/GR3X_FEATURES_TEST.txt "$bundle/Contents/Resources/GR3x-T4F1.txt"
  cp ../docs/GR3X_T5_TEST.txt "$bundle/Contents/Resources/GR3x-T5.txt"
  cp ../docs/GR3X_T5-L1_TEST.txt "$bundle/Contents/Resources/GR3x-T5-L1.txt"
  cp ../docs/GR3X_T6_TEST.txt "$bundle/Contents/Resources/GR3x-T6.txt"
  cp ../docs/GR3X_T6_J1_TEST.txt "$bundle/Contents/Resources/GR3x-T6-J1.txt"
  cp ../docs/GR3X_T6_J1_W2_TEST.txt "$bundle/Contents/Resources/GR3x-T6-J1-W2.txt"
  cp ../docs/GRMOD_INTEGRATION.txt "$bundle/Contents/Resources/本次更新说明.txt"
  cp ../docs/FILM_LIBRARY_120.txt "$bundle/Contents/Resources/胶片库120-使用说明.txt"
  codesign --force --sign - "$bundle"
  echo "built:   $bundle (version ${version})"
}

case "$target" in
  dev)     build_dev ;;
  windows) build_windows ;;
  macos)   build_macos ;;
  all)     build_dev; build_windows ;;
esac
