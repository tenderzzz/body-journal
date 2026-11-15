#!/bin/zsh
# 双击运行：升级到当前版本并打开应用。已安装的版本在解压和验证成功后才替换。
set -eu
PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
APP_DIR="$HOME/Applications"
APP_PATH="$APP_DIR/身体手记.app"
ZIP="$PROJECT_DIR/release/身体手记-mac-arm64.zip"
bundle_value() { /usr/libexec/PlistBuddy -c "Print $2" "$1/Contents/Info.plist"; }
SOURCE_VERSION="$(sed -n 's/^  "version": "\([0-9][0-9.]*\)",$/\1/p' "$PROJECT_DIR/package.json" | head -1)"
INSTALLED_VERSION="$(bundle_value "$APP_PATH" CFBundleShortVersionString 2>/dev/null || true)"
if [[ ! -d "$APP_PATH" || ( -n "$SOURCE_VERSION" && "$INSTALLED_VERSION" != "$SOURCE_VERSION" ) ]]; then
  if [[ ! -f "$ZIP" ]]; then
    echo "找不到安装包：$ZIP" >&2
    echo "请先运行 npm run package，或将已下载的安装包放在上述位置。" >&2
    exit 1
  fi
  echo "正在安装身体手记 ${SOURCE_VERSION}…"
  mkdir -p "$APP_DIR"
  stage_dir="$(mktemp -d "$APP_DIR/.bodyjournal-install.XXXXXX")"
  cleanup() {
    if [[ -d "$stage_dir/previous.app" && ! -e "$APP_PATH" ]]; then
      /bin/mv "$stage_dir/previous.app" "$APP_PATH" || return
    fi
    /bin/rm -rf "$stage_dir"
  }
  trap cleanup EXIT
  /usr/bin/ditto -x -k "$ZIP" "$stage_dir"
  candidate="$stage_dir/身体手记.app"
  [[ "$(bundle_value "$candidate" CFBundleIdentifier)" == "local.bodyjournal.personal" ]]
  [[ "$(bundle_value "$candidate" CFBundleShortVersionString)" == "$SOURCE_VERSION" ]]
  /usr/bin/codesign --verify --deep --strict "$candidate"
  if [[ -d "$APP_PATH" ]]; then
    /usr/bin/osascript - "$APP_PATH" <<'APPLESCRIPT'
on run argv
    set targetApp to (POSIX file (item 1 of argv)) as alias
    tell application (targetApp as text)
        if it is running then quit
    end tell
end run
APPLESCRIPT
    /bin/mv "$APP_PATH" "$stage_dir/previous.app"
  fi
  /bin/mv "$candidate" "$APP_PATH"
fi
/usr/bin/open "$APP_PATH"
