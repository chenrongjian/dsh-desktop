#!/bin/bash
# 完整构建 + 部署脚本：
#   tauri build (--bundles app) → 修复 .app 符号链接 → 手动打 DMG → 部署到 /Applications
# 说明：tauri 自带的 dmg bundle 会重新复制 resources（再次丢失符号链接），
#       所以 DMG 用手动 hdiutil 从修复后的 .app 生成。
set -euo pipefail
cd "$(dirname "$0")/.."

APP_DIR="src-tauri/target/release/bundle/macos"
APP="$APP_DIR/鲸灵.app"
DMG="dist/鲸灵_0.1.1_aarch64.dmg"

echo "== 1/5 tauri build (app) =="
pnpm tauri build --bundles app

echo "== 2/5 修复 .app 符号链接（Tauri 打包会丢失 pnpm 链接）=="
node scripts/relink-resources.mjs "$APP"

echo "== 3/5 手动打 DMG =="
mkdir -p dist /tmp/dmg-staging
rm -rf /tmp/dmg-staging/* 2>/dev/null || true
cp -R "$APP" /tmp/dmg-staging/
ln -sf /Applications /tmp/dmg-staging/Applications
hdiutil create -volname 鲸灵 -srcfolder /tmp/dmg-staging -ov -format UDZO "$DMG"

echo "== 4/5 部署到 /Applications =="
rm -rf /Applications/鲸灵.app
cp -R "$APP" /Applications/
node scripts/relink-resources.mjs "/Applications/鲸灵.app" >/dev/null

echo "== 5/5 签名 =="
codesign --force --deep --sign - --identifier com.dsh.desktop /Applications/鲸灵.app >/dev/null 2>&1 || true

echo "完成: $APP"
ls -lh "$DMG"
