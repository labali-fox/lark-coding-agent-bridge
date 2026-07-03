import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';

export interface ChatHistoryMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
  chatType: string;
  senderId: string;
  content: string;
  mentionedBot: boolean;
  mentions: string[];
  createdAt: string;
  recordedAt: string;
}

export interface AppendHistoryOptions {
  now?: Date;
  retentionDays: number;
  maxMessages: number;
}

export interface TailHistoryOptions {
  chatId: string;
  threadId?: string;
  limit: number;
}

export interface SearchHistoryOptions {
  chatId: string;
  threadId?: string;
  query: string;
  limit: number;
}

export interface AroundHistoryOptions {
  chatId: string;
  messageId: string;
  before: number;
  after: number;
}

export function historyChatFilePath(rootDir: string, chatId: string): string {
  return join(rootDir, 'chats', `${encodePathSegment(chatId)}.jsonl`);
}

export class ChatHistoryStore {
  private readonly appendLocks = new Map<string, Promise<void>>();

  constructor(private readonly rootDir: string) {}

  async append(message: ChatHistoryMessage, options?: AppendHistoryOptions): Promise<void> {
    return this.withAppendLock(message.chatId, async () => {
      await this.appendUnlocked(message, options);
    });
  }

  private async appendUnlocked(message: ChatHistoryMessage, options?: AppendHistoryOptions): Promise<void> {
    const path = historyChatFilePath(this.rootDir, message.chatId);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(message)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options) {
      await this.prune(message.chatId, options);
    }
  }

  private async withAppendLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.appendLocks.get(chatId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);
    this.appendLocks.set(chatId, next);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.appendLocks.get(chatId) === next) {
        this.appendLocks.delete(chatId);
      }
    }
  }

  async tail(options: TailHistoryOptions): Promise<ChatHistoryMessage[]> {
    const messages = await this.readChat(options.chatId);
    return filterThread(messages, options.threadId).slice(-normalizeLimit(options.limit));
  }

  async search(options: SearchHistoryOptions): Promise<ChatHistoryMessage[]> {
    const needle = options.query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const messages = filterThread(await this.readChat(options.chatId), options.threadId);
    return messages
      .filter((message) => message.content.toLocaleLowerCase().includes(needle))
      .slice(-normalizeLimit(options.limit));
  }

  async around(options: AroundHistoryOptions): Promise<ChatHistoryMessage[]> {
    const messages = await this.readChat(options.chatId);
    return sliceAround(messages, options.messageId, options.before, options.after);
  }

  async readChat(chatId: string): Promise<ChatHistoryMessage[]> {
    const path = historyChatFilePath(this.rootDir, chatId);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return parseJsonl(text).filter(isChatHistoryMessage);
  }

  private async prune(chatId: string, options: AppendHistoryOptions): Promise<void> {
    const now = options.now ?? new Date();
    const cutoffMs = now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000;
    const path = historyChatFilePath(this.rootDir, chatId);
    const messages = (await this.readChat(chatId))
      .filter((message) => messageTime(message) >= cutoffMs)
      .slice(-options.maxMessages);
    await writeFileAtomic(path, messages.map((message) => JSON.stringify(message)).join('\n') + '\n', {
      mode: 0o600,
    });
  }

}

function filterThread(
  messages: ChatHistoryMessage[],
  threadId: string | undefined,
): ChatHistoryMessage[] {
  if (!threadId) return messages;
  return messages.filter((message) => message.threadId === threadId);
}

function sliceAround(
  messages: ChatHistoryMessage[],
  messageId: string,
  before: number,
  after: number,
): ChatHistoryMessage[] {
  const index = messages.findIndex((message) => message.messageId === messageId);
  if (index === -1) return [];
  const start = Math.max(0, index - Math.max(0, Math.floor(before)));
  const end = Math.min(messages.length, index + Math.max(0, Math.floor(after)) + 1);
  return messages.slice(start, end);
}

function parseJsonl(text: string): unknown[] {
  const values: unknown[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      continue;
    }
  }
  return values;
}

function isChatHistoryMessage(value: unknown): value is ChatHistoryMessage {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<ChatHistoryMessage>;
  return (
    typeof raw.messageId === 'string' &&
    typeof raw.chatId === 'string' &&
    typeof raw.chatType === 'string' &&
    typeof raw.senderId === 'string' &&
    typeof raw.content === 'string' &&
    typeof raw.mentionedBot === 'boolean' &&
    Array.isArray(raw.mentions) &&
    raw.mentions.every((mention) => typeof mention === 'string') &&
    typeof raw.createdAt === 'string' &&
    typeof raw.recordedAt === 'string'
  );
}

function messageTime(message: ChatHistoryMessage): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(500, Math.floor(limit));
}

function encodePathSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
