# Mac2015 Adaptive Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/deploy-mac2015 deploy` use launchd when Mac2015 has a GUI session and automatically use the proven detached login-shell runner when it is headless.

**Architecture:** Keep `scripts/deploy-mac2015.sh` as the single orchestration boundary. Add shell helpers that classify live state from launchd plus the bridge registry, then branch only on GUI-domain availability: the GUI path retains the current managed-service flow, while the headless path detaches `bin/install-current-and-run.sh` with `nohup zsh -lic` and verifies a fresh live registry process. Update the Claude command contract to expose the selected mode and its lifecycle limitation.

**Tech Stack:** Bash, macOS `launchctl`, SSH, Node.js registry inspection, Vitest process-contract tests, Claude Code Markdown commands.

---

## File Map

- Modify `scripts/deploy-mac2015.sh`: own remote environment discovery, deployment-mode classification, adaptive start, connection polling, and safe diagnostics.
- Modify `tests/process/deploy-mac2015-script.test.ts`: lock down the shell contract without opening SSH or mutating a remote host.
- Modify `.claude/commands/deploy-mac2015.md`: tell Claude Code to use and report the adaptive behavior.

No runtime TypeScript files or configuration schemas change.

### Task 1: Add Mode-Aware Status Reporting

**Files:**
- Modify: `tests/process/deploy-mac2015-script.test.ts:34`
- Modify: `scripts/deploy-mac2015.sh:81-187`

- [ ] **Step 1: Write the failing status-contract test**

Append this test inside the existing `describe` block:

```typescript
it('classifies launchd, detached, and stopped deployment modes', async () => {
  const body = await readFile(script, 'utf8');

  expect(body).toContain('gui_domain_available()');
  expect(body).toContain('launchd_service_loaded()');
  expect(body).toContain('deployment_mode()');
  expect(body).toContain('ai.lark-channel-bridge.bot.${BRIDGE_PROFILE}');
  expect(body).toContain("printf 'deployment_mode=%s\\n'");
  expect(body).toContain('detached_log_path=');
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
pnpm vitest run tests/process/deploy-mac2015-script.test.ts
```

Expected: one failing test because `gui_domain_available()`, `deployment_mode()`, and the new report fields are absent.

- [ ] **Step 3: Replace registry-ID output with live entry output**

In `scripts/deploy-mac2015.sh`, replace `running_ids_for_profile` with this helper and retain a small ID adapter for existing stop logic:

```bash
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
  try {
    process.kill(Number(entry.pid), 0);
    console.log(`${entry.id}\t${entry.pid}`);
  } catch {
    // Ignore stale registry rows.
  }
}
NODE
}

running_ids_for_profile() {
  running_entries_for_profile | awk -F '\t' '{ print $1 }'
}

running_pid_for_profile() {
  running_entries_for_profile | awk -F '\t' 'NR == 1 { print $2 }'
}
```

- [ ] **Step 4: Add launchd and mode-classification helpers**

Add these functions after the registry helpers:

```bash
launchd_service_target() {
  printf 'gui/%s/ai.lark-channel-bridge.bot.%s\n' "$(id -u)" "$BRIDGE_PROFILE"
}

gui_domain_available() {
  launchctl print "gui/$(id -u)" >/dev/null 2>&1
}

launchd_service_loaded() {
  launchctl print "$(launchd_service_target)" >/dev/null 2>&1
}

deployment_mode() {
  pid="$(running_pid_for_profile)"
  if [ -n "$pid" ] && launchd_service_loaded; then
    printf 'launchd\n'
  elif [ -n "$pid" ]; then
    printf 'detached\n'
  else
    printf 'stopped\n'
  fi
}

print_deployment_mode() {
  mode="$(deployment_mode)"
  pid="$(running_pid_for_profile)"
  printf 'deployment_mode=%s\n' "$mode"
  [ -z "$pid" ] || printf 'deployment_pid=%s\n' "$pid"
  if [ "$mode" = "detached" ]; then
    printf 'detached_log_path=%s\n' "$DETACHED_LOG_PATH"
    echo 'detached_lifecycle=survives SSH disconnect; does not auto-restart after reboot or crash'
  fi
}
```

Define the log path immediately after the existing remote/profile variables inside the remote script:

```bash
DETACHED_LOG_PATH="$HOME/.lark-channel/logs/manual-bridge-${BRIDGE_PROFILE}.log"
```

- [ ] **Step 5: Include mode evidence in status output**

At the end of `print_remote_status`, add:

```bash
print_section deployment-mode
print_deployment_mode
```

- [ ] **Step 6: Run the focused test and shell syntax check**

Run:

```bash
bash -n scripts/deploy-mac2015.sh
pnpm vitest run tests/process/deploy-mac2015-script.test.ts
```

Expected: shell syntax exits 0 and all process-contract tests pass.

- [ ] **Step 7: Commit the mode-aware status increment**

```bash
git add scripts/deploy-mac2015.sh tests/process/deploy-mac2015-script.test.ts
git commit -m "feat: report Mac2015 deployment mode"
```

