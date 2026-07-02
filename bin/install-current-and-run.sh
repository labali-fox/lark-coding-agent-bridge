#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bin/install-current-and-run.sh [--local] [--no-proxy] [run|restart] [--local] [--no-proxy] [lark-channel-bridge args...]

Examples:
  bin/install-current-and-run.sh
  bin/install-current-and-run.sh run
  bin/install-current-and-run.sh restart
  bin/install-current-and-run.sh run --profile codex
  bin/install-current-and-run.sh run --no-proxy --profile codex
  bin/install-current-and-run.sh --local run --no-proxy --profile codex
  LARK_CHANNEL_NO_PROXY=1 bin/install-current-and-run.sh run
  LARK_CHANNEL_USE_LOCAL=1 LARK_CHANNEL_NO_PROXY=1 bin/install-current-and-run.sh run

This installs the current repository code globally with `npm i -g .`, then
executes `lark-channel-bridge run` by default. Without --profile, the bridge
uses the same default profile/config path as a plain `lark-channel-bridge run`.

Pass --local, or set LARK_CHANNEL_USE_LOCAL=1, to install and run the current
working tree as-is. Local mode skips git status checks, fetch, checkout, and
pull, so uncommitted local changes are included.

Pass --no-proxy, or set LARK_CHANNEL_NO_PROXY=1, to unset HTTP(S) proxy
environment variables only for the final bridge process. Git/npm/pnpm steps
keep the current environment.
EOF
}

no_proxy_requested="${LARK_CHANNEL_NO_PROXY:-}"
local_requested="${LARK_CHANNEL_USE_LOCAL:-}"

while [[ "${1:-}" == "--no-proxy" || "${1:-}" == "--local" ]]; do
  case "$1" in
    --no-proxy) no_proxy_requested=1 ;;
    --local) local_requested=1 ;;
  esac
  shift
done

action="${1:-run}"
case "$action" in
  -h|--help|help)
    usage
    exit 0
    ;;
  run|restart)
    if [[ $# -gt 0 ]]; then
      shift
    fi
    ;;
  *)
    echo "Unsupported action: $action" >&2
    usage >&2
    exit 2
    ;;
esac

bridge_args=()
for arg in "$@"; do
  case "$arg" in
    --no-proxy)
      no_proxy_requested=1
      ;;
    --local)
      local_requested=1
      ;;
    *)
      bridge_args+=("$arg")
      ;;
  esac
done
if [[ "${#bridge_args[@]}" -gt 0 ]]; then
  set -- "${bridge_args[@]}"
else
  set --
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"

cd "$repo_dir"

if [[ -n "$local_requested" && "$local_requested" != "0" && "$local_requested" != "false" ]]; then
  echo "Using local working tree; skipping git fetch/checkout/pull."
else
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree is not clean. Commit, stash, or discard local changes first." >&2
    git status --short >&2
    exit 1
  fi

  git fetch origin
  git checkout dev
  git pull --ff-only origin dev
fi

pnpm install --frozen-lockfile
pnpm build

npm i -g .

echo "Using lark-channel-bridge from: $(command -v lark-channel-bridge)"
lark-channel-bridge --version

if [[ -n "$no_proxy_requested" && "$no_proxy_requested" != "0" && "$no_proxy_requested" != "false" ]]; then
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
  echo "Running bridge without HTTP(S) proxy environment variables."
fi

exec lark-channel-bridge "$action" "$@"
