#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-mac2015.sh [status|deploy]

Defaults:
  LARK_BRIDGE_REMOTE=mac2015
  LARK_BRIDGE_REMOTE_DIR=/Users/ys-aquria/code/lark-coding-agent-bridge
  LARK_BRIDGE_PROFILE=claude

Examples:
  scripts/deploy-mac2015.sh status
  scripts/deploy-mac2015.sh deploy
  LARK_BRIDGE_REMOTE=ys-aquria@mac2015.local scripts/deploy-mac2015.sh deploy

This deploys from the existing remote source checkout, not from npm registry:
  cd /Users/ys-aquria/code/lark-coding-agent-bridge
  git pull --ff-only origin dev
  pnpm install --frozen-lockfile
  pnpm build
  npm i -g .

The managed bridge runtime is started with LARK_CHANNEL_NO_PROXY=1 so it clears
HTTP_PROXY, HTTPS_PROXY, and ALL_PROXY environment variables before connecting.
No App Secret or profile secret values are printed.
EOF
}

mode="${1:-status}"
case "$mode" in
  -h|--help|help)
    usage
    exit 0
    ;;
  status|deploy)
    ;;
  *)
    echo "Unsupported mode: $mode" >&2
    usage >&2
    exit 2
    ;;
esac

remote="${LARK_BRIDGE_REMOTE:-mac2015}"
remote_dir="${LARK_BRIDGE_REMOTE_DIR:-/Users/ys-aquria/code/lark-coding-agent-bridge}"
profile="${LARK_BRIDGE_PROFILE:-claude}"

quote() {
  printf '%q' "$1"
}

# shellcheck disable=SC2086
ssh ${SSH_OPTS:-} "$remote" \
  "BRIDGE_REMOTE_DIR=$(quote "$remote_dir") BRIDGE_PROFILE=$(quote "$profile") BRIDGE_MODE=$(quote "$mode") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

print_section() {
  printf '\n--- %s ---\n' "$1"
}

env_flag() {
  [ "${1:-}" != "" ] && [ "${1:-}" != "0" ] && [ "${1:-}" != "false" ]
}

without_proxy_env() {
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
  export LARK_CHANNEL_NO_PROXY=1
}

find_node_tools() {
  if command -v node >/dev/null 2>&1 &&
    command -v npm >/dev/null 2>&1 &&
    command -v pnpm >/dev/null 2>&1; then
    return 0
  fi

  for bin in \
    "$HOME"/.nvm/versions/node/*/bin \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin \
    /opt/homebrew/bin \
    /usr/local/bin; do
    if [ -x "$bin/node" ]; then
      PATH="$bin:$PATH"
      export PATH
      if command -v node >/dev/null 2>&1 &&
        command -v npm >/dev/null 2>&1 &&
        command -v pnpm >/dev/null 2>&1; then
        return 0
      fi
    fi
  done

  echo "Cannot find node, npm, and pnpm on remote host." >&2
  exit 127
}

safe_profile_summary() {
  node - <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const file = path.join(os.homedir(), '.lark-channel', 'config.json');
try {
  const root = JSON.parse(fs.readFileSync(file, 'utf8'));
  const profiles = Object.fromEntries(Object.entries(root.profiles || {}).map(([name, cfg]) => {
    const access = cfg.access || {};
    return [name, {
      agentKind: cfg.agentKind || 'claude',
      appId: cfg.accounts && cfg.accounts.app ? cfg.accounts.app.id : undefined,
      tenant: cfg.accounts && cfg.accounts.app ? cfg.accounts.app.tenant : undefined,
      allowedChats: Array.isArray(access.allowedChats) ? access.allowedChats.length : 0,
      admins: Array.isArray(access.admins) ? access.admins.length : 0,
    }];
  }));
  console.log(JSON.stringify({ activeProfile: root.activeProfile, profiles }, null, 2));
} catch (err) {
  console.log(`config summary unavailable: ${err.message}`);
}
NODE
}

running_ids_for_profile() {
  node - "$BRIDGE_PROFILE" <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = process.argv[2];
const file = path.join(os.homedir(), '.lark-channel', 'registry', 'processes.json');
let entries = [];
try {
  entries = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  entries = [];
}
for (const entry of entries) {
  if (!entry || entry.profileName !== profile || !entry.id || !entry.pid) continue;
  try {
    process.kill(Number(entry.pid), 0);
    console.log(entry.id);
  } catch {
    // stale registry row
  }
}
NODE
}

wait_until_profile_stopped() {
  deadline=$((SECONDS + 20))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -z "$(running_ids_for_profile)" ]; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for old profile process to stop." >&2
  return 1
}

print_remote_status() {
  print_section remote
  hostname
  whoami
  pwd
  node -v
  npm -v
  pnpm -v

  print_section source
  cd "$BRIDGE_REMOTE_DIR"
  git status --porcelain=v1 --branch
  git log -1 --oneline --decorate
  node -e 'const p=require("./package.json"); console.log(`${p.name}@${p.version}`)'
  if [ -f dist/cli.js ]; then
    node dist/cli.js -v || true
  else
    echo "dist/cli.js missing"
  fi

  print_section installed-cli
  command -v lark-channel-bridge || true
  lark-channel-bridge -v || true

  print_section profile-summary
  safe_profile_summary

  print_section running
  lark-channel-bridge ps || true
  lark-channel-bridge status --profile "$BRIDGE_PROFILE" || true
}

deploy_from_source() {
  cd "$BRIDGE_REMOTE_DIR"

  print_section source-update
  if [ -n "$(git status --porcelain)" ]; then
    echo "Remote working tree is not clean; aborting deploy." >&2
    git status --short >&2
    exit 1
  fi
  git fetch origin dev
  git checkout dev
  git pull --ff-only origin dev
  git log -1 --oneline --decorate

  print_section build-install-current-source
  pnpm install --frozen-lockfile
  pnpm build
  npm i -g .
  command -v lark-channel-bridge
  lark-channel-bridge -v

  print_section stop-old-profile
  ids="$(running_ids_for_profile)"
  if [ -n "$ids" ]; then
    for id in $ids; do
      lark-channel-bridge kill "$id"
    done
    wait_until_profile_stopped
  else
    echo "No running registry process for profile $BRIDGE_PROFILE."
  fi

  print_section start-no-proxy
  without_proxy_env
  lark-channel-bridge start --profile "$BRIDGE_PROFILE" --skip-check-lark-cli --no-proxy

  print_section verify
  lark-channel-bridge -v
  lark-channel-bridge ps
  lark-channel-bridge status --profile "$BRIDGE_PROFILE"
}

find_node_tools

if [ ! -d "$BRIDGE_REMOTE_DIR" ]; then
  echo "Remote source directory not found: $BRIDGE_REMOTE_DIR" >&2
  exit 1
fi

print_remote_status

if [ "$BRIDGE_MODE" = "deploy" ]; then
  deploy_from_source
fi
REMOTE_SCRIPT
