#!/bin/zsh
# 从当前版本打开隔离示例。已安装的正式应用可以继续运行。
set -eu
project_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
app_path="$HOME/Applications/身体手记.app"
zip="$project_dir/release/身体手记-mac-arm64.zip"
source_version="$(sed -n 's/^  "version": "\([0-9][0-9.]*\)",$/\1/p' "$project_dir/package.json" | head -1)"
version_of() { /usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$1/Contents/Info.plist"; }
if [[ -d "$app_path" && "$(version_of "$app_path")" == "$source_version" ]]; then
  /usr/bin/open -n "$app_path" --args --demo
  exit 0
fi
if [[ ! -f "$zip" ]]; then
  echo "请将当前版本的 Mac 安装包放在 $zip 后重新打开示例。" >&2
  exit 1
fi
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/bodyjournal-demo.XXXXXX")"
trap '/bin/rm -rf "$stage_dir"' EXIT
/usr/bin/ditto -x -k "$zip" "$stage_dir"
candidate="$stage_dir/身体手记.app"
[[ "$(version_of "$candidate")" == "$source_version" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$candidate/Contents/Info.plist")" == "local.bodyjournal.personal" ]]
/usr/bin/codesign --verify --deep --strict "$candidate"
/usr/bin/open -W -n "$candidate" --args --demo
