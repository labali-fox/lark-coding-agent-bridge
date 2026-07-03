import { stat } from 'node:fs/promises';
import { resolveAppPaths } from '../../config/app-paths';
import { paths } from '../../config/paths';
import { loadRootConfig, readActiveProfile, runtimeProfileConfig } from '../../config/profile-store';
import { getChatHistoryPolicy } from '../../config/schema';
import {
  ChatHistoryStore,
  historyChatFilePath,
  type ChatHistoryMessage,
} from '../../history/store';

export interface HistoryCommandOptions {
  rootDir?: string;
  profile?: string;
}

export interface HistoryTailOptions extends HistoryCommandOptions {
  chat: string;
  thread?: string;
  limit?: string | number;
}

export interface HistorySearchOptions extends HistoryCommandOptions {
  chat: string;
  thread?: string;
  query: string;
  limit?: string | number;
}

export interface HistoryAroundOptions extends HistoryCommandOptions {
  chat: string;
  message: string;
  before?: string | number;
  after?: string | number;
}

export interface HistoryStatusOptions extends HistoryCommandOptions {
  chat: string;
}

export async function runHistoryTail(opts: HistoryTailOptions): Promise<void> {
  const store = await historyStoreForChat(opts, opts.chat);
  printMessages(await store.tail({
    chatId: opts.chat,
    threadId: opts.thread,
    limit: parseIntegerOption(opts.limit, 50),
  }));
}

export async function runHistorySearch(opts: HistorySearchOptions): Promise<void> {
  const store = await historyStoreForChat(opts, opts.chat);
  printMessages(await store.search({
    chatId: opts.chat,
    threadId: opts.thread,
    query: opts.query,
    limit: parseIntegerOption(opts.limit, 20),
  }));
}

export async function runHistoryAround(opts: HistoryAroundOptions): Promise<void> {
  const store = await historyStoreForChat(opts, opts.chat);
  printMessages(await store.around({
    chatId: opts.chat,
    messageId: opts.message,
    before: parseIntegerOption(opts.before, 30),
    after: parseIntegerOption(opts.after, 10),
  }));
}

export async function runHistoryStatus(opts: HistoryStatusOptions): Promise<void> {
  const { appPaths, cfg, profile, rootDir } = await resolveHistoryContext(opts);
  const policy = getChatHistoryPolicy(cfg, opts.chat);
  const store = new ChatHistoryStore(appPaths.historyDir);
  const filePath = historyChatFilePath(appPaths.historyDir, opts.chat);
  const messages = await store.readChat(opts.chat);
  const file = await stat(filePath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  });
  const latest = messages.at(-1);
  console.log(JSON.stringify({
    rootDir,
    profile,
    chat: opts.chat,
    enabled: policy.enabled,
    retentionDays: policy.retentionDays,
    maxMessages: policy.maxMessages,
    historyDir: appPaths.historyDir,
    filePath,
    fileExists: Boolean(file),
    fileBytes: file?.size ?? 0,
    messageCount: messages.length,
    latestMessageId: latest?.messageId,
    latestCreatedAt: latest?.createdAt,
    latestRecordedAt: latest?.recordedAt,
  }, null, 2));
}

async function historyStoreForChat(opts: HistoryCommandOptions, chatId: string): Promise<ChatHistoryStore> {
  const { appPaths, cfg } = await resolveHistoryContext(opts);
  if (!getChatHistoryPolicy(cfg, chatId).enabled) {
    throw new Error(
      `history is not enabled for chat ${chatId}; ask an admin to run /invite group history on first`,
    );
  }
  return new ChatHistoryStore(appPaths.historyDir);
}

async function resolveHistoryContext(opts: HistoryCommandOptions) {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const rootPaths = resolveAppPaths({ rootDir });
  const root = await loadRootConfig(rootPaths.configFile);
  if (!root) {
    throw new Error('history requires a v2 profile config; run lark-channel-bridge migrate or profile create first');
  }
  const profile = opts.profile ?? await readActiveProfile(rootDir) ?? root.activeProfile ?? rootPaths.profile;
  const cfg = runtimeProfileConfig(root, profile);
  return {
    appPaths: resolveAppPaths({ rootDir, profile }),
    cfg,
    profile,
    rootDir,
  };
}

function printMessages(messages: ChatHistoryMessage[]): void {
  console.log(JSON.stringify(messages, null, 2));
}

function parseIntegerOption(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
