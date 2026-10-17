/** An exact control response, never a keyword to search for inside an answer. */
export const AMBIENT_NO_REPLY = '[[NO_REPLY]]';

/**
 * Suppress only an entire opt-out response. A commit title, quote, or useful
 * answer can contain the same words without expressing the bot's intent.
 */
export function isAmbientNonParticipation(body: string): boolean {
  const text = body.trim();
  if (!text || text === AMBIENT_NO_REPLY) return true;

  // Support older resumed sessions that still emit short Chinese opt-outs.
  // Keep quotes and Markdown intact so quoted phrases remain ordinary content.
  const clauses = text.split(/[，,。.!！?？;；\n]+/u)
    .map((clause) => clause.replace(/\s+/gu, '').toLowerCase())
    .filter(Boolean);
  return clauses.length > 0 && clauses.every((clause) =>
    LEGACY_OPT_OUT_CLAUSES.some((pattern) => pattern.test(clause)),
  );
}

const LEGACY_OPT_OUT_CLAUSES = [
  /^(?:这(?:条消息|个话题|段对话)?)?(?:不关我事|跟我无关|与我无关|和我无关)$/u,
  /^(?:不需要|无需|不用)(?:我|机器人|bot|ai|agent)?(?:回复|参与|介入|处理|回答)$/u,
  /^没有(?:需要|必要)(?:我|机器人|bot|ai|agent)?(?:回复|参与|介入|处理|回答)$/u,
  /^(?:我|机器人|bot|ai|agent)?(?:不|无需|不用)(?:参与|介入|插话)$/u,
  /^(?:不予|不做|不进行)(?:回复|回应|回答)$/u,
] as const;
