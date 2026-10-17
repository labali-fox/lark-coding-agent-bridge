import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

/** Check fresh membership: adding a person or another bot changes the audience. */
export async function isUserBotPair(channel: LarkChannel, chatId: string): Promise<boolean> {
  // Some channel implementations cannot expose member counts. Unknown membership
  // must not turn a shared group into a direct conversation.
  if (typeof channel.rawClient.im?.v1?.chat?.get !== 'function') return false;
  try {
    const result = await channel.rawClient.im.v1.chat.get({ path: { chat_id: chatId } });
    if (result.code && result.code !== 0) return false;
    return Number(result.data?.user_count) === 1 && Number(result.data?.bot_count) === 1;
  } catch (err) {
    log.warn('chat', 'member-counts-unavailable', {
      chatId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
