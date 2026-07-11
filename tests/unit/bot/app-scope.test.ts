import { describe, expect, it, vi } from 'vitest';
import { GROUP_MSG_SCOPE, hasGroupMsgScope } from '../../../src/bot/app-scope';

describe('app scope lookup', () => {
  it('reads granted scopes from the current v6 application API shape', async () => {
    const get = vi.fn(async () => ({
      data: {
        app: {
          scopes: [{ scope: GROUP_MSG_SCOPE }],
        },
      },
    }));

    await expect(hasGroupMsgScope(channelWithApplicationApi({ v6: { application: { get } } }), 'cli_app'))
      .resolves.toBe(true);
    expect(get).toHaveBeenCalledWith({
      params: { lang: 'zh_cn', user_id_type: 'open_id' },
      path: { app_id: 'cli_app' },
    });
  });

  it('falls back to the older application API shape', async () => {
    const get = vi.fn(async () => ({
      data: {
        app: {
          scopes: [{ scope: 'im:message.p2p_msg' }],
        },
      },
    }));

    await expect(hasGroupMsgScope(channelWithApplicationApi({ application: { get } }), 'cli_app'))
      .resolves.toBe(false);
  });

  it('returns unknown when the application API is unavailable', async () => {
    await expect(hasGroupMsgScope(channelWithApplicationApi(undefined), 'cli_app'))
      .resolves.toBeNull();
  });
});

function channelWithApplicationApi(application: unknown) {
  return {
    rawClient: {
      application,
    },
  } as never;
}
