import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { PermissionConfig } from '../../../src/config/permissions.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';
import { ChatHistoryStore } from '../../../src/history/store.js';
import type { AmbientDecision } from '../../../src/ambient/decision-runner.js';
import { getChatHistoryPolicy } from '../../../src/config/schema.js';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
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

import { startChannel } from '../../../src/bot/channel.js';

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
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('bot identity injection into the agent adapter', () => {
  it('passes channel.botIdentity to the adapter after connect', async () => {
    const h = await createHarness();

    await startTestBridge(h);

    expect(h.agent.botIdentity).toEqual({ openId: 'ou_bot', name: 'Bridge' });
  });
});

describe('sender identity in bridge_context', () => {
  it('uses /invite group no-at to let later unmentioned group messages run, then /remove group no-at disables it', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_invite_no_at',
        content: '/invite group no-at',
      }),
    );
    expect(lastMarkdown(h.channel)).toContain('不 @');
    expect(lastMarkdown(h.channel)).not.toContain('无需重复添加');

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_unmentioned_after_command',
        content: '不用 @ 的普通群消息',
        mentionedBot: false,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_remove_no_at',
        content: '/remove group no-at',
      }),
    );
    expect(lastMarkdown(h.channel)).toContain('已关闭当前群的不 @');

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_unmentioned_after_remove',
        content: '关闭后不 @ 不应触发',
        mentionedBot: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('accepts unmentioned group messages only when the per-chat no-at policy allows them', async () => {
    const strict = await createHarness();
    await startTestBridge(strict);

    await strict.channel.handlers.message?.(
      message({
        messageId: 'om_unmentioned_strict',
        content: '不用 @ 的普通群消息',
        mentionedBot: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(strict.agent.runOptions).toHaveLength(0);

    const open = await createHarness({
      chatPolicies: {
        oc_chat: { requireMention: false },
      },
    });
    await startTestBridge(open);

    await open.channel.handlers.message?.(
      message({
        messageId: 'om_unmentioned_open',
        content: '不用 @ 的普通群消息',
        mentionedBot: false,
      }),
    );
    await waitFor(() => open.agent.runOptions.length === 1);
  });

  it('does not persist group history unless explicitly enabled', async () => {
    const h = await createHarness({
      chatPolicies: {
        oc_chat: { requireMention: false },
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_no_history',
        content: '不 @ 但不开历史',
        mentionedBot: false,
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const store = new ChatHistoryStore(join(h.tmp.profile, 'history'));
    await expect(store.tail({ chatId: 'oc_chat', limit: 10 })).resolves.toEqual([]);
  });

  it('persists allowed group messages when chat history is enabled even when mention-only skips reply', async () => {
    const h = await createHarness({
      chatPolicies: {
        oc_chat: { history: { enabled: true, retentionDays: 365 } },
      },
    });
    expect(getChatHistoryPolicy(h.controls.cfg, 'oc_chat').enabled).toBe(true);
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_history_only',
        content: '这条不 @，只应该记录历史',
        mentionedBot: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.agent.runOptions).toHaveLength(0);
    const store = new ChatHistoryStore(join(h.tmp.profile, 'history'));
    await expect(store.tail({ chatId: 'oc_chat', limit: 10 })).resolves.toMatchObject([
      {
        messageId: 'om_history_only',
        chatId: 'oc_chat',
        content: '这条不 @，只应该记录历史',
      },
    ]);
  });

  it('uses ambient decision before queuing unmentioned group messages', async () => {
    const h = await createHarness({
      chatPolicies: {
        oc_chat: { responseMode: 'ambient', ambientLevel: 'balanced' },
      },
    });
    const ambientDecisionRunner = vi.fn(async (): Promise<AmbientDecision> => ({
      respond: false,
      reason: 'not-needed',
    }));
    await startTestBridge(h, { ambientDecisionRunner });

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_ambient_skip',
        content: '这个方案是不是要先拆边界再推进？',
        mentionedBot: false,
      }),
    );
    await waitFor(() => ambientDecisionRunner.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 750));

    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('queues unmentioned group messages when ambient decision opts in', async () => {
    const h = await createHarness({
      chatPolicies: {
        oc_chat: { responseMode: 'ambient', ambientLevel: 'balanced' },
      },
    });
    await startTestBridge(h, {
      ambientDecisionRunner: async () => ({ respond: true, reason: 'useful' }),
    });

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_ambient_reply',
        content: '这个方案是不是要先拆边界再推进？',
        mentionedBot: false,
      }),
    );

    await waitFor(() => h.agent.runOptions.length === 1);
  });

  it('queues clear technical ambient candidates without starting an AI decision', async () => {
    const h = await createHarness({
      chatPolicies: {
        oc_chat: { responseMode: 'ambient', ambientLevel: 'balanced' },
      },
    });
    const ambientDecisionRunner = vi.fn(async (): Promise<AmbientDecision> => ({
      respond: false,
      reason: 'should-not-run',
    }));
    await startTestBridge(h, { ambientDecisionRunner });

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_ambient_rule_accept',
        content: '这个 TypeScript 报错怎么修？',
        mentionedBot: false,
      }),
    );

    await waitFor(() => h.agent.runOptions.length === 1);
    expect(ambientDecisionRunner).not.toHaveBeenCalled();
  });

  it('fails open for active ambient timeout on substantial project discussion', async () => {
    const h = await createHarness({
      chatPolicies: {
        oc_chat: { responseMode: 'ambient', ambientLevel: 'active' },
      },
    });
    const ambientDecisionRunner = vi.fn(async (): Promise<AmbientDecision> => ({
      respond: false,
      reason: 'timeout:active:60000ms',
    }));
    await startTestBridge(h, { ambientDecisionRunner });

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_ambient_timeout_fail_open',
        content: '我倾向先把上下文记录下来，再安排后续整理',
        mentionedBot: false,
      }),
    );

    await waitFor(() => ambientDecisionRunner.mock.calls.length === 1);
    await waitFor(() => h.agent.runOptions.length === 1);
  });

  it('runs ambient decisions through profile run policy', async () => {
    const h = await createHarness({
      chatPolicies: {
        oc_chat: { responseMode: 'ambient', ambientLevel: 'balanced' },
      },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });
    h.agent.setEvents([
      [
        { type: 'text', delta: '{"respond":true,"reason":"useful"}' },
        { type: 'done', terminationReason: 'normal' },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_ambient_policy',
        content: '这个方案是不是要先拆边界再推进？',
        mentionedBot: false,
      }),
    );

    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[0]).toMatchObject({
      sandbox: 'read-only',
      permissionMode: 'plan',
      cwd: h.profileConfig.workspaces.default,
    });
    expect(h.agent.runOptions[0]?.prompt).toContain('You decide whether a chat bot should participate');
    expect(h.agent.runOptions[1]).toMatchObject({
      sandbox: 'read-only',
      permissionMode: 'plan',
    });
  });

  it('allows concurrent default ambient decisions in the same group', async () => {
    const h = await createHarness({
      chatPolicies: {
        oc_chat: { responseMode: 'ambient', ambientLevel: 'balanced' },
      },
    });
    const releases: Array<() => void> = [];
    vi.spyOn(h.agent, 'run').mockImplementation((opts) => {
      h.agent.runOptions.push(opts);
      return controlledAmbientRun(opts, releases);
    });
    await startTestBridge(h);

    const pending = [1, 2].map((index) => h.channel.handlers.message?.(
      message({
        messageId: `om_default_ambient_concurrent_${index}`,
        content: `这个方案是不是要先拆边界再推进？ ${index}`,
        mentionedBot: false,
      }),
    ) as Promise<void>);

    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[0]?.prompt).toContain('You decide whether a chat bot should participate');
    expect(h.agent.runOptions[1]?.prompt).toContain('You decide whether a chat bot should participate');

    for (const release of releases.splice(0)) release();
    await Promise.all(pending);
    expect(h.agent.runOptions).toHaveLength(2);
  });

  it('limits concurrent ambient decisions before queuing unmentioned group messages', async () => {
    const h = await createHarness({
      chatPolicies: {
        oc_chat: { responseMode: 'ambient', ambientLevel: 'balanced' },
      },
    });
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const ambientDecisionRunner = vi.fn(async (): Promise<AmbientDecision> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { respond: false, reason: 'skip' };
    });
    await startTestBridge(h, { ambientDecisionRunner });

    const pending = [1, 2, 3].map((index) => h.channel.handlers.message?.(
      message({
        messageId: `om_ambient_limit_${index}`,
        content: `这个方案是不是要先拆边界再推进？ ${index}`,
        mentionedBot: false,
      }),
    ) as Promise<void>);

    await waitFor(() => ambientDecisionRunner.mock.calls.length === 2);
    expect(maxActive).toBe(2);

    releases.shift()?.();
    await waitFor(() => ambientDecisionRunner.mock.calls.length === 3);
    expect(maxActive).toBe(2);

    for (const release of releases.splice(0)) release();
    await Promise.all(pending);
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('queues every unmentioned group message in always mode without ambient decision', async () => {
    const h = await createHarness({
      chatPolicies: {
        oc_chat: { responseMode: 'always' },
      },
    });
    const ambientDecisionRunner = vi.fn(async (): Promise<AmbientDecision> => ({
      respond: false,
      reason: 'should-not-run',
    }));
    await startTestBridge(h, { ambientDecisionRunner });

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_always',
        content: '普通群消息',
        mentionedBot: false,
      }),
    );

    await waitFor(() => h.agent.runOptions.length === 1);
    expect(ambientDecisionRunner).not.toHaveBeenCalled();
  });

  it('only exposes history CLI guidance in prompts when chat history is enabled', async () => {
    const disabled = await createHarness();
    await startTestBridge(disabled);
    await disabled.channel.handlers.message?.(
      message({
        messageId: 'om_history_disabled_prompt',
        content: '@Bridge 看下上下文',
      }),
    );
    await waitFor(() => disabled.agent.runOptions.length === 1);
    expect(disabled.agent.runOptions[0]?.prompt).not.toContain('lark-channel-bridge history');

    const enabled = await createHarness({
      chatPolicies: {
        oc_chat: { history: { enabled: true } },
      },
    });
    await startTestBridge(enabled);
    await enabled.channel.handlers.message?.(
      message({
        messageId: 'om_history_enabled_prompt',
        content: '@Bridge 看下上下文',
      }),
    );
    await waitFor(() => enabled.agent.runOptions.length === 1);
    const prompt = enabled.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('lark-channel-bridge history tail --chat oc_chat');
    expect(prompt).toContain('lark-channel-bridge history search --chat oc_chat');
    expect(prompt).toContain('lark-channel-bridge history around --chat oc_chat --message');
    expect(prompt).toContain('不要回答“完全看不到未 @ 的群消息”');
    expect(prompt).toContain('可以按需查询当前群开启历史后记录到的未 @ 消息');
  });

  it('marks a bot sender via raw sender_type and injects botOpenId and mentions', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_from_bot',
        senderId: 'ou_hermes',
        senderName: 'HermesBot',
        content: '@Bridge 部署完成，请验证',
        rawSenderType: 'app',
        mentions: [
          { key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true },
          { key: '@_user_2', openId: 'ou_human', name: '张三', isBot: false },
        ],
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const context = readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_context') as {
      senderType?: string;
      botOpenId?: string;
      mentions?: Array<{ openId?: string; name?: string; isBot?: boolean }>;
    };
    expect(context.senderType).toBe('bot');
    expect(context.botOpenId).toBe('ou_bot');
    expect(context.mentions).toEqual([
      { openId: 'ou_bot', name: 'Bridge', isBot: true },
      { openId: 'ou_human', name: '张三', isBot: false },
    ]);
  });

  it('marks a human sender via raw sender_type', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_from_user',
        content: '@Bridge 帮我看个问题',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const context = readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_context') as {
      senderType?: string;
    };
    expect(context.senderType).toBe('user');
  });

  it('omits senderType when the raw event is unavailable', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_no_raw',
        content: '@Bridge 在吗',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const context = readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_context') as Record<
      string,
      unknown
    >;
    expect(context).not.toHaveProperty('senderType');
    expect(context.botOpenId).toBe('ou_bot');
  });

  it('turns a mention-only message into an explicit wake-up ping', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_empty_at',
        content: '',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const userInput = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as {
      text: string;
    };
    expect(userInput.text).toContain('唤醒');
    expect(userInput.text).toContain('没有正文');
  });

  it('annotates each message with its sender when a batch merges multiple senders', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_batch_user',
        senderId: 'ou_human',
        senderName: '张三',
        content: '@Bridge 这个报错怎么回事',
        rawSenderType: 'user',
      }),
    );
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_batch_bot',
        senderId: 'ou_hermes',
        senderName: 'HermesBot',
        content: '我刚发布了 v1.2.3',
        rawSenderType: 'app',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const userInput = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as {
      text: string;
    };
    expect(userInput.text).toContain('[张三 (user)]:');
    expect(userInput.text).toContain('[HermesBot (bot)]:');
    expect(userInput.text).toContain('这个报错怎么回事');
    expect(userInput.text).toContain('我刚发布了 v1.2.3');
  });

  it('keeps single-message batches free of sender annotations', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_single',
        content: '@Bridge 看下这个',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const userInput = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as {
      text: string;
    };
    expect(userInput.text).not.toContain('[User (user)]:');
    expect(userInput.text).toContain('看下这个');
  });
});

