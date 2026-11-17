#!/bin/zsh
# 在用户的 Mac 上签名并打开手机步数入口。签名文件保存在下载目录。
set -eu
STEP_SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
STEP_OUTPUT_DIR="$HOME/Downloads/身体手记快捷指令"
STEP_OUTPUT="$STEP_OUTPUT_DIR/身体手记·记步数.shortcut"
STEP_STAGE=""
cleanup() {
  if [[ -n "$STEP_STAGE" && -d "$STEP_STAGE" ]]; then /bin/rm -rf "$STEP_STAGE"; fi
}
trap cleanup EXIT
mkdir -p "$STEP_OUTPUT_DIR"
STEP_STAGE="$(mktemp -d "$STEP_OUTPUT_DIR/.steps-sign.XXXXXX")"
echo '正在签名记步数 v2026.11.17（修复输入后多出文本框）…'
if ! /usr/bin/shortcuts sign --mode anyone \
  --input "$STEP_SCRIPT_DIR/unsigned/身体手记·记步数.shortcut" \
  --output "$STEP_STAGE/身体手记·记步数.shortcut"; then
  echo '签名未完成。请确认已登录 Apple 账号、可联网并能打开“快捷指令”，然后重试。'
  read -r '?按回车关闭。'
  exit 1
fi
[[ -s "$STEP_STAGE/身体手记·记步数.shortcut" ]]
/bin/mv "$STEP_STAGE/身体手记·记步数.shortcut" "$STEP_OUTPUT"
echo "已签名并保存：$STEP_OUTPUT"
echo '安装时选择与 Mac 相同的 BodyJournal/inbox 文件夹。'
echo '遇到同名提示请选择替换旧版；确认快捷指令顶部注释为“记步数 v2026.11.17”，避免继续运行旧入口。'
echo '可通过快捷指令的 iCloud 同步在 iPhone 使用，也可以把下载目录里的签名文件 AirDrop 到 iPhone。'
/usr/bin/open "$STEP_OUTPUT"
