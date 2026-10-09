#!/usr/bin/env bash
# Builds the GR Mod shell.
#
#   ./build.sh dev       -> dist/grmod-dev   (Linux, headless, for development and tests)
#   ./build.sh windows   -> dist/GRMod.exe   (Windows x64, single file, no console)
#   ./build.sh mac       -> dist/GR Mod.app and dist/GRMod-mac.zip
#                           (macOS 11 or later, Intel and Apple silicon in one)
#   ./build.sh all       -> all three
#
# The version comes from $VERSION, else from ../package.json, else 0.0.0.
# Everything is pure Go: no C compiler, no Windows machine and no Mac are
# needed. The Mac bundle is signed ad hoc when rcodesign
# (https://github.com/indygreg/apple-platform-rs) is on the PATH or in
# $RCODESIGN; it is not signed with a Developer ID nor notarised.
set -euo pipefail
cd "$(dirname "$0")"

# ------------------------------------------------------------ Go version
# Always build with the Go release named in go.mod ("toolchain go1.24.7"),
# whatever Go is installed: the go command fetches that release when needed.
# This keeps the binaries identical across machines and keeps the macOS
# build runnable on macOS 11 (Go 1.25 and later require macOS 12 or 13,
# which would contradict LSMinimumSystemVersion below).
go_toolchain="$(sed -n 's/^toolchain[[:space:]]\{1,\}\(go[0-9.]*\)[[:space:]]*$/\1/p' go.mod)"
if [ -z "$go_toolchain" ]; then
  echo "build.sh: no toolchain line in go.mod" >&2; exit 2
fi
export GOTOOLCHAIN="$go_toolchain"
go_actual="$(go env GOVERSION)"
if [ "$go_actual" != "$go_toolchain" ]; then
  echo "build.sh: need $go_toolchain, got $go_actual" >&2; exit 2
fi
echo "go:      $go_actual"

target="${1:-}"
case "$target" in
  dev|windows|mac|all) ;;
  *) echo "usage: $0 dev|windows|mac|all" >&2; exit 2 ;;
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

# write_info_plist FILE writes the bundle's Info.plist.
write_info_plist() {
  cat > "$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>zh_CN</string>
	<key>CFBundleDisplayName</key>
	<string>GR Mod</string>
	<key>CFBundleExecutable</key>
	<string>GRMod</string>
	<key>CFBundleIconFile</key>
	<string>GRMod</string>
	<key>CFBundleIdentifier</key>
	<string>io.github.maxwooow.grmod</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>GR Mod</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.photography</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSHumanReadableCopyright</key>
	<string>GR Mod · GPL-2.0-only</string>
	<key>NSRemovableVolumesUsageDescription</key>
	<string>GR Mod 需要读写存储卡，才能写入固件和关机画面。GR Mod reads and writes the memory card to install firmware and power-off images.</string>
	<key>NSDesktopFolderUsageDescription</key>
	<string>GR Mod 会把文件导出到你选择的文件夹。GR Mod exports files to the folder you choose.</string>
	<key>NSDocumentsFolderUsageDescription</key>
	<string>GR Mod 会把文件导出到你选择的文件夹。GR Mod exports files to the folder you choose.</string>
	<key>NSDownloadsFolderUsageDescription</key>
	<string>GR Mod 会把文件导出到你选择的文件夹。GR Mod exports files to the folder you choose.</string>
	<key>NSAppleEventsUsageDescription</key>
	<string>GR Mod 用系统对话框让你选择导出文件夹。GR Mod uses the system dialog to let you choose an export folder.</string>
</dict>
</plist>
PLIST
}

build_mac() {
  local app="dist/GR Mod.app" tmp="dist/.mac"
  rm -rf "$tmp" "$app" dist/GRMod-mac.zip
  mkdir -p "$tmp" "$app/Contents/MacOS" "$app/Contents/Resources"
  for arch in amd64 arm64; do
    GOOS=darwin GOARCH="$arch" CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X main.version=${version}" \
      -o "$tmp/GRMod-$arch" .
  done
  # One executable for Intel and Apple silicon.
  go tool makefat "$app/Contents/MacOS/GRMod" "$tmp/GRMod-amd64" "$tmp/GRMod-arm64"
  chmod 755 "$app/Contents/MacOS/GRMod"
  rm -rf "$tmp"
  go run ./tools/genicon -out "" -icns "$app/Contents/Resources/GRMod.icns" >/dev/null
  write_info_plist "$app/Contents/Info.plist"
  printf 'APPL????' > "$app/Contents/PkgInfo"

  local rcodesign="${RCODESIGN:-$(command -v rcodesign || true)}"
  if [ -n "$rcodesign" ] && [ -x "$rcodesign" ]; then
    if ! out="$("$rcodesign" sign "$app" 2>&1)"; then
      echo "$out" >&2
      echo "build.sh: signing failed" >&2
      exit 1
    fi
    echo "signed:  ad hoc (rcodesign)"
  else
    echo "signed:  WARNING: rcodesign not found, the bundle is NOT signed;" >&2
    echo "         Apple silicon Macs refuse unsigned bundles as \"damaged\"" >&2
  fi
  go run ./tools/zipapp -out dist/GRMod-mac.zip "$app" >/dev/null
  echo "built:   dist/GR Mod.app, dist/GRMod-mac.zip ($(wc -c < dist/GRMod-mac.zip | tr -d ' ') bytes, version ${version})"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "sha256:  $(sha256sum dist/GRMod-mac.zip | cut -d' ' -f1)"
  fi
}

case "$target" in
  dev)     build_dev ;;
  windows) build_windows ;;
  mac)     build_mac ;;
  all)     build_dev; build_windows; build_mac ;;
esac
