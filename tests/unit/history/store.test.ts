import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChatHistoryStore,
  historyChatFilePath,
  type ChatHistoryMessage,
} from '../../../src/history/store';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-history-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ChatHistoryStore', () => {
  it('appends chat messages as JSONL under a path-safe chat file', async () => {
    const root = await tempRoot();
    const store = new ChatHistoryStore(root);

    await store.append(message({ messageId: 'om_1', chatId: 'oc/group:1', content: 'hello' }));

    const path = historyChatFilePath(root, 'oc/group:1');
    expect(path).toContain(join(root, 'chats'));
    expect(path).not.toContain('oc/group:1');
    expect(await readFile(path, 'utf8')).toBe(
      `${JSON.stringify(message({ messageId: 'om_1', chatId: 'oc/group:1', content: 'hello' }))}\n`,
    );
  });

  it('tails messages by chat and optional thread', async () => {
    const root = await tempRoot();
    const store = new ChatHistoryStore(root);

    await store.append(message({ messageId: 'om_1', content: 'one' }));
    await store.append(message({ messageId: 'om_2', threadId: 'omt_1', content: 'two' }));
    await store.append(message({ messageId: 'om_3', threadId: 'omt_1', content: 'three' }));

    await expect(store.tail({ chatId: 'oc_1', limit: 2 })).resolves.toEqual([
      message({ messageId: 'om_2', threadId: 'omt_1', content: 'two' }),
      message({ messageId: 'om_3', threadId: 'omt_1', content: 'three' }),
    ]);
    await expect(store.tail({ chatId: 'oc_1', threadId: 'omt_1', limit: 1 })).resolves.toEqual([
      message({ messageId: 'om_3', threadId: 'omt_1', content: 'three' }),
    ]);
  });

  it('searches case-insensitively within a chat', async () => {
    const root = await tempRoot();
    const store = new ChatHistoryStore(root);

    await store.append(message({ messageId: 'om_1', content: 'Alpha note' }));
    await store.append(message({ messageId: 'om_2', content: 'beta note' }));
    await store.append(message({ messageId: 'om_3', content: 'another ALPHA' }));

    await expect(store.search({ chatId: 'oc_1', query: 'alpha', limit: 10 })).resolves.toEqual([
      message({ messageId: 'om_1', content: 'Alpha note' }),
      message({ messageId: 'om_3', content: 'another ALPHA' }),
    ]);
  });

  it('returns context around a message id', async () => {
    const root = await tempRoot();
    const store = new ChatHistoryStore(root);

    await store.append(message({ messageId: 'om_1', content: 'one' }));
    await store.append(message({ messageId: 'om_2', content: 'two' }));
    await store.append(message({ messageId: 'om_3', content: 'three' }));
    await store.append(message({ messageId: 'om_4', content: 'four' }));

    await expect(store.around({ chatId: 'oc_1', messageId: 'om_3', before: 1, after: 1 })).resolves.toEqual([
      message({ messageId: 'om_2', content: 'two' }),
      message({ messageId: 'om_3', content: 'three' }),
      message({ messageId: 'om_4', content: 'four' }),
    ]);
  });

  it('prunes old and excessive messages after append', async () => {
    const root = await tempRoot();
    const store = new ChatHistoryStore(root);

    await store.append(message({ messageId: 'old', createdAt: '2026-05-01T00:00:00.000Z' }), {
      now: new Date('2026-07-02T00:00:00.000Z'),
      retentionDays: 30,
      maxMessages: 2,
    });
    await store.append(message({ messageId: 'one', createdAt: '2026-07-01T00:00:00.000Z' }), {
      now: new Date('2026-07-02T00:00:00.000Z'),
      retentionDays: 30,
      maxMessages: 2,
    });
    await store.append(message({ messageId: 'two', createdAt: '2026-07-01T00:01:00.000Z' }), {
      now: new Date('2026-07-02T00:00:00.000Z'),
      retentionDays: 30,
      maxMessages: 2,
    });
    await store.append(message({ messageId: 'three', createdAt: '2026-07-01T00:02:00.000Z' }), {
      now: new Date('2026-07-02T00:00:00.000Z'),
      retentionDays: 30,
      maxMessages: 2,
    });

    await expect(store.tail({ chatId: 'oc_1', limit: 10 })).resolves.toEqual([
      message({ messageId: 'two', createdAt: '2026-07-01T00:01:00.000Z' }),
      message({ messageId: 'three', createdAt: '2026-07-01T00:02:00.000Z' }),
    ]);
  });

  it('serializes concurrent append and prune operations for the same chat', async () => {
    const root = await tempRoot();
    const store = new ChatHistoryStore(root);

    await Promise.all(
      Array.from({ length: 40 }, (_, index) => store.append(
        message({
          messageId: `om_${index}`,
          createdAt: `2026-07-01T00:${String(index).padStart(2, '0')}:00.000Z`,
        }),
        {
          now: new Date('2026-07-02T00:00:00.000Z'),
          retentionDays: 30,
          maxMessages: 100,
        },
      )),
    );

    const messages = await store.tail({ chatId: 'oc_1', limit: 100 });
    expect(messages).toHaveLength(40);
    expect(new Set(messages.map((entry) => entry.messageId)).size).toBe(40);
  });

  it('skips malformed JSONL rows while reading', async () => {
    const root = await tempRoot();
    const path = historyChatFilePath(root, 'oc_1');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `not json\n${JSON.stringify(message({ messageId: 'om_1' }))}\n`, 'utf8');

    const store = new ChatHistoryStore(root);

    await expect(store.tail({ chatId: 'oc_1', limit: 10 })).resolves.toEqual([
      message({ messageId: 'om_1' }),
    ]);
  });
});

function message(overrides: Partial<ChatHistoryMessage>): ChatHistoryMessage {
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