### Task 2: Add the Headless Detached Deployment Branch

**Files:**
- Modify: `tests/process/deploy-mac2015-script.test.ts`
- Modify: `scripts/deploy-mac2015.sh:189-247`

- [ ] **Step 1: Write failing tests for the detached runner and verification gate**

Append these tests inside the existing `describe` block:

```typescript
it('uses the source installer in a detached login shell when headless', async () => {
  const body = await readFile(script, 'utf8');

  expect(body).toContain('start_detached()');
  expect(body).toContain('nohup zsh -lic');
  expect(body).toContain('bin/install-current-and-run.sh --no-proxy run --profile');
  expect(body).toContain('</dev/null >"$DETACHED_LOG_PATH" 2>&1 &');
  expect(body).toContain('DETACHED_LAUNCHER_PID=$!');
});

it('waits for a live profile process and diagnoses early detached exit', async () => {
  const body = await readFile(script, 'utf8');

  expect(body).toContain('wait_for_profile_started()');
  expect(body).toContain('running_pid_for_profile');
  expect(body).toContain('kill -0 "$DETACHED_LAUNCHER_PID"');
  expect(body).toContain('tail -n 80 "$DETACHED_LOG_PATH"');
  expect(body).toContain('Timed out waiting for profile');
});

it('selects launchd only from GUI-domain availability', async () => {
  const body = await readFile(script, 'utf8');

  expect(body).toContain('if gui_domain_available; then');
  expect(body).toContain('start_launchd');
  expect(body).toContain('start_detached');
  expect(body).not.toContain('if lark-channel-bridge start; then');
});
```

- [ ] **Step 2: Run the focused test and confirm the new tests fail**

Run:

```bash
pnpm vitest run tests/process/deploy-mac2015-script.test.ts
```

Expected: the three new tests fail because adaptive start helpers do not exist.

- [ ] **Step 3: Add the launchd start helper**

Extract the current source update, build, install, and managed start operations into:

```bash
start_launchd() {
  print_section source-update
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

  print_section start-launchd-no-proxy
  without_proxy_env
  lark-channel-bridge start --profile "$BRIDGE_PROFILE" --skip-check-lark-cli --no-proxy
}
```

- [ ] **Step 4: Add the detached start helper**

Add a shell-quoting helper and detached runner:

```bash
shell_quote() {
  printf '%q' "$1"
}

start_detached() {
  mkdir -p "$(dirname "$DETACHED_LOG_PATH")"
  : >"$DETACHED_LOG_PATH"
  quoted_dir="$(shell_quote "$BRIDGE_REMOTE_DIR")"
  quoted_profile="$(shell_quote "$BRIDGE_PROFILE")"
  detached_command="cd $quoted_dir && exec bash bin/install-current-and-run.sh --no-proxy run --profile $quoted_profile"

  print_section start-detached-no-proxy
  printf 'detached_log_path=%s\n' "$DETACHED_LOG_PATH"
  nohup zsh -lic "$detached_command" </dev/null >"$DETACHED_LOG_PATH" 2>&1 &
  DETACHED_LAUNCHER_PID=$!
  export DETACHED_LAUNCHER_PID
  printf 'detached_launcher_pid=%s\n' "$DETACHED_LAUNCHER_PID"
}
```

The profile name already follows the runtime's `[A-Za-z0-9._-]+` service-ID contract. Add this guard before using it in launchd labels or paths:

```bash
case "$BRIDGE_PROFILE" in
  ''|*[!A-Za-z0-9._-]*|.|..)
    echo "Invalid bridge profile: $BRIDGE_PROFILE" >&2
    exit 2
    ;;
esac
```

- [ ] **Step 5: Add condition-based connection verification**

Add this helper with a 120-second allowance for pull, install, build, and connection:

```bash
wait_for_profile_started() {
  deadline=$((SECONDS + 120))
  while [ "$SECONDS" -lt "$deadline" ]; do
    pid="$(running_pid_for_profile)"
    if [ -n "$pid" ]; then
      printf 'connected_profile_pid=%s\n' "$pid"
      return 0
    fi
    if [ -n "${DETACHED_LAUNCHER_PID:-}" ] && ! kill -0 "$DETACHED_LAUNCHER_PID" 2>/dev/null; then
      echo "Detached deployment exited before profile $BRIDGE_PROFILE connected." >&2
      tail -n 80 "$DETACHED_LOG_PATH" >&2 || true
      return 1
    fi
    sleep 1
  done
  echo "Timed out waiting for profile $BRIDGE_PROFILE to connect." >&2
  if [ -n "${DETACHED_LAUNCHER_PID:-}" ]; then
    tail -n 80 "$DETACHED_LOG_PATH" >&2 || true
  fi
  return 1
}
```

- [ ] **Step 6: Replace the unconditional managed start with adaptive selection**

Keep the clean-worktree validation and old-profile stop at the start of `deploy_from_source`, then replace its update/build/start tail with:

