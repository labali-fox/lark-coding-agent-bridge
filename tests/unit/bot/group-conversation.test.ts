import type { LarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { isUserBotPair } from '../../../src/bot/group-conversation';

function source(get = vi.fn(async () => ({ data: { user_count: '1', bot_count: '1' } }))) {
  return { channel: { rawClient: { im: { v1: { chat: { get } } } } } as unknown as LarkChannel, get };
}

describe('one-user one-bot group detection', () => {
  it('uses separate human and bot counts from the current chat metadata', async () => {
    const { channel, get } = source();
    await expect(isUserBotPair(channel, 'oc_chat')).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith({ path: { chat_id: 'oc_chat' } });
  });

  it.each([
    { user_count: '2', bot_count: '1' },
    { user_count: '1', bot_count: '2' },
    { user_count: '0', bot_count: '1' },
    { user_count: '1', bot_count: '0' },
    { user_count: '1' },
    { bot_count: '1' },
    { user_count: 'unknown', bot_count: '1' },
    {},
  ])('does not infer a direct conversation from %j', async (data) => {
    const { channel } = source(vi.fn().mockResolvedValue({ data }));
    await expect(isUserBotPair(channel, 'oc_chat')).resolves.toBe(false);
  });

  it('does not reuse a positive result after membership changes', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ data: { user_count: '1', bot_count: '1' } })
      .mockResolvedValueOnce({ data: { user_count: '2', bot_count: '1' } });
    const { channel } = source(get);
    await expect(isUserBotPair(channel, 'oc_chat')).resolves.toBe(true);
    await expect(isUserBotPair(channel, 'oc_chat')).resolves.toBe(false);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('preserves the configured policy when the API fails, then retries next time', async () => {
    const get = vi.fn()
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce({ data: { user_count: '1', bot_count: '1' } });
    const { channel } = source(get);
    await expect(isUserBotPair(channel, 'oc_chat')).resolves.toBe(false);
    await expect(isUserBotPair(channel, 'oc_chat')).resolves.toBe(true);
  });

  it('does not trust counts returned with an API error code', async () => {
    const { channel } = source(vi.fn().mockResolvedValue({
      code: 99991672, data: { user_count: '1', bot_count: '1' },
    }));
    await expect(isUserBotPair(channel, 'oc_chat')).resolves.toBe(false);
  });

  it('supports channel implementations without group metadata', async () => {
    const channel = { rawClient: { im: { v1: {} } } } as unknown as LarkChannel;
    await expect(isUserBotPair(channel, 'oc_chat')).resolves.toBe(false);
  });
});
