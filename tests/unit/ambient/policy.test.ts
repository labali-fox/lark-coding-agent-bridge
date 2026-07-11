import { describe, expect, it } from 'vitest';
import {
  ambientPrefilter,
  isSlashCommand,
  shouldBypassAmbientDecision,
  type AmbientPrefilterMessage,
} from '../../../src/ambient/policy';

describe('ambient policy helpers', () => {
  it('bypasses ambient model decisions for mentions and slash commands', () => {
    expect(shouldBypassAmbientDecision(message({ mentionedBot: true }))).toBe(true);
    expect(shouldBypassAmbientDecision(message({ content: '/status' }))).toBe(true);
    expect(shouldBypassAmbientDecision(message({ content: ' /status' }))).toBe(true);
    expect(shouldBypassAmbientDecision(message({ content: '普通消息' }))).toBe(false);
  });

  it('detects slash commands only at the start of trimmed content', () => {
    expect(isSlashCommand('/invite group ambient')).toBe(true);
    expect(isSlashCommand(' /invite group ambient')).toBe(true);
    expect(isSlashCommand('讨论 /invite group ambient')).toBe(false);
  });

  it('quiet mode only passes direct assistant or technical help requests', () => {
    expect(ambientPrefilter(message({ content: '这个 TypeScript 报错怎么修？' }), 'quiet')).toMatchObject({
      pass: true,
      action: 'accept',
      reason: 'technical-help',
    });
    expect(ambientPrefilter(message({ content: '让 bot 帮忙总结一下上面讨论' }), 'quiet')).toMatchObject({
      pass: true,
      action: 'accept',
      reason: 'assistant-request',
    });
    expect(ambientPrefilter(message({ content: '今晚吃什么' }), 'quiet')).toMatchObject({
      pass: false,
      action: 'reject',
    });
  });

  it('balanced mode accepts clear technical context but sends project questions to AI', () => {
    expect(ambientPrefilter(message({ content: '这个接口是不是应该改成分页？' }), 'balanced')).toMatchObject({
      pass: true,
      action: 'accept',
    });
    expect(ambientPrefilter(message({ content: 'npm install 一直 502' }), 'balanced')).toMatchObject({
      pass: true,
      action: 'accept',
    });
    expect(ambientPrefilter(message({ content: '这个方案是不是要先拆边界再推进？' }), 'balanced')).toMatchObject({
      pass: true,
      action: 'decide',
    });
    expect(ambientPrefilter(message({ content: '好的' }), 'balanced')).toMatchObject({
      pass: false,
      action: 'reject',
    });
  });

  it('active mode asks AI for substantial project discussion but can fail open on timeout', () => {
    expect(ambientPrefilter(message({ content: '我觉得这里可以先记录群消息，然后再判断是否回复' }), 'active')).toMatchObject({
      pass: true,
      action: 'decide',
      failOpenOnTimeout: true,
    });
    expect(ambientPrefilter(message({ content: '👍' }), 'active')).toMatchObject({
      pass: false,
      action: 'reject',
    });
    expect(ambientPrefilter(message({ content: '今晚大家准备一起吃什么？' }), 'active')).toMatchObject({
      pass: false,
      action: 'reject',
    });
  });
});

function message(overrides: Partial<AmbientPrefilterMessage>): AmbientPrefilterMessage {
  return {
    content: '',
    mentionedBot: false,
    ...overrides,
  };
}
