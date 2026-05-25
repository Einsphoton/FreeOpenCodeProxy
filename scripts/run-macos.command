#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3000}"
APP_ROOT="$SOURCE_ROOT"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

if ! command_exists node; then
  echo "Node.js 未安装，正在尝试安装 Node.js LTS..."
  if ! command_exists brew; then
    echo "未找到 Homebrew，正在安装 Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [[ -x /opt/homebrew/bin/brew ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -x /usr/local/bin/brew ]]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  fi
  brew install node
fi

if [[ "$SOURCE_ROOT" == /Volumes/* ]]; then
  APP_ROOT="${FREE_OPEN_CODE_PROXY_HOME:-$HOME/FreeOpenCodeProxy}"
  echo "检测到项目位于挂载磁盘：$SOURCE_ROOT"
  echo "为避免 macOS 挂载盘不支持 npm symlink，正在同步到本机目录：$APP_ROOT"
  mkdir -p "$APP_ROOT"
  rsync -a --delete --exclude node_modules --exclude data --exclude .git "$SOURCE_ROOT/" "$APP_ROOT/"
fi

cd "$APP_ROOT"
echo "正在安装依赖..."
npm install --no-bin-links

(
  for _ in $(seq 1 90); do
    if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
      open "http://localhost:${PORT}"
      exit 0
    fi
    sleep 1
  done
) &

echo "启动服务：http://localhost:${PORT}"
npm start
