import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../src/config/app-paths';
import { runHistoryStatus } from '../../src/cli/commands/history';
import { loadRootConfig, runtimeProfileConfig } from '../../src/config/profile-store';
import { resolveAppSecret } from '../../src/config/secret-resolver';
import { getChatHistoryPolicy, getChatResponseMode } from '../../src/config/schema';
import { ChatHistoryStore, type ChatHistoryMessage } from '../../src/history/store';
import { isAlive, readAndPrune } from '../../src/runtime/registry';

const REAL_ENABLED = process.env.BRIDGE_REAL_E2E === '1';
const describeReal = REAL_ENABLED ? describe : describe.skip;

const profile = process.env.BRIDGE_REAL_PROFILE ?? '';
const chatId = process.env.BRIDGE_REAL_CHAT_ID ?? '';
const rootDir = process.env.BRIDGE_REAL_ROOT_DIR ?? process.env.LARK_CHANNEL_HOME;
const timeoutMs = Number(process.env.BRIDGE_REAL_TIMEOUT_MS ?? 180_000);
const pollMs = Number(process.env.BRIDGE_REAL_POLL_MS ?? 2_000);

describeReal('real Feishu/Lark ambient group flow', () => {
  it('captures a real unmentioned group message and records the real ambient outcome', async () => {
    requireRealEnv();
    const nonce = `BRIDGE_REAL_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const text = `${nonce} 我倾向先把上下文记录下来，再安排后续整理`;

    await assertRealPreconditions({
      historyEnabled: true,
      responseMode: 'ambient',
      ambientLevel: 'active',
    });

    console.log(realSetupInstructions({ nonce, text }));

    const status = await captureJsonFromConsole(() =>
      runHistoryStatus({ rootDir, profile, chat: chatId }),
    );
    expect(status).toMatchObject({ profile, chat: chatId, enabled: true });

    const message = await waitForHistoryMessage(text);
    expect(message).toMatchObject({
      chatId,
      content: text,
      mentionedBot: false,
    });

    const outcome = await waitForAmbientOutcome(message.messageId);
    expect(outcome).toEqual(expect.objectContaining({
      msgId: message.messageId,
      phase: 'intake',
    }));
    expect(['ambient-decision-accepted', 'skip-ambient-decision', 'skip-ambient-prefilter']).toContain(
      outcome.event,
    );
  }, timeoutMs + 30_000);

  it.skipIf(process.env.BRIDGE_REAL_AI_EVAL !== '1')(
    'classifies real active-mode ambient participation with the real agent decision runner',
    async () => {
      requireRealEnv();
      const cases: Array<{ id: string; text: string; expectedEvent: string }> = [
        {
          id: 'help',
          text: `BRIDGE_REAL_EVAL_HELP_${Date.now()} 这个 TypeScript 报错怎么修？一直提示类型不兼容`,
          expectedEvent: 'ambient-decision-accepted',
        },
        {
          id: 'active-discussion',
          text: `BRIDGE_REAL_EVAL_ACTIVE_${Date.now()} 我觉得这个方案有风险：先记录群消息再判断是否回复，可能漏掉上下文，下一步需要先梳理触发条件`,
          expectedEvent: 'ambient-decision-accepted',
        },
        {
          id: 'smalltalk',
          text: `BRIDGE_REAL_EVAL_SMALLTALK_${Date.now()} 今晚大家准备一起吃什么，要不要晚点再决定`,
          expectedEvent: 'skip-ambient-prefilter',
        },
      ];

      await assertRealPreconditions({
        historyEnabled: true,
        responseMode: 'ambient',
        ambientLevel: 'active',
      });

      console.log(realEvalInstructions(cases));

      for (const item of cases) {
        const message = await waitForHistoryMessage(item.text);
        const outcome = await waitForAmbientOutcome(message.messageId);
        expect(outcome).toMatchObject({
          msgId: message.messageId,
          phase: 'intake',
          event: item.expectedEvent,
        });
      }
    },
    timeoutMs * 3 + 30_000,
  );

  it.skipIf(process.env.BRIDGE_REAL_ALWAYS_E2E !== '1')(
    'runs a real unmentioned group message through the normal no-at agent path',
    async () => {
      requireRealEnv();
      const text = `BRIDGE_REAL_ALWAYS_${Date.now()} 请用一句话回复：no-at always path ok`;

      await assertRealPreconditions({
        historyEnabled: true,
        responseMode: 'always',
      });

      const startedAfter = Date.now();
      console.log(realAlwaysInstructions(text));

      const message = await waitForHistoryMessage(text);
      expect(message).toMatchObject({
        chatId,
        content: text,
        mentionedBot: false,
      });

      await waitForRunEvent({
        scope: chatId,
        stage: 'submit',
        event: 'started',
        after: startedAfter,
      });
      await waitForRunEvent({
        scope: chatId,
        stage: 'submit',
        event: 'completed',
        after: startedAfter,
      });
      await waitForOutboundSent({
        scope: chatId,
        replyTo: message.messageId,
        after: startedAfter,
      });
    },
    timeoutMs + 60_000,
  );
});

interface RealInstructionsInput {
  nonce: string;
  text: string;
}

function realSetupInstructions(input: RealInstructionsInput): string {
  return [
    '',
    '=== REAL AMBIENT/HISTORY TEST ===',
    `Profile: ${profile}`,
    `Chat: ${chatId}`,
    '',
    'Before sending the nonce message, make sure the bridge process is running from this branch and the test group has:',
    '  /invite group history on',
    '  /invite group ambient active',
    '',
    'If the bridge sends a permission card, authorize im:message.group_msg and run:',
    '  /reconnect',
    '',
    'Now send this exact message in the real group WITHOUT @-mentioning the bot:',
    input.text,
    '',
    `Nonce: ${input.nonce}`,
    `Waiting up to ${timeoutMs}ms for history/log evidence...`,
    '=== END REAL TEST INSTRUCTIONS ===',
    '',
  ].join('\n');
}

function realEvalInstructions(cases: Array<{ id: string; text: string; expectedEvent: string }>): string {
  return [
    '',
    '=== REAL AI AMBIENT EVAL ===',
    `Profile: ${profile}`,
    `Chat: ${chatId}`,
    '',
    'Precondition: the real group is in active ambient mode:',
    '  /invite group ambient active',
    '',
    'Send each exact message below WITHOUT @-mentioning the bot.',
    'The test will inspect real history and real bridge logs for the real agent decision outcome.',
    '',
    ...cases.map((item, index) =>
      [
        `${index + 1}. Case ${item.id}; expected log event: ${item.expectedEvent}`,
        item.text,
      ].join('\n'),
    ),
    '',
    '=== END REAL AI AMBIENT EVAL ===',
    '',
  ].join('\n');
}

function realAlwaysInstructions(text: string): string {
  return [
    '',
    '=== REAL NO-AT ALWAYS E2E ===',
    `Profile: ${profile}`,
    `Chat: ${chatId}`,
    '',
    'Before sending the nonce message, make sure the bridge process is running from this branch and the test group has:',
    '  /invite group history on',
    '  /invite group no-at',
    '',
    'Now send this exact message in the real group WITHOUT @-mentioning the bot:',
    text,
    '',
    `Waiting up to ${timeoutMs}ms for history/log/run evidence...`,
    '=== END REAL NO-AT ALWAYS E2E ===',
    '',
  ].join('\n');
}

function requireRealEnv(): void {
  const missing: string[] = [];
  if (!profile) missing.push('BRIDGE_REAL_PROFILE');
  if (!chatId) missing.push('BRIDGE_REAL_CHAT_ID');
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(', ')}. Example: BRIDGE_REAL_E2E=1 BRIDGE_REAL_PROFILE=dev BRIDGE_REAL_CHAT_ID=oc_xxx pnpm test:real`,
    );
  }
}

async function waitForHistoryMessage(text: string): Promise<ChatHistoryMessage> {
  const paths = resolveAppPaths({ rootDir, profile });
  const store = new ChatHistoryStore(paths.historyDir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await store.search({ chatId, query: text, limit: 5 });
    const exact = matches.find((item) => item.content === text);
    if (exact) return exact;
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for real history message containing: ${text}`);
}

async function waitForAmbientOutcome(messageId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = await readBridgeLogs();
    const outcome = lines.find(
      (line) =>
        line.msgId === messageId &&
        line.phase === 'intake' &&
        (line.event === 'ambient-decision-accepted' ||
          line.event === 'skip-ambient-decision' ||
          line.event === 'skip-ambient-prefilter'),
    );
    if (outcome) return outcome;
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for ambient decision log for message ${messageId}`);
}

async function waitForRunEvent(input: {
  scope: string;
  stage: string;
  event: 'started' | 'completed';
  after: number;
}): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = await readBridgeLogs();
    const outcome = lines.find(
      (line) =>
        line.phase === 'run' &&
        line.event === input.event &&
        line.scope === input.scope &&
        line.stage === input.stage &&
        logTimestamp(line) >= input.after,
    );
    if (outcome) return outcome;
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for run.${input.event} log for scope ${input.scope}`);
}

async function waitForOutboundSent(input: {
  scope: string;
  replyTo: string;
  after: number;
}): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = await readBridgeLogs();
    const outcome = lines.find(
      (line) =>
        line.phase === 'outbound' &&
        line.event === 'sent' &&
        line.scope === input.scope &&
        line.replyTo === input.replyTo &&
        logTimestamp(line) >= input.after,
    );
    if (outcome) return outcome;
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for outbound.sent log for reply ${input.replyTo}`);
}

