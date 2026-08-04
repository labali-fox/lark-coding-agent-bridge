#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv) {
  const args = { profile: undefined, chat: undefined, owner: undefined, yes: false, list: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--yes') args.yes = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--profile') args.profile = argv[++i];
    else if (arg === '--chat') args.chat = argv[++i];
    else if (arg === '--owner') args.owner = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function loadConfig() {
  const file = join(homedir(), '.lark-channel', 'config.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function resolveSecret(cfg, secret) {
  if (typeof secret === 'string') return secret;
  if (!secret || typeof secret !== 'object') throw new Error('unsupported app secret config');
  const providerKey = secret.provider || secret.source;
  const provider = cfg.secrets?.providers?.[providerKey];
  if (!provider?.command) throw new Error(`secret provider not found: ${providerKey}`);
  const input = JSON.stringify({ protocolVersion: 1, provider: providerKey, ids: [secret.id] });
  const output = execFileSync(provider.command, { input, encoding: 'utf8' });
  const parsed = JSON.parse(output);
  const value = parsed.values?.[secret.id];
  if (!value) throw new Error(`secret not resolved: ${secret.id}`);
  return value;
}

async function feishuApi(path, token, init = {}) {
  const res = await fetch(`https://open.feishu.cn${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      ...(init.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) {
    throw new Error(`${json.code ?? res.status}: ${json.msg ?? res.statusText}`);
  }
  return json;
}

async function tenantToken(appId, appSecret) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new Error(`tenant token failed: ${json.code}: ${json.msg}`);
  return json.tenant_access_token;
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const profileName = args.profile || cfg.activeProfile || 'claude';
  const profile = cfg.profiles?.[profileName];
  if (!profile) throw new Error(`profile not found: ${profileName}`);
  const app = profile.accounts?.app;
  if (!app?.id || !app?.secret) throw new Error(`profile ${profileName} has no app credentials`);
  const token = await tenantToken(app.id, resolveSecret(cfg, app.secret));

  if (args.list) {
    const json = await feishuApi('/open-apis/im/v1/chats?page_size=50', token);
    const chats = (json.data?.items || []).map((chat) => ({
      chat_id: chat.chat_id,
      name: chat.name,
      owner_id: chat.owner_id || null,
    }));
    console.log(JSON.stringify({ profile: profileName, appId: app.id, chats }, null, 2));
    return;
  }

  if (!args.chat || !args.owner) {
    throw new Error('usage: transfer-chat-owner.mjs --profile claude --chat <oc_...> --owner <ou_...> [--yes]');
  }

  const before = await feishuApi(
    `/open-apis/im/v1/chats/${encodeURIComponent(args.chat)}?user_id_type=open_id`,
    token,
  );
  console.log(JSON.stringify({
    action: args.yes ? 'transfer' : 'dry-run',
    profile: profileName,
    chat: {
      chat_id: args.chat,
      name: before.data?.name,
      owner_id: before.data?.owner_id || null,
    },
    new_owner_id: args.owner,
  }, null, 2));

  if (!args.yes) return;

  await feishuApi(
    `/open-apis/im/v1/chats/${encodeURIComponent(args.chat)}?user_id_type=open_id`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({ owner_id: args.owner }),
    },
  );
  const after = await feishuApi(
    `/open-apis/im/v1/chats/${encodeURIComponent(args.chat)}?user_id_type=open_id`,
    token,
  );
  console.log(JSON.stringify({
    ok: true,
    chat_id: args.chat,
    name: after.data?.name,
    owner_id: after.data?.owner_id || null,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
