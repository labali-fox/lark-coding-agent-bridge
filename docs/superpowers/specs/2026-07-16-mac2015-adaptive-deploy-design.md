# Mac2015 Adaptive Deployment Design

## Goal

Make the existing Claude Code `/deploy-mac2015` command deploy the `claude`
bridge reliably whether Mac2015 has an active GUI login session or is sitting at
the login window.

The command must preserve launchd management when a GUI domain is available and
fall back to the proven detached runner when it is not.

## Current Problem

`scripts/deploy-mac2015.sh deploy` always starts the bridge through
`lark-channel-bridge start`. On macOS this bootstraps a LaunchAgent into
`gui/<uid>`. When Mac2015 has no logged-in GUI user, that domain does not exist
and launchd returns error 125. Loading the LaunchAgent into `user/<uid>` is not a
valid substitute; launchd rejects it because the service cannot load in that
session.

Running `bin/install-current-and-run.sh` through a detached login shell works in
the headless state because the login shell initializes the NVM toolchain and
`nohup` lets the bridge survive the SSH connection closing.

## Command Contract

The public interface remains:

```bash
scripts/deploy-mac2015.sh status
scripts/deploy-mac2015.sh deploy
```

The Claude Code command remains `/deploy-mac2015 [status|deploy]` and delegates
to that script.

### Status Mode

Status mode is read-only. It reports:

- remote host, user, and source directory;
- source and installed CLI versions;
- profile registry state;
- deployment mode: `launchd`, `detached`, or `stopped`;
- the active PID when available;
- the detached log path when detached mode is active;
- the standard launchd status output when launchd mode is active.

Mode detection uses evidence in this order:

1. The profile's launchd service is loaded and running: `launchd`.
2. A live registry entry for the profile exists outside launchd: `detached`.
3. Neither condition is true: `stopped`.

Stale registry rows do not count as running processes.

### Deploy Mode

Deployment performs these steps:

1. Validate the remote checkout exists and has a clean working tree.
2. Locate `node`, `npm`, and `pnpm` without relying on a non-login SSH `PATH`.
3. Stop any live registry process for the selected profile and wait for it to
   exit.
4. Detect whether `launchctl print gui/<uid>` succeeds.
5. Choose exactly one runner:
   - GUI domain available: update, build, install, and start the normal managed
     LaunchAgent with `LARK_CHANNEL_NO_PROXY=1`.
   - GUI domain unavailable: start a detached login shell that executes
     `bin/install-current-and-run.sh --no-proxy run --profile <profile>`.
6. Poll the registry for a new live process for the profile.
7. Report the selected mode, PID, versions, and relevant status/log path.

The headless command redirects stdin from `/dev/null`, writes combined output to
`~/.lark-channel/logs/manual-bridge-<profile>.log`, and uses `nohup zsh -lic` so
NVM-installed tools are available. The detached launcher PID is not treated as
proof of success; a fresh live registry entry is required.

## Failure Handling

- A dirty remote worktree aborts before pull, build, install, or process stop.
- Missing Node tooling aborts with a diagnostic before deployment.
- Failure to stop the old process aborts before starting a replacement.
- Launchd errors are returned directly in GUI mode; deployment does not switch
  to detached mode after a genuine launchd start failure. The fallback is based
  only on GUI-domain availability.
- In detached mode, early launcher exit surfaces the tail of the detached log.
- A connection timeout reports the selected mode, PID state, and log path and
  exits nonzero.
- Commands never print application secrets, `.env` contents, or raw profile
  configuration.

## Lifecycle Semantics

Launchd mode retains KeepAlive and restart-on-login behavior supplied by the
existing LaunchAgent.

Detached mode survives the SSH session ending but does not promise restart after
a process crash or system reboot. A later deployment may choose launchd mode if
a GUI user is logged in. The command reports this limitation explicitly rather
than presenting detached mode as equivalent to a persistent LaunchAgent.

## Files to Change

- `scripts/deploy-mac2015.sh`: add mode detection, detached launch, connection
  polling, and mode-aware status/reporting.
- `.claude/commands/deploy-mac2015.md`: document adaptive behavior and required
  report fields.
- `tests/process/deploy-mac2015-script.test.ts`: extend the script contract tests
  for GUI detection, detached command safety, logging, and verification.

No runtime TypeScript API or profile schema changes are required.

## Verification

Automated verification runs the focused process test, then the repository's
typecheck and build if implementation changes touch TypeScript unexpectedly.

Operational verification on Mac2015 checks both paths where practical:

- Headless: deployment selects `detached`, the resulting process has no SSH
  parent, `lark-channel-bridge ps` shows one live `claude` bot, and the log shows
  a successful connection.
- GUI session available: deployment selects `launchd`, `status --profile
  claude` reports the managed service running, and the registry shows one live
  bot.

If a GUI session is unavailable during implementation, automated coverage still
validates branch construction while the live acceptance check covers the
headless branch.
