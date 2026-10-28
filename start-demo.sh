#!/bin/sh

# RTM 场景实验室一键启动脚本。缺依赖时先安装，然后起开发服务器。

set -eu

usage() {
  echo "Usage: ./start-demo.sh [--http|--https|--both] [--no-open] [--check|--help]"
  echo "Default URL: https://<LAN IPv4>:8080/"
  echo "Default listen address: 0.0.0.0"
  echo "HTTP only: ./start-demo.sh --http"
  echo "HTTPS only: ./start-demo.sh --https"
  echo "HTTP + HTTPS: ./start-demo.sh --both"
}

server_mode="https"
open_browser="false"
check_only="false"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --http) server_mode="http" ;;
    --https) server_mode="https" ;;
    --both) server_mode="both" ;;
    --no-open) open_browser="false" ;;
    --check) check_only="true" ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20 or newer is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required." >&2
  exit 1
fi

node_major=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$node_major" -lt 20 ]; then
  echo "Error: Node.js 20 or newer is required. Current version: $(node --version)" >&2
  exit 1
fi

if [ ! -x node_modules/.bin/vite ]; then
  if [ "$check_only" = "true" ]; then
    echo "Error: dependencies are not installed. Run ./start-demo.sh once." >&2
    exit 1
  fi
  echo "Installing dependencies..."
  npm install
fi

rtm_version=$(node -p "require('./node_modules/agora-rtm/package.json').version")
rtc_version=$(node -p "require('./node_modules/agora-rtc-sdk-ng/package.json').version")

if [ "$check_only" = "true" ]; then
  echo "Demo environment is ready (Node $(node --version))."
  echo "Scenario lab: root src/ (scenes/voice-room)"
  echo "SDKs: agora-rtm@$rtm_version, agora-rtc-sdk-ng@$rtc_version"
  echo "Default URL: https://<LAN IPv4>:8080/"
  echo "Default listen address: 0.0.0.0"
  exit 0
fi

demo_host=${RTM_DEMO_HOST:-0.0.0.0}
http_port=${RTM_DEMO_PORT:-8080}
demo_public_host=${RTM_DEMO_PUBLIC_HOST:-}
if [ -z "$demo_public_host" ]; then
  demo_public_host=$(node -e '
    const { networkInterfaces } = require("node:os");
    const address = Object.values(networkInterfaces()).flat().find(
      (entry) => entry && entry.family === "IPv4" && !entry.internal,
    );
    process.stdout.write(address?.address ?? "127.0.0.1");
  ')
fi

prepare_https_certificate() {
  if ! command -v mkcert >/dev/null 2>&1; then
    echo "Error: mkcert is required for trusted local HTTPS." >&2
    echo "Install it, run 'mkcert -install', then retry." >&2
    exit 1
  fi
  mkdir -p .cert
  mkcert -cert-file .cert/dev.pem -key-file .cert/dev-key.pem \
    localhost 127.0.0.1 ::1 "$demo_public_host"
}

echo "Starting Agora RTM scenario lab..."

if [ "$server_mode" = "http" ]; then
  echo "HTTP URL: http://$demo_public_host:$http_port/"
  if [ "$open_browser" = "false" ]; then
    exec npm run dev -- --host "$demo_host" --port "$http_port" --strictPort
  fi
  exec npm run dev -- --host "$demo_host" --port "$http_port" --strictPort --open "http://$demo_public_host:$http_port/"
fi

prepare_https_certificate

if [ "$server_mode" = "https" ]; then
  https_port=${RTM_DEMO_HTTPS_PORT:-$http_port}
  echo "HTTPS URL: https://$demo_public_host:$https_port/"
  echo "Remote devices must trust the mkcert CA from: $(mkcert -CAROOT)/rootCA.pem"
  if [ "$open_browser" = "false" ]; then
    exec npm run dev:https -- --host "$demo_host" --port "$https_port" --strictPort
  fi
  exec npm run dev:https -- --host "$demo_host" --port "$https_port" --strictPort --open "https://$demo_public_host:$https_port/"
fi

https_port=${RTM_DEMO_HTTPS_PORT:-8443}
echo "HTTP URL: http://$demo_public_host:$http_port/"
echo "HTTPS URL: https://$demo_public_host:$https_port/"
echo "Remote devices must trust the mkcert CA from: $(mkcert -CAROOT)/rootCA.pem"

http_pid=""
https_pid=""
cleanup() {
  if [ -n "$http_pid" ]; then
    kill "$http_pid" 2>/dev/null || true
  fi
  if [ -n "$https_pid" ]; then
    kill "$https_pid" 2>/dev/null || true
  fi
}
trap cleanup INT TERM EXIT

npm run dev -- --host "$demo_host" --port "$http_port" --strictPort &
http_pid=$!
if [ "$open_browser" = "false" ]; then
  npm run dev:https -- --host "$demo_host" --port "$https_port" --strictPort &
else
  npm run dev:https -- --host "$demo_host" --port "$https_port" --strictPort --open "https://$demo_public_host:$https_port/" &
fi
https_pid=$!

wait "$http_pid"
wait "$https_pid"
