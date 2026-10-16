#!/bin/zsh
set -euo pipefail
cd -- "${0:A:h}"
APP="Codex Relay.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc -swift-version 5 -O -framework AppKit Sources/RelayApp.swift -o "$APP/Contents/MacOS/CodexRelay"
cp Resources/monitor.mjs Resources/LICENSE-codex-auto-resume.txt THIRD_PARTY_NOTICES.md README.md LICENSE "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Codex Relay</string>
<key>CFBundleDisplayName</key><string>Codex Relay</string>
<key>CFBundleIdentifier</key><string>local.codexrelay.menubar</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleExecutable</key><string>CodexRelay</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP"
print "Built: ${PWD}/${APP}"
