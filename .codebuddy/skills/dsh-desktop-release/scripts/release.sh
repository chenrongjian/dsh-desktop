#!/usr/bin/env bash
# dsh-desktop 版本发布脚本
#
# 用法:
#   bash release.sh 0.1.1            升版本号到 0.1.1 并发布(常规流程)
#   bash release.sh v0.1.1           同上(v 前缀自动去除)
#   bash release.sh 0.1.1 --no-bump  不改版本号,直接用当前版本打 tag 发布
#   bash release.sh --help           显示帮助
#
# 环境变量:
#   DSH_DESKTOP_DIR   项目路径(默认 ~/WorkBuddy/DeepSeek/desktop/dsh-desktop)
set -euo pipefail

PROJECT_DIR="${DSH_DESKTOP_DIR:-$HOME/WorkBuddy/DeepSeek/desktop/dsh-desktop}"
NO_BUMP=0
VERSION=""

for arg in "$@"; do
  case "$arg" in
    --no-bump) NO_BUMP=1 ;;
    -h|--help)
      echo "用法: bash release.sh <版本号> [--no-bump]"
      echo "示例: bash release.sh 0.1.1"
      exit 0
      ;;
    *) VERSION="$arg" ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "错误: 缺少版本号,用法: bash release.sh 0.1.1" >&2
  exit 1
fi

VER="${VERSION#v}"
if ! echo "$VER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "错误: 版本号格式无效: $VER (需要如 0.1.1)" >&2
  exit 1
fi
TAG="v$VER"

cd "$PROJECT_DIR" || { echo "错误: 找不到项目目录 $PROJECT_DIR" >&2; exit 1; }

# 检查工作区是否干净
if [ -n "$(git status --porcelain)" ]; then
  echo "错误: 工作区有未提交改动,请先提交或 stash 后再发布:" >&2
  git status --porcelain >&2
  exit 1
fi

CUR_PKG=$(node -p "require('./package.json').version" 2>/dev/null || echo "?")
CUR_TAURI=$(node -p "require('./src-tauri/tauri.conf.json').version" 2>/dev/null || echo "?")
echo "当前版本: package.json=$CUR_PKG  tauri.conf.json=$CUR_TAURI  目标版本: $VER"

if [ "$NO_BUMP" = "1" ]; then
  if [ "$CUR_PKG" != "$VER" ] || [ "$CUR_TAURI" != "$VER" ]; then
    echo "错误: --no-bump 模式要求现有版本已为 $VER,当前为 $CUR_PKG / $CUR_TAURI" >&2
    echo "请先同步版本号,或去掉 --no-bump 由脚本自动升级。" >&2
    exit 1
  fi
  echo "版本号不变,直接打 tag $TAG"
else
  # 同步两处版本号
  sed -i.bak -E "s/\"version\": *\"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"$VER\"/" package.json src-tauri/tauri.conf.json
  rm -f package.json.bak src-tauri/tauri.conf.json.bak
  NEW_PKG=$(node -p "require('./package.json').version")
  NEW_TAURI=$(node -p "require('./src-tauri/tauri.conf.json').version")
  if [ "$NEW_PKG" != "$VER" ] || [ "$NEW_TAURI" != "$VER" ]; then
    echo "错误: 版本号更新失败,当前为 $NEW_PKG / $NEW_TAURI" >&2
    exit 1
  fi
  echo "版本号已更新 -> $VER"
  git add package.json src-tauri/tauri.conf.json
  git commit -m "chore: bump version to $VER"
  git push origin HEAD
  echo "已推送 main"
fi

# 打 tag 并推送,触发 CI
git tag "$TAG"
git push origin "$TAG"
echo ""
echo "✅ tag $TAG 已推送,CI 已触发"
echo "构建完成后自动发布到 https://github.com/chenrongjian/dsh-desktop/releases/tag/$TAG"
echo "监控与验证方法见 SKILL.md"
