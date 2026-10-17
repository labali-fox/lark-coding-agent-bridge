import { describe, expect, it } from 'vitest';
import { AMBIENT_NO_REPLY, isAmbientNonParticipation } from '../../../src/ambient/auto-reply';

describe('ambient whole-response opt-out detection', () => {
  it.each([
    '',
    ' \n\t ',
    AMBIENT_NO_REPLY,
    ` \n${AMBIENT_NO_REPLY}\n `,
    '这跟我无关，不需要回复。',
    '这条消息与我无关。\n我不参与。',
    '不关我事',
    '和我无关。',
    '无需回答',
    '不需要机器人回复。',
    '不用 BOT 参与！',
    '没有必要介入。',
    '没有需要我处理。',
    '不予回应。',
    '不做回复。',
    '不进行回答。',
  ])('suppresses a complete opt-out: %j', (body) => {
    expect(isAmbientNonParticipation(body)).toBe(true);
  });

  it.each([
    '- `fix(interview)`: 主持误判无需回答时在同轮纠正一次',
    '主持误判无需回答时在同轮纠正一次',
    '无需回答这个问题，先确认数据库连接。',
    '这跟我无关，但可以先排查 DNS。',
    '不需要回复。建议先检查服务日志。',
    '我不参与发布，但我可以帮你检查构建结果。',
    '“无需回答”',
    '> 不需要回复。',
    '`无需回答`',
    '```text\n不需要回复\n```',
    '## 不需要回复\n这是旧版规则的错误行为。',
    `说明：${AMBIENT_NO_REPLY} 是静默标记。`,
    `${AMBIENT_NO_REPLY}\n今天完成了笔录批量下载。`,
    '今天完成了笔录批量下载。',
    '……',
  ])('preserves useful answers, quotations, and ambiguous content: %j', (body) => {
    expect(isAmbientNonParticipation(body)).toBe(false);
  });
});
