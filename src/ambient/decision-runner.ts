import type { AgentEvent } from '../agent/types';
import type { AmbientLevel } from '../config/schema';

export interface AmbientDecisionMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
  senderId: string;
  content: string;
  createdAt: string;
}

export interface AmbientDecision {
  respond: boolean;
  reason: string;
}

export interface AmbientDecisionPromptInput {
  message: AmbientDecisionMessage;
  recentMessages: AmbientDecisionMessage[];
  level: AmbientLevel;
}

export interface RunAmbientDecisionInput extends AmbientDecisionPromptInput {
  startRun: (prompt: string) => AmbientDecisionRun | Promise<AmbientDecisionRun>;
  timeoutMs?: number;
}

export interface AmbientDecisionRun {
  events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export async function runAmbientDecision(input: RunAmbientDecisionInput): Promise<AmbientDecision> {
  let run: AmbientDecisionRun;
  try {
    run = await input.startRun(buildAmbientDecisionPrompt(input));
  } catch (err) {
    return { respond: false, reason: `runner-error:${String((err as Error).message ?? err)}` };
  }
  const consume = (async (): Promise<AmbientDecision> => {
    let output = '';
    for await (const event of run.events) {
      if (event.type === 'text' || event.type === 'thinking') {
        output += event.delta;
      }
      if (event.type === 'error') {
        return { respond: false, reason: `agent-error:${event.message}` };
      }
    }
    return parseAmbientDecision(output);
  })().catch((err: unknown) => ({
    respond: false,
    reason: `runner-error:${String((err as Error).message ?? err)}`,
  }));

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<AmbientDecision>((resolve) => {
    timer = setTimeout(() => {
      void Promise.resolve(run.stop()).catch(() => {});
      resolve({ respond: false, reason: 'timeout' });
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([consume, timeout]);
  } catch (err) {
    return { respond: false, reason: `runner-error:${String((err as Error).message ?? err)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildAmbientDecisionPrompt(input: AmbientDecisionPromptInput): string {
  return [
    'You decide whether a chat bot should participate in an unmentioned group chat message.',
    'Return JSON only. The JSON schema is {"respond": boolean, "reason": string}.',
    'respond=true only when the bot can add useful, timely value without being directly mentioned.',
    'respond=false for small talk, acknowledgements, jokes, private human discussion, or uncertainty.',
    '',
    JSON.stringify({
      ambientLevel: input.level,
      currentMessage: serializeMessage(input.message),
      recentMessages: input.recentMessages.slice(-20).map(serializeMessage),
    }, null, 2),
  ].join('\n');
}

export function parseAmbientDecision(output: string): AmbientDecision {
  const parsed = parseJsonObject(output);
  if (!parsed) return { respond: false, reason: 'invalid-decision' };
  const respond = (parsed as { respond?: unknown }).respond;
  const reason = (parsed as { reason?: unknown }).reason;
  if (typeof respond !== 'boolean') return { respond: false, reason: 'invalid-decision' };
  return {
    respond,
    reason: typeof reason === 'string' && reason.trim() ? reason.trim() : 'no-reason',
  };
}

function serializeMessage(message: AmbientDecisionMessage): Record<string, string | undefined> {
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    threadId: message.threadId,
    senderId: message.senderId,
    createdAt: message.createdAt,
    content: message.content,
  };
}

function parseJsonObject(output: string): unknown | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
}
