# Real Environment Testing

These checks verify behavior that local mocks cannot prove: Feishu/Lark delivery of unmentioned group messages and the real ambient decision runner.

## Preconditions

- A real bridge process is running from this branch.
- The target group contains the bot.
- The target profile is allowed to use the group.
- The app has `im:message.group_msg`; if the bridge sends an authorization card, complete it and run `/reconnect`.

In the real group, run:

```text
/invite group history on
/invite group ambient active
```

When `lark-cli` has a user OAuth session for the same tenant, the real tests can send nonce messages with `--as user`. Otherwise, send the printed nonce messages manually in the group.

If a real test fails before waiting for nonce messages, read the `Real Feishu/Lark test preconditions are not met` block. It reports the current resolved policy and the exact missing action, such as starting the bridge from this branch or running `/invite group history on`.

If the block says `App Secret cannot be decrypted`, re-enter the App Secret for that profile:

```bash
lark-channel-bridge secrets set --profile <profile> --app-id <cli_app_id>
```

## Real Smoke

Run this locally:

```bash
BRIDGE_REAL_E2E=1 \
BRIDGE_REAL_PROFILE=<profile> \
BRIDGE_REAL_CHAT_ID=<oc_chat_id> \
pnpm test:real
```

The test prints a nonce message. Send that exact message in the group without `@`-mentioning the bot.

Passing evidence:

- `history status` reports `enabled: true`.
- The real profile config resolves this chat to `response.mode: "ambient"` and `ambientLevel: "active"`.
- The nonce message appears in the profile history store with `mentionedBot: false`.
- The profile log has a real ambient outcome for the same message id: `ambient-decision-accepted`, `skip-ambient-decision`, or `skip-ambient-prefilter`.

## Real AI Ambient Eval

To additionally verify real agent participation decisions, run:

```bash
BRIDGE_REAL_E2E=1 \
BRIDGE_REAL_AI_EVAL=1 \
BRIDGE_REAL_PROFILE=<profile> \
BRIDGE_REAL_CHAT_ID=<oc_chat_id> \
pnpm test:real
```

The test prints three nonce messages. Send each exact message in the group without `@`-mentioning the bot.

Expected real decision outcomes in active mode:

- Technical help request: `ambient-decision-accepted`
- Substantial project/planning discussion with a useful next-step opening: `ambient-decision-accepted`
- Small-talk planning message: `skip-ambient-decision`

## Real No-At Always E2E

To verify the non-ambient `/invite group no-at` path starts a real agent run without an `@` mention, run:

```bash
BRIDGE_REAL_E2E=1 \
BRIDGE_REAL_ALWAYS_E2E=1 \
BRIDGE_REAL_PROFILE=<profile> \
BRIDGE_REAL_CHAT_ID=<oc_chat_id> \
pnpm test:real
```

In the real group, run:

```text
/invite group history on
/invite group no-at
```

The test prints a nonce message. Send that exact message without `@`-mentioning the bot.

Passing evidence:

- The real profile config resolves this chat to `response.mode: "always"`.
- The nonce message appears in the profile history store with `mentionedBot: false`.
- The profile log records `run.started` and `run.completed` for the same chat scope with `stage: "submit"`.
- The profile log records `outbound.sent` for the same chat scope, proving the no-at path delivered a bot reply instead of only starting an agent run.

This is intentionally not part of default CI because it needs a real Feishu/Lark tenant, a running bridge process, a real group, and a real agent.

## Dev Feature Verification Entry

For the local reusable gate, run:

```bash
pnpm test:dev-features -- --reporter=dot
```

For the full pre-delivery checklist, use:

```text
.claude/commands/dev-feature-verification.md
```