async function createHarness(access?: {
  chatPolicies?: Record<string, {
    requireMention?: boolean;
    responseMode?: 'mention-only' | 'ambient' | 'always';
    ambientLevel?: 'quiet' | 'balanced' | 'active';
    history?: { enabled?: boolean; retentionDays?: number; maxMessages?: number };
  }>;
  permissions?: Partial<PermissionConfig>;
}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('bot-at-bot-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_chat'],
      allowedUsers: ['ou_user'],
      admins: ['ou_user'],
      ...(access?.chatPolicies ? { chatPolicies: access.chatPolicies } : {}),
    },
    ...(access?.permissions ? { permissions: access.permissions } : {}),
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig('test', profileConfig), configPath);
  const controls = createControls(profileConfig, configPath);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  tmp: TmpProfile;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}, opts: {
  ambientDecisionRunner?: (input: {
    message: {
      messageId: string;
      chatId: string;
      threadId?: string;
      senderId: string;
      content: string;
      createdAt: string;
    };
    recentMessages: Array<{
      messageId: string;
      chatId: string;
      threadId?: string;
      senderId: string;
      content: string;
      createdAt: string;
    }>;
    level: 'quiet' | 'balanced' | 'active';
    cwd: string;
  }) => Promise<AmbientDecision>;
} = {}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.controls.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
    appPaths: {
      mediaDir: join(h.tmp.profile, 'media'),
      historyDir: join(h.tmp.profile, 'history'),
    },
    ambientDecisionRunner: opts.ambientDecisionRunner,
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
                  owner: { owner_id: 'ou_owner' },
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
    async stream(_chatId, input) {
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
    },
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>, configPath: string) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath,
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function controlledAmbientRun(opts: AgentRunOptions, releases: Array<() => void>): AgentRun {
  let stopped = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
    releases.push(resolve);
  });
  const events = async function* (): AsyncIterable<AgentEvent> {
    await released;
    if (stopped) return;
    yield { type: 'text', delta: '{"respond":false,"reason":"skip"}' };
    yield { type: 'done', terminationReason: 'normal' };
  };

  return {
    runId: opts.runId,
    events: events(),
    async stop() {
      stopped = true;
      release();
    },
    async waitForExit() {
      return true;
    },
  };
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  const markdown = (content as { markdown?: unknown }).markdown;
  expect(markdown).toBeTypeOf('string');
  return markdown as string;
}

function message(input: {
  messageId: string;
  content: string;
  senderId?: string;
  senderName?: string;
  rawSenderType?: string;
  mentions?: Array<{ key: string; openId?: string; name?: string; isBot?: boolean }>;
  mentionedBot?: boolean;
}): NormalizedMessage {
  const mentionedBot = input.mentionedBot ?? true;
  return {
    messageId: input.messageId,
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: input.senderId ?? 'ou_user',
    senderName: input.senderName ?? 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions:
      input.mentions ??
      (mentionedBot ? [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }] : []),
    mentionAll: false,
    mentionedBot,
    createTime: 1760000001000,
    ...(input.rawSenderType
      ? {
          raw: {
            sender: {
              sender_id: { open_id: input.senderId ?? 'ou_user' },
              sender_type: input.rawSenderType,
            },
            message: { message_id: input.messageId },
          },
        }
      : {}),
  } as unknown as NormalizedMessage;
}

function readSection(prompt: string, tag: string): unknown {
  const match = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  if (!match) throw new Error(`missing section ${tag}`);
  return JSON.parse(match[1] ?? 'null') as unknown;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}
