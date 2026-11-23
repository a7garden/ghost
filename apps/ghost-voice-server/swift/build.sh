#!/bin/sh
# Builds bin/apple-stt (needs macOS 26+ and the Swift toolchain). The embedded Info.plist is required:
# without it the Speech framework traps in a bare command-line binary.
set -eu
cd "$(dirname "$0")"
mkdir -p ../bin
cat > ../bin/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.projectoxi.ghost.apple-stt</string>
<key>CFBundleName</key><string>apple-stt</string>
<key>NSSpeechRecognitionUsageDescription</key><string>Ghost 통화의 음성을 기기 안에서 글로 바꿉니다.</string>
</dict></plist>
PLIST
swiftc -O apple_stt.swift -o ../bin/apple-stt -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker ../bin/Info.plist
rm ../bin/Info.plist
echo "built $(cd .. && pwd)/bin/apple-stt"
