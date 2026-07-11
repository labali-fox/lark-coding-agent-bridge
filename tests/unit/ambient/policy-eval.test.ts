import { describe, expect, it } from 'vitest';
import { ambientPrefilter } from '../../../src/ambient/policy';
import type { AmbientLevel } from '../../../src/config/schema';

interface EvalCase {
  name: string;
  content: string;
  expected: Record<AmbientLevel, boolean>;
}

const evalCases: EvalCase[] = [
  {
    name: 'emoji noise stays silent at every level',
    content: '👍',
    expected: { quiet: false, balanced: false, active: false },
  },
  {
    name: 'short acknowledgement stays silent at every level',
    content: '好的',
    expected: { quiet: false, balanced: false, active: false },
  },
  {
    name: 'direct assistant request passes every level',
    content: '让 bot 帮忙总结一下上面的讨论',
    expected: { quiet: true, balanced: true, active: true },
  },
  {
    name: 'technical question passes every level',
    content: '这个 TypeScript 报错怎么修？',
    expected: { quiet: true, balanced: true, active: true },
  },
  {
    name: 'general substantial discussion is active-only',
    content: '我倾向先把上下文记录下来，再安排后续整理',
    expected: { quiet: false, balanced: false, active: true },
  },
  {
    name: 'casual short question stays silent at every level',
    content: '今晚大家准备一起吃什么？',
    expected: { quiet: false, balanced: false, active: false },
  },
];

describe('ambient participation eval set', () => {
  it.each(evalCases)('$name', ({ content, expected }) => {
    for (const level of ['quiet', 'balanced', 'active'] as const) {
      expect(ambientPrefilter({ content, mentionedBot: false }, level).pass).toBe(expected[level]);
    }
  });

  it('keeps active mode meaningfully more permissive than balanced', () => {
    const activeOnly = evalCases.filter(
      ({ content }) =>
        !ambientPrefilter({ content, mentionedBot: false }, 'balanced').pass &&
        ambientPrefilter({ content, mentionedBot: false }, 'active').pass,
    );

    expect(activeOnly.map((item) => item.name)).toEqual([
      'general substantial discussion is active-only',
    ]);
  });
});
