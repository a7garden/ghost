#!/bin/bash
set -euo pipefail

# Build "Ghost Control.app" into OUT_DIR. With a Developer ID identity the bundle keeps one macOS privacy
# identity (bundle ID + team) across releases, so the owner's Accessibility and Screen Recording grant survives
# updates. Without one it is ad hoc signed: fine for protocol tests, but macOS treats every build as new.
#   apps/ghost-control/build.sh OUT_DIR VERSION [SIGNING_IDENTITY]
if [[ $# -lt 2 || $# -gt 3 || $(uname -sm) != "Darwin arm64" ]]; then
  echo "usage on Apple Silicon: $0 OUT_DIR VERSION [SIGNING_IDENTITY]" >&2
  exit 2
fi
here=$(cd -P -- "$(dirname -- "$0")" && pwd)
out=$1
version=$2
identity=${3:-}
app="$out/Ghost Control.app"
bundle_id=${GHOST_CONTROL_BUNDLE_ID:-dev.projectoxi.ghost.control}
rm -rf -- "$app"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$bundle_id</string>
<key>CFBundleName</key><string>Ghost Control</string>
<key>CFBundleDisplayName</key><string>Ghost Control</string>
<key>CFBundleExecutable</key><string>ghost-control</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>$version</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
/usr/bin/swiftc -O -target arm64-apple-macos14 -o "$app/Contents/MacOS/ghost-control" "$here/main.swift"
if [[ -n $identity ]]; then
  /usr/bin/codesign --force --sign "$identity" --timestamp --options runtime "$app"
else
  /usr/bin/codesign --force --sign - "$app"
fi
/usr/bin/codesign --verify --strict "$app"
echo "$app"
