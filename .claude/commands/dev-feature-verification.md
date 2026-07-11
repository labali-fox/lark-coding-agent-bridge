# Dev Feature Verification

Use this before shipping changes to the group invite, ambient/no-at response, history, permission, secret, or real-test paths.

## Local Gate

Run the reusable dev feature suite:

```bash
pnpm test:dev-features -- --reporter=dot
```

Then run the release sanity checks:

```bash
git diff --check
pnpm typecheck
pnpm build
```

The local gate covers command contracts, ambient policy evals, decision-runner timeout behavior, app-scope detection, secret recovery errors, install-current smoke, ambient/history smoke, bot context handling, CardKit markdown-stream fallback/disabling, and the real-test harness in skip mode.

## Real Feishu/Lark Gate

These checks need a real tenant, a running bridge from the current branch, valid bot credentials, valid user OAuth for `lark-cli`, and a group containing the bot.

Start the bridge:

```bash
pnpm bridge:run-current -- --local --profile codex
```

Set the target group:

```bash
CHAT_ID=<oc_chat_id>
```

Verify ambient/history smoke:

```bash
BRIDGE_REAL_E2E=1 \
BRIDGE_REAL_PROFILE=codex \
BRIDGE_REAL_CHAT_ID="$CHAT_ID" \
BRIDGE_REAL_TIMEOUT_MS=180000 \
BRIDGE_REAL_POLL_MS=1000 \
pnpm vitest run tests/real/ambient-history-real.test.ts --reporter=verbose --no-color
```

Verify real AI ambient decisions:

```bash
BRIDGE_REAL_E2E=1 \
BRIDGE_REAL_AI_EVAL=1 \
BRIDGE_REAL_PROFILE=codex \
BRIDGE_REAL_CHAT_ID="$CHAT_ID" \
BRIDGE_REAL_TIMEOUT_MS=180000 \
BRIDGE_REAL_POLL_MS=1000 \
pnpm vitest run tests/real/ambient-history-real.test.ts --reporter=verbose --no-color
```

Verify `/invite group no-at` full delivery:

```text
/invite group no-at
```

```bash
BRIDGE_REAL_E2E=1 \
BRIDGE_REAL_ALWAYS_E2E=1 \
BRIDGE_REAL_PROFILE=codex \
BRIDGE_REAL_CHAT_ID="$CHAT_ID" \
BRIDGE_REAL_TIMEOUT_MS=240000 \
BRIDGE_REAL_POLL_MS=1000 \
pnpm vitest run tests/real/ambient-history-real.test.ts \
  -t 'runs a real unmentioned group message through the normal no-at agent path' \
  --reporter=verbose --no-color
```

Restore ambient active mode after the no-at check:

```text
/invite group ambient active
```

Passing evidence for no-at must include the history entry, `run.started`, `run.completed`, and `outbound.sent` for the same unmentioned group message path.

If real logs show `ErrCode: 11310` or `cardid is invalid` from Feishu CardKit/markdown-stream, verify that the same message still has `outbound.sent ... markdown-fallback`, and that subsequent markdown replies in the same bridge process switch to ordinary `markdown` instead of retrying markdown-stream.

## Auto-Trigger Conditions

Run this command after changes to:

- `src/commands/**`
- `src/bot/channel.ts`
- `src/bot/app-scope.ts`
- `src/ambient/**`
- `src/history/**`
- `src/config/schema.ts`
- `src/config/profile-schema.ts`
- `src/config/secret-resolver.ts`
- `tests/real/**`
- ambient prompts, model selection, eval cases, or release packaging

Also run it before release, before merging `dev`, and after any real Feishu/Lark permission or credential change.
