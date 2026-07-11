import type { AmbientLevel } from '../config/schema';

export interface AmbientPrefilterMessage {
  content: string;
  mentionedBot: boolean;
}

export interface AmbientPrefilterResult {
  pass: boolean;
  action: 'accept' | 'reject' | 'decide';
  reason: string;
  failOpenOnTimeout?: boolean;
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
  '部署',
  '发布',
  '验证',
  '超时',
  'timeout',
  'stream',
  'cardkit',
  'feishu',
  'lark',
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
  '怎么修',
  '帮我',
  '帮看',
];

const PROJECT_DISCUSSION_HINTS = [
  '方案',
  '风险',
  '下一步',
  '后续',
  '推进',
  '边界',
  '流程',
  '交付',
  '上线',
  '排期',
  '整理',
  '上下文',
];

const SMALLTALK_HINTS = [
  '吃什么',
  '喝什么',
  '晚饭',
  '午饭',
  '夜宵',
  '周末',
  '哈哈',
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
  if (!content) return reject('empty');
  if (isNoise(content)) return reject('noise');
  if (isShortAcknowledgement(content)) return reject('ack');
  if (containsAny(content, SMALLTALK_HINTS)) return reject('smalltalk');

  const question = looksLikeQuestion(content);
  const technical = containsAny(content, TECHNICAL_HINTS);
  const assistant = containsAny(content, ASSISTANT_HINTS);
  const projectDiscussion = containsAny(content, PROJECT_DISCUSSION_HINTS);

  if (level === 'quiet') {
    if (question && technical) return accept('technical-help');
    if (assistant) return accept('assistant-request');
    return reject('quiet-filter');
  }

  if (technical) return accept('technical-help');
  if (assistant) return accept('assistant-request');

  if (level === 'active') {
    if (projectDiscussion || content.length >= 16) {
      return decide('active-substantial', { failOpenOnTimeout: true });
    }
    return reject('too-short');
  }

  if (question) return decide('balanced-candidate');
  return reject('balanced-filter');
}

function accept(reason: string): AmbientPrefilterResult {
  return { pass: true, action: 'accept', reason };
}

function reject(reason: string): AmbientPrefilterResult {
  return { pass: false, action: 'reject', reason };
}

function decide(
  reason: string,
  options: Pick<AmbientPrefilterResult, 'failOpenOnTimeout'> = {},
): AmbientPrefilterResult {
  return {
    pass: true,
    action: 'decide',
    reason,
    ...(options.failOpenOnTimeout ? { failOpenOnTimeout: true } : {}),
  };
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
