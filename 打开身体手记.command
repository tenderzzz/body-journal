#!/bin/zsh
set -e
PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
APP_PATH="$HOME/Applications/身体手记.app"
if [[ ! -d "$APP_PATH" ]]; then
  mkdir -p "$HOME/Applications"
  ditto -x -k "$PROJECT_DIR/release/身体手记-mac-arm64.zip" "$HOME/Applications"
fi
open "$APP_PATH"
