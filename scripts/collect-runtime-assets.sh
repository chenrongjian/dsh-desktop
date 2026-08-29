#!/bin/bash
# 从本地构建的 dsh-runtime 提取构建产物到 vendor/dsh-runtime-assets/
# 供 CI 装配内置 runtime（无需现场编译 deepseek-harness）。
# 用法: bash scripts/collect-runtime-assets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="src-tauri/binaries/dsh-runtime"
DEST="vendor/dsh-runtime-assets"

[ -d "$SRC/apps/web/dist" ] || { echo "错误: 缺少 $SRC/apps/web/dist（请先在本地构建完整 runtime）"; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"

cp -R "$SRC/apps/web/dist" "$DEST/web-dist"
cp -R "$SRC/apps/cli/lib" "$DEST/cli-lib"

# packages / vendor 下的构建产物树（lib/），保持相对路径
rsync -a --include='*/' --include='lib/***' --exclude='*' "$SRC/packages/" "$DEST/packages/"
rsync -a --include='*/' --include='lib/***' --exclude='*' "$SRC/vendor/" "$DEST/vendor/"

# native（landlock-run 等，含预编译产物）
rsync -a --exclude='node_modules' "$SRC/native/" "$DEST/native/"

echo "== 完成 =="
du -sh "$DEST"
find "$DEST" -type f | wc -l