async function readBridgeLogs(): Promise<Array<Record<string, unknown>>> {
  const logsDir = resolveAppPaths({ rootDir, profile }).logsDir;
  const files = await readdir(logsDir).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  });
  const bridgeLogs = files
    .filter((file) => /^bridge-(?:\d{8}|\d{4}-\d{2}-\d{2})\.jsonl$/.test(file))
    .sort()
    .slice(-3);
  const lines: Array<Record<string, unknown>> = [];
  for (const file of bridgeLogs) {
    const text = await readFile(join(logsDir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
  }
  return lines;
}

interface RealPreconditions {
  historyEnabled: true;
  responseMode: 'ambient' | 'always';
  ambientLevel?: 'quiet' | 'balanced' | 'active';
}

async function assertRealPreconditions(expected: RealPreconditions): Promise<void> {
  const ctx = await readRealContext();
  const missing: string[] = [];
  if (ctx.secretError) {
    const recovery = `lark-channel-bridge secrets set --profile ${profile} --app-id ${ctx.appId}`;
    missing.push(
      ctx.secretError.includes('lark-channel-bridge secrets set')
        ? `App Secret cannot be decrypted: ${ctx.secretError.replace('<profile>', profile)}`
        : `App Secret cannot be decrypted: ${ctx.secretError}. Re-enter it with: ${recovery}`,
    );
  }
  if (ctx.liveBridgeProcesses.length === 0) {
    missing.push(
      `No live bridge process is registered for profile "${profile}". Start one from this branch, for example: pnpm bridge:run-current -- --profile ${profile}`,
    );
  }
  if (ctx.policy.history.enabled !== expected.historyEnabled) {
    missing.push(
      `Chat history is ${ctx.policy.history.enabled ? 'enabled' : 'disabled'}; run in the real group: /invite group history on`,
    );
  }
  if (ctx.policy.response.mode !== expected.responseMode) {
    missing.push(
      `Chat response mode is "${ctx.policy.response.mode}", expected "${expected.responseMode}"; run in the real group: ${
        expected.responseMode === 'ambient' ? '/invite group ambient active' : '/invite group no-at'
      }`,
    );
  }
  if (expected.ambientLevel && ctx.policy.response.ambientLevel !== expected.ambientLevel) {
    missing.push(
      `Ambient level is "${ctx.policy.response.ambientLevel}", expected "${expected.ambientLevel}"; run in the real group: /invite group ambient ${expected.ambientLevel}`,
    );
  }
  if (missing.length > 0) {
    throw new Error([
      'Real Feishu/Lark test preconditions are not met.',
      `Profile: ${profile}`,
      `Chat: ${chatId}`,
      `App ID: ${ctx.appId}`,
      `Current policy: ${JSON.stringify(ctx.policy)}`,
      '',
      ...missing.map((item) => `- ${item}`),
    ].join('\n'));
  }
}

async function readRealContext(): Promise<{
  appId: string;
  secretError?: string;
  policy: {
    history: ReturnType<typeof getChatHistoryPolicy>;
    response: ReturnType<typeof getChatResponseMode>;
  };
  liveBridgeProcesses: Array<{ pid: number; id: string; startedAt: string }>;
}> {
  const paths = resolveAppPaths({ rootDir, profile });
  const root = await loadRootConfig(paths.configFile);
  if (!root) throw new Error(`Missing root profile config: ${paths.configFile}`);
  const cfg = runtimeProfileConfig(root, profile);
  let secretError: string | undefined;
  try {
    await resolveAppSecret(cfg, paths);
  } catch (err) {
    secretError = err instanceof Error ? err.message : String(err);
  }
  const liveBridgeProcesses = readAndPrune(paths.userRegistryFile)
    .filter((entry) =>
      entry.profileName === profile &&
      entry.appId === cfg.accounts.app.id &&
      entry.pid !== process.pid &&
      isAlive(entry.pid)
    )
    .map((entry) => ({ pid: entry.pid, id: entry.id, startedAt: entry.startedAt }));
  return {
    appId: cfg.accounts.app.id,
    ...(secretError ? { secretError } : {}),
    policy: {
      history: getChatHistoryPolicy(cfg, chatId),
      response: getChatResponseMode(cfg, chatId),
    },
    liveBridgeProcesses,
  };
}

async function captureJsonFromConsole(fn: () => Promise<void>): Promise<Record<string, unknown>> {
  const original = console.log;
  const outputs: string[] = [];
  console.log = (value?: unknown): void => {
    outputs.push(String(value));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  const latest = outputs.at(-1);
  if (!latest) throw new Error('expected command to print JSON');
  return JSON.parse(latest) as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logTimestamp(line: Record<string, unknown>): number {
  const ts = typeof line.ts === 'string' ? Date.parse(line.ts) : Number.NaN;
  return Number.isFinite(ts) ? ts : 0;
}
