---
description: Deploy the mac2015 lark-channel-bridge service from the remote source checkout
argument-hint: '[status|deploy]'
allowed-tools: Bash, Read
---

Deploy or inspect the mac2015 bridge service that runs from the secondary
development checkout at `/Users/ys-aquria/code/lark-coding-agent-bridge`.

Argument: `$ARGUMENTS`

Defaults:

- Empty argument runs `status`.
- `status` is read-only.
- `deploy` pulls `origin/dev`, builds the remote source checkout, installs that
  checkout globally with `npm i -g .`, and stops the old profile process. With a
  GUI launchd domain it starts the managed service with `LARK_CHANNEL_NO_PROXY=1`.
  Without that domain it uses a detached fallback running
  `bin/install-current-and-run.sh --no-proxy run --profile <profile>`.
- Default remote is `mac2015`.
- Default profile is `claude`.

The detached fallback writes to
`~/.lark-channel/logs/manual-bridge-<profile>.log`. It has no reboot or crash auto-restart;
an interactive GUI launchd session is required for managed lifecycle behavior.

Do this:

1. For read-only inspection:

   ```bash
   scripts/deploy-mac2015.sh status
   ```

2. For deployment after user approval:

   ```bash
   scripts/deploy-mac2015.sh deploy
   ```

3. If SSH requires an explicit target or identity, set env vars instead of
   editing the script:

   ```bash
   LARK_BRIDGE_REMOTE=ys-aquria@mac2015.local \
   SSH_OPTS="-i $HOME/.ssh/id_rsa -o IdentitiesOnly=yes" \
     scripts/deploy-mac2015.sh deploy
   ```

4. Report:

   - remote host/user and source directory;
   - git commit before/after pull;
   - source package version, built CLI version, and global CLI version;
   - stopped old registry id/pid if any;
   - selected mode and verified registry PID;
   - new `lark-channel-bridge ps` and `status --profile claude` result;
   - detached log path, lifecycle warning, and recent log tail when applicable;
   - whether `LARK_CHANNEL_NO_PROXY=1` was used.

5. Do not print App Secret, exported profile JSON with secrets, `.env` content,
   or raw config files.
