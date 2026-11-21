#!/bin/zsh
set -eu

shortcut_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
output_dir="$HOME/Downloads/身体手记快捷指令"
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/bodyjournal-sign.XXXXXX")"
trap '/bin/rm -rf -- "$stage_dir"' EXIT

entries=('身体手记·记一餐' '身体手记·记身体')
if [[ ${1:-} == '记一餐' ]]; then
  entries=('身体手记·记一餐')
fi
for entry in "${entries[@]}"; do
  echo "正在签名 $entry…"
  if ! /usr/bin/shortcuts sign --mode anyone \
    --input "$shortcut_dir/unsigned/$entry.shortcut" \
    --output "$stage_dir/$entry.shortcut" || [[ ! -s "$stage_dir/$entry.shortcut" ]]; then
    echo "签名未完成。请在 Mac 打开“快捷指令”，确认 Apple 账号与网络可用后重试。"
    exit 1
  fi
done

mkdir -p "$output_dir"
for entry in "${entries[@]}"; do
  /bin/mv -f -- "$stage_dir/$entry.shortcut" "$output_dir/$entry.shortcut"
done
echo '打开新签名文件，遇到同名提示时选择替换，保存位置选择 BodyJournal/inbox。'
echo '可以同步到 iPhone，或通过 AirDrop 发送签名文件到手机安装。'
/usr/bin/open "$output_dir"