```bash
if gui_domain_available; then
  selected_mode=launchd
  start_launchd
else
  selected_mode=detached
  start_detached
fi

print_section verify
wait_for_profile_started
printf 'selected_mode=%s\n' "$selected_mode"
lark-channel-bridge -v
lark-channel-bridge ps
print_deployment_mode
if [ "$selected_mode" = "launchd" ]; then
  lark-channel-bridge status --profile "$BRIDGE_PROFILE"
else
  tail -n 20 "$DETACHED_LOG_PATH"
fi
```

Do not fall back after `start_launchd` fails: `set -e` must preserve a genuine managed-service error instead of silently changing lifecycle semantics.

- [ ] **Step 7: Run focused tests and syntax validation**

Run:

```bash
bash -n scripts/deploy-mac2015.sh
pnpm vitest run tests/process/deploy-mac2015-script.test.ts
```

Expected: syntax exits 0 and all tests in the file pass.

- [ ] **Step 8: Commit the adaptive deployment increment**

```bash
git add scripts/deploy-mac2015.sh tests/process/deploy-mac2015-script.test.ts
git commit -m "feat: deploy Mac2015 bridge adaptively"
```

### Task 3: Update the Claude Command Contract

**Files:**
- Modify: `.claude/commands/deploy-mac2015.md:10-55`
- Modify: `tests/process/deploy-mac2015-script.test.ts`

- [ ] **Step 1: Write the failing documentation-contract test**

Add a command-path constant near the script constant and append the test:

```typescript
const command = '.claude/commands/deploy-mac2015.md';

it('documents adaptive launchd and detached deployment behavior', async () => {
  const body = await readFile(command, 'utf8');

  expect(body).toContain('GUI launchd domain');
  expect(body).toContain('detached');
  expect(body).toContain('manual-bridge-<profile>.log');
  expect(body).toContain('does not automatically restart after a reboot or crash');
  expect(body).toContain('selected deployment mode');
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
pnpm vitest run tests/process/deploy-mac2015-script.test.ts
```

Expected: the documentation-contract test fails on the first missing adaptive-deployment phrase.

- [ ] **Step 3: Update `.claude/commands/deploy-mac2015.md`**

Replace the current `deploy` default bullet with:

```markdown
- `deploy` stops the old profile process, then selects one deployment mode:
  - when a GUI launchd domain exists, update/build/install and start the managed
    LaunchAgent with `LARK_CHANNEL_NO_PROXY=1`;
  - when Mac2015 is headless, run
    `bin/install-current-and-run.sh --no-proxy run --profile claude` in a
    detached login shell and log to
    `~/.lark-channel/logs/manual-bridge-<profile>.log`.
- Detached mode survives SSH disconnection but does not automatically restart
  after a reboot or crash.
```

Extend the report list with:

```markdown
- selected deployment mode (`launchd`, `detached`, or `stopped`), live PID, and
  the detached log path when applicable;
- successful post-deploy registry connection, not merely a surviving launcher
  process;
```

- [ ] **Step 4: Run focused tests and Markdown hygiene checks**

Run:

```bash
pnpm vitest run tests/process/deploy-mac2015-script.test.ts
git diff --check
```

Expected: all focused tests pass and `git diff --check` prints nothing.

- [ ] **Step 5: Commit the Claude command update**

```bash
git add .claude/commands/deploy-mac2015.md tests/process/deploy-mac2015-script.test.ts
git commit -m "docs: teach Claude adaptive Mac2015 deploys"
```

### Task 4: Verify Locally and on Headless Mac2015

**Files:**
- Verify only; no expected file changes.

- [ ] **Step 1: Run the complete local quality gate**

Run:

```bash
git diff --check
pnpm test
pnpm typecheck
pnpm build
```

Expected: all tests pass, TypeScript exits 0, and both ESM/DTS builds succeed.

- [ ] **Step 2: Confirm Mac2015 is still headless before acceptance testing**

Run:

```bash
ssh mac2015 'printf "console_user="; stat -f %Su /dev/console; launchctl print "gui/$(id -u)" >/dev/null 2>&1; printf "gui_domain_rc=%s\n" "$?"'
```

Expected for the headless acceptance path: `console_user=root` and nonzero `gui_domain_rc`. If a GUI user is logged in, record that the live test will cover launchd instead and do not force logout.

- [ ] **Step 3: Run the adaptive deployment**

Run:

```bash
scripts/deploy-mac2015.sh deploy
```

Expected while headless: output includes `selected_mode=detached`, a live `connected_profile_pid`, version `0.5.7` or the current package version, and the successful bridge connection log tail. Expected with a GUI session: output includes `selected_mode=launchd` and managed service status.

- [ ] **Step 4: Verify from a fresh SSH connection**

Run:

```bash
scripts/deploy-mac2015.sh status
ssh mac2015 'zsh -lic '\''lark-channel-bridge ps'\'''
```

Expected: status reports the same active mode selected during deployment and exactly one live `claude` profile bot; the fresh SSH command shows its live PID.

- [ ] **Step 5: Inspect the final repository state**

Run:

```bash
git status --short
git log -4 --oneline
```

Expected: no uncommitted changes and the three implementation commits plus the design/plan documentation commits are visible.
