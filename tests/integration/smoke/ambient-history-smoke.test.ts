import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { startChannel, type AmbientDecisionRunner } from '../../../src/bot/channel';
import { runHistoryStatus } from '../../../src/cli/commands/history';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { ChatHistoryStore } from '../../../src/history/store';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as (FakeLarkChannel & { handlers: MessageHandlerMap }) | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('ambient group history smoke flow', () => {
  it('enables history and ambient mode, then records and answers an unmentioned group message', async () => {
    const h = await createHarness();
    const ambientDecisionRunner = vi.fn<AmbientDecisionRunner>(async () => ({
      respond: true,
      reason: 'smoke-flow-useful',
    }));
    await startTestBridge(h, ambientDecisionRunner);

    await h.channel.handlers.message?.(message({
      messageId: 'om_history_on',
      content: '/invite group history on',
      mentionedBot: true,
    }));
    await h.channel.handlers.message?.(message({
      messageId: 'om_ambient_on',
      content: '/invite group ambient active',
      mentionedBot: true,
    }));
    await h.channel.handlers.message?.(message({
      messageId: 'om_unmentioned',
      content: '我倾向先把上下文记录下来，再安排后续整理',
      mentionedBot: false,
    }));

    await waitFor(() => h.agent.runOptions.length === 1);

    expect(ambientDecisionRunner).toHaveBeenCalledWith(expect.objectContaining({
      level: 'active',
      message: expect.objectContaining({
        messageId: 'om_unmentioned',
        content: '我倾向先把上下文记录下来，再安排后续整理',
      }),
      recentMessages: expect.arrayContaining([
        expect.objectContaining({ messageId: 'om_ambient_on' }),
      ]),
    }));
    expect(h.agent.runOptions[0]?.prompt).toContain('lark-channel-bridge history tail');

    const store = new ChatHistoryStore(resolveAppPaths({ rootDir: h.tmp.root, profile: 'test' }).historyDir);
    await expect(store.tail({ chatId: 'oc_chat', limit: 5 })).resolves.toMatchObject([
      {
        messageId: 'om_ambient_on',
        content: '/invite group ambient active',
      },
      {
        messageId: 'om_unmentioned',
        content: '我倾向先把上下文记录下来，再安排后续整理',
      },
    ]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runHistoryStatus({ rootDir: h.tmp.root, profile: 'test', chat: 'oc_chat' });
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string)).toMatchObject({
      profile: 'test',
      chat: 'oc_chat',
      enabled: true,
      messageCount: 2,
      latestMessageId: 'om_unmentioned',
    });
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('ambient-history-smoke-');
  const workspace = await realpath(tmp.workspace);
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'smoke_app',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_chat'],
      allowedUsers: ['ou_user'],
      admins: ['ou_user'],
    },
  });
  profileConfig.workspaces.default = workspace;
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig('test', profileConfig), configPath);

  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const controls = createControls(profileConfig, configPath);

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, agent, sessions, workspaces, controls };
}

async function startTestBridge(
  h: {
    tmp: TmpProfile;
    agent: FakeAgentAdapter;
    sessions: SessionStore;
    workspaces: WorkspaceStore;
    controls: ReturnType<typeof createControls>;
  },
  ambientDecisionRunner: AmbientDecisionRunner,
): Promise<void> {
  const bridge = await startChannel({
    cfg: h.controls.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
    appPaths: {
      mediaDir: resolveAppPaths({ rootDir: h.tmp.root, profile: 'test' }).mediaDir,
      historyDir: resolveAppPaths({ rootDir: h.tmp.root, profile: 'test' }).historyDir,
    },
    ambientDecisionRunner,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  return {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: {
                app: {
                  owner: { owner_id: 'ou_user' },
                  scopes: [{ scope: 'im:message.group_msg' }],
                },
              },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
    },
    async stream() {},
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>, configPath: string) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'ok' as const,
    ownerRefreshedAt: 1_700_000_000_000,
    botOwnerId: 'ou_user',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath,
    cfg: profileConfig,
    processId: 'proc_smoke',
  };
}

function message(input: {
  messageId: string;
  content: string;
  mentionedBot: boolean;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: input.mentionedBot
      ? [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }]
      : [],
    mentionAll: false,
    mentionedBot: input.mentionedBot,
    createTime: Date.parse('2026-07-11T00:00:00.000Z'),
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
