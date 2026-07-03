import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMessageReplyMode,
  getRequireMentionInGroup,
  shouldRequireMentionInChat,
} from '../../../src/config/schema.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import type { NormalizedMessage } from '@larksuite/channel';

describe('Claude IM regression boundaries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps p2p unrestricted while group and topic chats require a direct bot mention by default', () => {
    const cfg = {
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' as const } },
    };

    expect(getRequireMentionInGroup(cfg)).toBe(true);
  });

  it('resolves per-chat mention policy before global group default', () => {
    const cfg = {
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' as const } },
      access: {
        allowedUsers: [],
        allowedChats: ['oc_open', 'oc_strict'],
        admins: [],
        requireMentionInGroup: true,
        chatPolicies: {
          oc_open: { requireMention: false },
          oc_strict: { requireMention: true },
        },
      },
    };

    expect(shouldRequireMentionInChat(cfg, 'oc_open')).toBe(false);
    expect(shouldRequireMentionInChat(cfg, 'oc_strict')).toBe(true);
    expect(shouldRequireMentionInChat(cfg, 'oc_default')).toBe(true);
  });

  it('falls back to legacy preferences when profile access is absent', () => {
    const cfg = {
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' as const } },
      preferences: { requireMentionInGroup: false },
    };

    expect(shouldRequireMentionInChat(cfg, 'oc_any')).toBe(false);
  });

  it('honors legacy preferences access per-chat mention policies', () => {
    const cfg = {
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' as const } },
      preferences: {
        requireMentionInGroup: true,
        access: {
          chatPolicies: {
            oc_open: { requireMention: false },
            oc_strict: { requireMention: true },
          },
        },
      },
    };

    expect(shouldRequireMentionInChat(cfg, 'oc_open')).toBe(false);
    expect(shouldRequireMentionInChat(cfg, 'oc_strict')).toBe(true);
    expect(shouldRequireMentionInChat(cfg, 'oc_default')).toBe(true);
  });

  it('keeps markdown as the default reply mode and card as the explicit stop-button mode', () => {
    const defaultCfg = {
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' as const } },
    };
    const cardCfg = {
      ...defaultCfg,
      preferences: { messageReply: 'card' as const },
    };

    expect(getMessageReplyMode(defaultCfg)).toBe('markdown');
    expect(getMessageReplyMode(cardCfg)).toBe('card');
  });

  it('queues messages that arrive while a run is active and flushes them as the next batch', () => {
    vi.useFakeTimers();
    const flushed: Array<{ scope: string; batch: NormalizedMessage[] }> = [];
    const queue = new PendingQueue(600, (scope, batch) => flushed.push({ scope, batch }));

    queue.block('chat-1');
    expect(queue.push('chat-1', msg('m-1', 'first'))).toBe(1);
    expect(queue.push('chat-1', msg('m-2', 'second'))).toBe(2);

    vi.advanceTimersByTime(5_000);
    expect(flushed).toEqual([]);

    queue.unblock('chat-1');
    vi.advanceTimersByTime(599);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(flushed).toEqual([
      { scope: 'chat-1', batch: [msg('m-1', 'first'), msg('m-2', 'second')] },
    ]);
  });

  it('documents the private intake policy that drops @all and undirected group chatter', async () => {
    const source = await readFile(join(process.cwd(), 'src/bot/channel.ts'), 'utf8');

    expect(source).toContain('respondToMentionAll: false');
    expect(source).toContain('getChatResponseMode(controls.cfg, msg.chatId)');
    expect(source).toContain('responseMode.mode === \'mention-only\'');
    expect(source).toContain('responseMode.mode === \'ambient\'');
    expect(source).toContain('!msg.mentionedBot');
    expect(source).toContain('msg.chatType !== \'p2p\'');
  });
});

function msg(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'chat-1',
    chatType: 'group',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: true,
  } as unknown as NormalizedMessage;
}
