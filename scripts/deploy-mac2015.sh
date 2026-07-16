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

case "$profile" in
  ''|*[!A-Za-z0-9._-]*)
    echo "Invalid profile name: use only letters, numbers, dot, underscore, and hyphen." >&2
    exit 2
    ;;
esac

quote() {
  printf '%q' "$1"
}

# shellcheck disable=SC2086,SC2029
ssh ${SSH_OPTS:-} "$remote" \
  "BRIDGE_REMOTE_DIR=$(quote "$remote_dir") BRIDGE_PROFILE=$(quote "$profile") BRIDGE_MODE=$(quote "$mode") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

DETACHED_LOG_PATH="$HOME/.lark-channel/logs/manual-bridge-${BRIDGE_PROFILE}.log"

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

running_entries_for_profile() {
  node - "$BRIDGE_PROFILE" <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = process.argv[2];
const file = path.join(os.homedir(), '.lark-channel', 'registry', 'processes.json');
let entries = [];
try {
  const root = JSON.parse(fs.readFileSync(file, 'utf8'));
  entries = Array.isArray(root) ? root : Array.isArray(root.entries) ? root.entries : [];
} catch {
  entries = [];
}
for (const entry of entries) {
  if (!entry || entry.profileName !== profile || !entry.id || !entry.pid) continue;
  const pid = Number(entry.pid);
  try {
    process.kill(pid, 0);
    console.log(`${entry.id}\t${pid}`);
  } catch {
    // stale registry row
  }
}
NODE
}

running_ids_for_profile() {
  running_entries_for_profile | awk '{ print $1 }'
}

running_pid_for_profile() {
  running_entries_for_profile | awk 'NR == 1 { print $2; exit }'
}

launchd_service_target() {
  printf 'gui/%s/%s\n' "$(id -u)" "ai.lark-channel-bridge.bot.${BRIDGE_PROFILE}"
}

gui_domain_available() {
  launchctl print "gui/$(id -u)" >/dev/null 2>&1
}

launchd_service_pid() {
  gui_domain_available || return 1
  launchctl print "$(launchd_service_target)" 2>/dev/null |
    awk '$1 == "pid" && $2 == "=" { print $3; exit }'
}

deployment_mode() {
  entries="${1:-}"
  launchd_pid="${2:-}"
  if [ -z "$entries" ]; then
    printf 'stopped\n'
    return
  fi

  if [ -n "$launchd_pid" ] &&
    printf '%s\n' "$entries" |
      awk -F '\t' -v launchd_pid="$launchd_pid" '$2 == launchd_pid { found = 1 } END { exit !found }'; then
    printf 'launchd\n'
    return
  fi

  printf 'detached\n'
}

print_deployment_mode() {
  entries="$(running_entries_for_profile)"
  launchd_pid=""
  if [ -n "$entries" ]; then
    launchd_pid="$(launchd_service_pid || true)"
  fi
  mode="$(deployment_mode "$entries" "$launchd_pid")"
  if [ "$mode" = "launchd" ]; then
    pid="$launchd_pid"
  else
    pid="$(printf '%s\n' "$entries" | awk 'NR == 1 { print $2; exit }')"
  fi

  printf 'deployment_mode=%s\n' "$mode"
  if [ -n "$pid" ]; then
    printf 'deployment_pid=%s\n' "$pid"
  fi
  if [ "$mode" = "detached" ]; then
    printf 'detached_log_path=%s\n' "$DETACHED_LOG_PATH"
    echo "Warning: detached lifecycle is not managed by launchd."
  fi
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

wait_for_profile_pid() {
  launcher_pid="${1:-}"
  deadline=$((SECONDS + 120))
  while [ "$SECONDS" -lt "$deadline" ]; do
    connected_pid="$(running_pid_for_profile)"
    if [ -n "$connected_pid" ]; then
      printf '%s\n' "$connected_pid"
      return 0
    fi
    if [ -n "$launcher_pid" ] && ! kill -0 "$launcher_pid" 2>/dev/null; then
      echo "Detached bridge launcher exited before registering a live PID." >&2
      tail -n 80 "$DETACHED_LOG_PATH" >&2 || true
      return 1
    fi
    sleep 1
  done
  echo "Timed out waiting for a live registry PID for profile $BRIDGE_PROFILE." >&2
  tail -n 80 "$DETACHED_LOG_PATH" >&2 || true
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

  print_section deployment-mode
  print_deployment_mode
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

  if gui_domain_available; then
    selected_mode=launchd
    print_section start-no-proxy
    without_proxy_env
    lark-channel-bridge start --profile "$BRIDGE_PROFILE" --skip-check-lark-cli --no-proxy
    connected_pid="$(wait_for_profile_pid)"
  else
    selected_mode=detached
    print_section start-detached-no-proxy
    mkdir -p "$(dirname "$DETACHED_LOG_PATH")"
    printf -v detached_command \
      'cd %q && exec bin/install-current-and-run.sh --no-proxy run --profile %q' \
      "$BRIDGE_REMOTE_DIR" "$BRIDGE_PROFILE"
    nohup zsh -lic "$detached_command" </dev/null >>"$DETACHED_LOG_PATH" 2>&1 &
    launcher_pid=$!
    connected_pid="$(wait_for_profile_pid "$launcher_pid")"
  fi

  print_section verify
  printf 'selected_mode=%s\n' "$selected_mode"
  printf 'connected_pid=%s\n' "$connected_pid"
  lark-channel-bridge -v
  lark-channel-bridge ps
  lark-channel-bridge status --profile "$BRIDGE_PROFILE"
  print_deployment_mode
  if [ "$selected_mode" = "detached" ]; then
    printf 'detached_log_path=%s\n' "$DETACHED_LOG_PATH"
    echo "Warning: detached lifecycle has no reboot or crash auto-restart."
    print_section detached-log-tail
    tail -n 80 "$DETACHED_LOG_PATH" || true
  fi
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
