#!/bin/zsh
set -eu
shortcut_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
exec /bin/zsh "$shortcut_dir/更新记一餐和记身体.command" '记一餐'
