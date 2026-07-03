import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { ChatHistoryStore } from '../../../src/history/store';
import {
  runHistoryAround,
  runHistorySearch,
  runHistoryStatus,
  runHistoryTail,
} from '../../../src/cli/commands/history';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-history-cli-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('history CLI commands', () => {
  it('prints tail results from the active profile history store', async () => {
    const rootDir = await tempRoot();
    await writeProfileConfig(rootDir, 'codex-dev', {
      oc_1: { enabled: true },
    });
    const store = new ChatHistoryStore(resolveAppPaths({ rootDir, profile: 'codex-dev' }).historyDir);
    await store.append(message({ messageId: 'om_1', content: 'one' }));
    await store.append(message({ messageId: 'om_2', content: 'two' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runHistoryTail({ rootDir, chat: 'oc_1', limit: '1' });

    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual([
      message({ messageId: 'om_2', content: 'two' }),
    ]);
  });

  it('prints search results for an explicit profile', async () => {
    const rootDir = await tempRoot();
    await writeProfileConfig(rootDir, 'claude', {
      oc_1: { enabled: true },
    });
    const store = new ChatHistoryStore(resolveAppPaths({ rootDir, profile: 'claude' }).historyDir);
    await store.append(message({ messageId: 'om_1', content: 'Alpha' }));
    await store.append(message({ messageId: 'om_2', content: 'Beta' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runHistorySearch({ rootDir, profile: 'claude', chat: 'oc_1', query: 'alpha' });

    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual([
      message({ messageId: 'om_1', content: 'Alpha' }),
    ]);
  });

  it('prints context around a message id within an enabled chat', async () => {
    const rootDir = await tempRoot();
    await writeProfileConfig(rootDir, 'claude', {
      oc_1: { enabled: true },
      oc_2: { enabled: true },
    });
    const store = new ChatHistoryStore(resolveAppPaths({ rootDir, profile: 'claude' }).historyDir);
    await store.append(message({ messageId: 'om_1', content: 'one' }));
    await store.append(message({ messageId: 'om_2', content: 'two' }));
    await store.append(message({ messageId: 'om_3', content: 'three' }));
    await store.append(message({ chatId: 'oc_2', messageId: 'om_2', content: 'other chat' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runHistoryAround({
      rootDir,
      profile: 'claude',
      chat: 'oc_1',
      message: 'om_2',
      before: '1',
      after: '1',
    });

    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual([
      message({ messageId: 'om_1', content: 'one' }),
      message({ messageId: 'om_2', content: 'two' }),
      message({ messageId: 'om_3', content: 'three' }),
    ]);
  });

  it('rejects history reads when the chat has not opted in', async () => {
    const rootDir = await tempRoot();
    await writeProfileConfig(rootDir, 'claude', {
      oc_1: { enabled: false },
    });
    const store = new ChatHistoryStore(resolveAppPaths({ rootDir, profile: 'claude' }).historyDir);
    await store.append(message({ messageId: 'om_1', content: 'stored before opt-out' }));

    await expect(runHistoryTail({ rootDir, profile: 'claude', chat: 'oc_1' })).rejects.toThrow(
      /history is not enabled for chat oc_1/,
    );
    await expect(runHistorySearch({
      rootDir,
      profile: 'claude',
      chat: 'oc_1',
      query: 'stored',
    })).rejects.toThrow(/history is not enabled for chat oc_1/);
    await expect(runHistoryAround({
      rootDir,
      profile: 'claude',
      chat: 'oc_1',
      message: 'om_1',
    })).rejects.toThrow(/history is not enabled for chat oc_1/);
  });

  it('prints diagnostic status without requiring history to be enabled', async () => {
    const rootDir = await tempRoot();
    await writeProfileConfig(rootDir, 'claude', {
      oc_1: { enabled: false },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runHistoryStatus({ rootDir, profile: 'claude', chat: 'oc_1' });

    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
      rootDir,
      profile: 'claude',
      chat: 'oc_1',
      enabled: false,
      fileExists: false,
      fileBytes: 0,
      messageCount: 0,
    });
  });

  it('prints recorded message counts and latest timestamps in status output', async () => {
    const rootDir = await tempRoot();
    await writeProfileConfig(rootDir, 'claude', {
      oc_1: { enabled: true },
    });
    const store = new ChatHistoryStore(resolveAppPaths({ rootDir, profile: 'claude' }).historyDir);
    await store.append(message({
      messageId: 'om_1',
      content: 'one',
      createdAt: '2026-07-02T00:00:00.000Z',
      recordedAt: '2026-07-02T00:00:01.000Z',
    }));
    await store.append(message({
      messageId: 'om_2',
      content: 'two',
      createdAt: '2026-07-02T00:01:00.000Z',
      recordedAt: '2026-07-02T00:01:01.000Z',
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runHistoryStatus({ rootDir, profile: 'claude', chat: 'oc_1' });

    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
      enabled: true,
      fileExists: true,
      messageCount: 2,
      latestMessageId: 'om_2',
      latestCreatedAt: '2026-07-02T00:01:00.000Z',
      latestRecordedAt: '2026-07-02T00:01:01.000Z',
    });
  });
});

async function writeProfileConfig(
  rootDir: string,
  profile: string,
  history: Record<string, { enabled: boolean }>,
): Promise<void> {
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_app',
        secret: 'cli_secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: Object.keys(history),
      chatPolicies: Object.fromEntries(
        Object.entries(history).map(([chatId, policy]) => [chatId, { history: policy }]),
      ),
    },
  });
  await saveRootConfig(createRootConfig(profile, profileConfig), resolveAppPaths({ rootDir }).configFile);
  await writeFile(resolveAppPaths({ rootDir }).activeProfileFile, `${profile}\n`, 'utf8');
}

function message(overrides: Record<string, unknown>) {
  return {
    messageId: 'om_0',
    chatId: 'oc_1',
    chatType: 'group',
    senderId: 'ou_sender',
    content: '',
    mentionedBot: false,
    mentions: [],
    createdAt: '2026-07-02T00:00:00.000Z',
    recordedAt: '2026-07-02T00:00:01.000Z',
    ...overrides,
  };
}
