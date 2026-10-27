#!/bin/zsh
# 双击运行：确保 ~/Applications 中安装的是当前源码版本，然后打开应用。
set -e
PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
APP_PATH="$HOME/Applications/身体手记.app"
ZIP="$PROJECT_DIR/release/身体手记-mac-arm64.zip"
SOURCE_VERSION="$(sed -n 's/^  "version": "\([0-9][0-9.]*\)",$/\1/p' "$PROJECT_DIR/package.json" | head -1)"
INSTALLED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)"
if [[ ! -d "$APP_PATH" || ( -n "$SOURCE_VERSION" && "$INSTALLED_VERSION" != "$SOURCE_VERSION" ) ]]; then
  if [[ ! -f "$ZIP" ]]; then
    echo "找不到安装包：$ZIP" >&2
    echo "请先在项目目录运行 npm run package，或从 GitHub Releases 下载 body-journal-mac-arm64.zip 放进 release/。" >&2
    echo "按回车键关闭窗口。"
    read -r _
    exit 1
  fi
  echo "正在安装身体手记 ${SOURCE_VERSION:-新版本}…"
  mkdir -p "$HOME/Applications"
  rm -rf "$APP_PATH"
  ditto -x -k "$ZIP" "$HOME/Applications"
fi
open "$APP_PATH"
