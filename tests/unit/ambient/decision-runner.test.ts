import { describe, expect, it, vi } from 'vitest';
import {
  AMBIENT_DECISION_TIMEOUT_MS,
  DEFAULT_AMBIENT_DECISION_TIMEOUT_MS,
  ambientDecisionTimeoutMs,
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
    })).resolves.toMatchObject({ respond: false, reason: 'timeout:balanced:5ms' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('uses level-specific production defaults long enough for real agent startup latency', async () => {
    expect(AMBIENT_DECISION_TIMEOUT_MS).toEqual({
      quiet: 30_000,
      balanced: 45_000,
      active: 60_000,
    });
    expect(DEFAULT_AMBIENT_DECISION_TIMEOUT_MS).toBe(45_000);
    expect(ambientDecisionTimeoutMs('quiet')).toBe(30_000);
    expect(ambientDecisionTimeoutMs('balanced')).toBe(45_000);
    expect(ambientDecisionTimeoutMs('active')).toBe(60_000);
  });

  it('applies the active-mode default timeout when no explicit timeout is provided', async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn();
      const decision = runAmbientDecision({
        startRun: () => fakeRun(hangingEvents(), stop),
        message: message({ content: '这个 TypeScript 报错怎么修？' }),
        recentMessages: [],
        level: 'active',
      });

      await vi.advanceTimersByTimeAsync(AMBIENT_DECISION_TIMEOUT_MS.active - 1);
      expect(stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(decision).resolves.toMatchObject({ respond: false, reason: 'timeout:active:60000ms' });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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

  it('builds a prompt that defines quiet, balanced, and active decision strength', () => {
    const prompt = buildAmbientDecisionPrompt({
      message: message({ content: '我觉得这里可以先记录群消息，然后再判断是否回复' }),
      recentMessages: [],
      level: 'active',
    });

    expect(prompt).toContain('quiet');
    expect(prompt).toContain('balanced');
    expect(prompt).toContain('active');
    expect(prompt).toContain('active: lean toward respond=true');
    expect(prompt).toContain('substantial technical, product, project, or planning discussion');
    expect(prompt).toContain('small talk, acknowledgements, jokes, private human discussion');
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
