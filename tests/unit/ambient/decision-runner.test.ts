import { describe, expect, it, vi } from 'vitest';
import {
  buildAmbientDecisionPrompt,
  runAmbientDecision,
  type AmbientDecisionMessage,
} from '../../../src/ambient/decision-runner';
import type { AgentEvent } from '../../../src/agent/types';

describe('ambient decision runner', () => {
  it('parses a positive JSON decision from agent text', async () => {
    const run = fakeRun([
      { type: 'text', delta: '{"respond":true,"reason":"can answer"}' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    await expect(runAmbientDecision({
      startRun: () => run,
      message: message({ content: '这个怎么修？' }),
      recentMessages: [],
      level: 'balanced',
      timeoutMs: 1000,
    })).resolves.toEqual({ respond: true, reason: 'can answer' });
  });

  it('returns no-response for invalid agent output', async () => {
    const run = fakeRun([
      { type: 'text', delta: 'I would answer' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    await expect(runAmbientDecision({
      startRun: () => run,
      message: message({ content: 'hello' }),
      recentMessages: [],
      level: 'balanced',
      timeoutMs: 1000,
    })).resolves.toMatchObject({ respond: false, reason: 'invalid-decision' });
  });

  it('stops the run and returns no-response on timeout', async () => {
    const stop = vi.fn();
    const run = fakeRun(hangingEvents(), stop);

    await expect(runAmbientDecision({
      startRun: () => run,
      message: message({ content: 'hello' }),
      recentMessages: [],
      level: 'balanced',
      timeoutMs: 5,
    })).resolves.toMatchObject({ respond: false, reason: 'timeout' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('builds a prompt with current and recent messages', () => {
    const prompt = buildAmbientDecisionPrompt({
      message: message({ senderId: 'ou_a', content: '现在要不要回复？' }),
      recentMessages: [
        message({ senderId: 'ou_b', content: '前面上下文' }),
      ],
      level: 'quiet',
    });

    expect(prompt).toContain('"ambientLevel": "quiet"');
    expect(prompt).toContain('现在要不要回复');
    expect(prompt).toContain('前面上下文');
    expect(prompt).toContain('"respond"');
  });
});

function fakeRun(events: AgentEvent[] | AsyncIterable<AgentEvent>, stop = vi.fn()) {
  return {
    events: Array.isArray(events) ? arrayEvents(events) : events,
    stop,
  };
}

async function* arrayEvents(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}

async function* hangingEvents(): AsyncIterable<AgentEvent> {
  await new Promise(() => {});
}

function message(overrides: Partial<AmbientDecisionMessage>): AmbientDecisionMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    threadId: undefined,
    senderId: 'ou_sender',
    content: '',
    createdAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}
