#!/bin/sh
# 갓 노트 맥 실행 아이콘(.app) 만들기: ./build.sh  →  build/갓 노트.app
set -e
cd "$(dirname "$0")"
URL="https://huhudldl.github.io/godnote/"
APP="build/갓 노트.app"
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build/icon.iconset
swiftc -O make-icon.swift -o build/make-icon 2>/dev/null
./build/make-icon ../icons/icon-1024.png build/icon-1024.png
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon-1024.png --out build/icon.iconset/icon_${s}x${s}.png >/dev/null
  d=$((s * 2)); sips -z $d $d build/icon-1024.png --out build/icon.iconset/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns build/icon.iconset -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/MacOS/godnote" <<SH
#!/bin/sh
# 크롬이 있으면 주소창 없는 앱 창으로, 없으면 사파리로 엽니다
URL="$URL"
if [ -d "/Applications/Google Chrome.app" ]; then
  exec open -na "Google Chrome" --args --app="\$URL" --window-size=1280,900
else
  exec open -a Safari "\$URL"
fi
SH
chmod +x "$APP/Contents/MacOS/godnote"

cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>갓 노트</string>
  <key>CFBundleDisplayName</key><string>갓 노트</string>
  <key>CFBundleIdentifier</key><string>io.github.huhudldl.godnote.launcher</string>
  <key>CFBundleExecutable</key><string>godnote</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
PL
codesign --force -s - "$APP" 2>/dev/null || true
echo "완료: $APP"
