import type { AmbientLevel } from '../config/schema';

export interface AmbientPrefilterMessage {
  content: string;
  mentionedBot: boolean;
}

export interface AmbientPrefilterResult {
  pass: boolean;
  reason: string;
}

const SHORT_ACK = new Set([
  'ok',
  'okay',
  'yes',
  'no',
  '好',
  '好的',
  '收到',
  '可以',
  '嗯',
  '是的',
  '不是',
]);

const TECHNICAL_HINTS = [
  'api',
  'bug',
  'cli',
  'codex',
  'claude',
  'error',
  'exception',
  'github',
  'http',
  'json',
  'mcp',
  'npm',
  'pnpm',
  'typescript',
  '报错',
  '代码',
  '接口',
  '权限',
  '测试',
  '脚本',
  '配置',
];

const ASSISTANT_HINTS = [
  'ai',
  'bot',
  'claude',
  'codex',
  'agent',
  '帮忙',
  '总结',
  '分析',
  '看看',
  '怎么做',
];

export function shouldBypassAmbientDecision(message: AmbientPrefilterMessage): boolean {
  return message.mentionedBot || isSlashCommand(message.content);
}

export function isSlashCommand(content: string): boolean {
  return content.trimStart().startsWith('/');
}

export function ambientPrefilter(
  message: AmbientPrefilterMessage,
  level: AmbientLevel,
): AmbientPrefilterResult {
  const content = normalizeContent(message.content);
  if (!content) return { pass: false, reason: 'empty' };
  if (isNoise(content)) return { pass: false, reason: 'noise' };
  if (isShortAcknowledgement(content)) return { pass: false, reason: 'ack' };

  const question = looksLikeQuestion(content);
  const technical = containsAny(content, TECHNICAL_HINTS);
  const assistant = containsAny(content, ASSISTANT_HINTS);

  if (level === 'quiet') {
    if ((question && technical) || assistant) return { pass: true, reason: 'direct-help' };
    return { pass: false, reason: 'quiet-filter' };
  }

  if (level === 'active') {
    if (content.length >= 8) return { pass: true, reason: 'substantial' };
    return { pass: false, reason: 'too-short' };
  }

  if (question || technical || assistant) return { pass: true, reason: 'balanced-candidate' };
  return { pass: false, reason: 'balanced-filter' };
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function looksLikeQuestion(content: string): boolean {
  return /[?？]$/.test(content) || /(?:怎么|如何|为啥|为什么|是否|是不是|能不能|可不可以)/.test(content);
}

function containsAny(content: string, hints: string[]): boolean {
  const lower = content.toLocaleLowerCase();
  return hints.some((hint) => lower.includes(hint));
}

function isShortAcknowledgement(content: string): boolean {
  const lower = content.toLocaleLowerCase();
  return SHORT_ACK.has(lower);
}

function isNoise(content: string): boolean {
  if (content.length > 6) return false;
  return !/[\p{Letter}\p{Number}]/u.test(content);
}
