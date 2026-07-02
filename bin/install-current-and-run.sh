#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bin/install-current-and-run.sh [run|restart] [lark-channel-bridge args...]

Examples:
  bin/install-current-and-run.sh
  bin/install-current-and-run.sh run
  bin/install-current-and-run.sh restart
  bin/install-current-and-run.sh run --profile codex

This installs the current repository code globally with `npm i -g .`, then
executes `lark-channel-bridge run` by default. Without --profile, the bridge
uses the same default profile/config path as a plain `lark-channel-bridge run`.
EOF
}

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

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/.." && pwd)"

cd "$repo_dir"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit, stash, or discard local changes first." >&2
  git status --short >&2
  exit 1
fi

git fetch origin
git checkout dev
git pull --ff-only origin dev

pnpm install --frozen-lockfile
pnpm build

npm i -g .

echo "Using lark-channel-bridge from: $(command -v lark-channel-bridge)"
lark-channel-bridge --version

exec lark-channel-bridge "$action" "$@"
