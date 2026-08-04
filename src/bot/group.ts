import type { LarkChannel } from '@larksuite/channel';

export interface CreateBoundChatOptions {
  channel: LarkChannel;
  name: string;
  inviteOpenId: string;
  description?: string;
}

export interface CreatedChat {
  chatId: string;
  name: string;
}

/**
 * Create a private group chat owned by the requesting user. The bot stays in
 * the group as the app participant; bridge access is persisted by the caller.
 */
export async function createBoundChat(opts: CreateBoundChatOptions): Promise<CreatedChat> {
  const { channel, name, inviteOpenId, description } = opts;
  const result = await channel.rawClient.im.v1.chat.create({
    params: { user_id_type: 'open_id', set_bot_manager: true },
    data: {
      name,
      description,
      chat_mode: 'group',
      chat_type: 'private',
      owner_id: inviteOpenId,
      user_id_list: [inviteOpenId],
    },
  }) as { data?: { chat_id?: string } };
  const chatId = result.data?.chat_id;
  if (!chatId) throw new Error('im.v1.chat.create returned no chat_id');
  return { chatId, name };
}

export function defaultChatName(agentName = 'Agent'): string {
  const d = new Date();
  const pad = (n: number): string => `${n}`.padStart(2, '0');
  return `${agentName} · ${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
