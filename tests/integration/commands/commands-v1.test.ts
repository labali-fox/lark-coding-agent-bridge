import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  requestScopeGrantLink: vi.fn(async () => ({
    url: 'https://auth.test/grant-group-msg',
    expireIn: 600,
    completion: new Promise<void>(() => {}),
  })),
}));

vi.mock('../../../src/bot/wizard.js', () => ({
  requestScopeGrantLink: sdkMock.requestScopeGrantLink,
}));

interface RunOverrides {
  scope?: string;
  senderId?: string;
  chatId?: string;
  chatMode?: CommandContext['chatMode'];
  mentions?: NormalizedMessage['mentions'];
}

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: ReturnType<typeof createFakeAgent>;
  controls: Controls;
  run(content: string, overrides?: RunOverrides): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('Bridge command contracts', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('switches /cd to any existing non-risk working directory', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'plain-workdir');
    const file = join(h.tmp.workspace, 'not-a-directory.txt');
    await mkdir(target, { recursive: true });
    await writeFile(file, 'not a directory', 'utf8');

    await expect(h.run('/cd relative')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('绝对路径');

    await expect(h.run(`/cd ${file}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('路径不是目录');

    await expect(h.run(`/cd ${target}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换 cwd');
    expect(lastMarkdown(h.channel)).not.toContain('允许访问目录');
    await expect(realpath(target)).resolves.toBe(h.workspaces.cwdFor('chat-1'));

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换 cwd');
    await expect(realpath(h.tmp.workspace)).resolves.toBe(h.workspaces.cwdFor('chat-1'));
  });

  it('scopes named workspaces by profile, scope, and owner', async () => {
    const h = await createHarness();
    const alternate = join(h.tmp.root, 'alternate');
    await mkdir(alternate, { recursive: true });

    h.workspaces.setCwd('chat-a', h.tmp.workspace);
    await expect(h.run('/ws save main', { scope: 'chat-a', chatId: 'chat-a' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('工作目录别名已保存');

    h.workspaces.setCwd('chat-b', alternate);
    await expect(h.run('/ws', { scope: 'chat-b', chatId: 'chat-b' })).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain('main');

    await expect(h.run('/ws use main', { scope: 'chat-b', chatId: 'chat-b' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('未找到工作目录别名');
    expect(h.workspaces.cwdFor('chat-b')).toBe(alternate);
  });

  it('continues to support legacy unscoped workspace aliases', async () => {
    const h = await createHarness();
    const legacy = join(h.tmp.root, 'legacy-alias');
    await mkdir(legacy, { recursive: true });
    h.workspaces.saveNamed('legacy', legacy);

    await expect(h.run('/ws')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).toContain('legacy');

    await expect(h.run('/ws use legacy')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换到 `legacy`');
    await expect(realpath(legacy)).resolves.toBe(h.workspaces.cwdFor('chat-1'));

    await expect(h.run('/ws remove legacy')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
    expect(h.workspaces.getNamed('legacy')).toBeUndefined();
  });

  it('removes scoped workspace aliases without deleting same-name legacy aliases', async () => {
    const h = await createHarness();
    const legacy = join(h.tmp.root, 'legacy-main');
    await mkdir(legacy, { recursive: true });
    h.workspaces.saveNamed('main', legacy);

    await expect(h.run('/ws save main')).resolves.toBe(true);
    await expect(h.run('/ws remove main')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
    expect(h.workspaces.getNamed('main')).toBe(legacy);

    await expect(h.run('/ws use main')).resolves.toBe(true);
    await expect(realpath(legacy)).resolves.toBe(h.workspaces.cwdFor('chat-1'));
  });

  it('keeps directory commands admin-only', async () => {
    const h = await createHarness();

    await expect(h.run(`/cd ${h.tmp.workspace}`, { senderId: 'ou-not-admin' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');

    await expect(h.run('/ws save mine', { senderId: 'ou-not-admin' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('does not expose authorization root management commands', async () => {
    const h = await createHarness();
    const plain = join(h.tmp.root, 'plain-nongit');
    await mkdir(plain, { recursive: true });

    await expect(h.run(`/ws add ${plain} docs`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('用法');
    expect(lastMarkdown(h.channel)).not.toContain('允许访问目录');

    await expect(h.run(`/ws remove --root ${plain}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('未找到工作目录别名');
  });

  it('keeps /ws remove as alias removal by default', async () => {
    const h = await createHarness();

    await expect(h.run('/ws save main')).resolves.toBe(true);
    await expect(h.run('/ws remove main')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
  });

  it('shows workspace paths in group-visible workspace replies', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-client-name');
    await mkdir(target, { recursive: true });
    const targetRealpath = await realpath(target);

    await expect(h.run(`/cd ${target}`, { chatMode: 'group' })).resolves.toBe(true);
    await expect(h.run('/ws save client', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('client');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws save main', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('工作目录别名已保存');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws', { chatMode: 'group' })).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain(jsonStringFragment(targetRealpath));
    expect(card).not.toContain('使用 $HOME');

    await expect(h.run('/ws use main', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换到 `main`');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);
  });

  it('shows full workspace paths in p2p workspace replies', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-p2p-client');
    await mkdir(target, { recursive: true });
    const targetRealpath = await realpath(target);

    await expect(h.run(`/cd ${target}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws save client')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws')).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain(jsonStringFragment(targetRealpath));
  });

  it('shows invalid /cd paths in group-visible replies', async () => {
    const h = await createHarness();
    const file = join(h.tmp.root, 'sensitive-client-name', 'not-a-directory.txt');
    await mkdir(join(h.tmp.root, 'sensitive-client-name'), { recursive: true });
    await writeFile(file, 'not a directory', 'utf8');

    await expect(h.run(`/cd ${file}`, { chatMode: 'group' })).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('路径不是目录');
    expect(lastMarkdown(h.channel)).toContain(await realpath(file));
  });

  it('treats legacy document workspace commands as informational no-ops', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-doc-root');
    await mkdir(target, { recursive: true });

    await expect(h.run(`/doc ws bind doc-token ${target}`, { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不需要绑定工作区');
    expect(lastMarkdown(h.channel)).not.toContain(target);
  });

  it('keeps Claude resume history details out of group chats', async () => {
    const h = await createHarness();

    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('私聊');
    expect(lastMarkdown(h.channel)).not.toContain(h.tmp.workspace);
  });

  it('renders /status passively with policy and owner state', async () => {
    const h = await createHarness();

    await expect(h.run('/status')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(0);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('Fake Agent');
    expect(status).toContain('工作目录');
    expect(status).toContain('**session**');
    expect(status).toContain('(无)');
    expect(status).not.toContain('**conversation**');
    expect(status).toContain('permission');
    expect(status).toContain('plan');
    expect(status).not.toContain('bypassPermissions');
    expect(status).not.toContain('workspace-write/workspace-write');
    expect(status).toContain('owner');
    expect(status).toContain(jsonStringFragment(await realpath(h.tmp.workspace)));
  });

  it('shows workspace paths in group-visible /status replies', async () => {
    const h = await createHarness();

    await expect(h.run('/status', { chatMode: 'group' })).resolves.toBe(true);

    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain(jsonStringFragment(await realpath(h.tmp.workspace)));
    expect(status).toContain('chat-1');
  });

  it('rejects admin-only commands for non owner/admin users', async () => {
    const h = await createHarness();

    await expect(
      h.run('/ps', { senderId: 'ou-not-admin' }),
    ).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('does not expose access allowlists through the Lark /config form', async () => {
    const h = await createHarness();

    await expect(h.run('/config')).resolves.toBe(true);

    const configCard = JSON.stringify(lastContent(h.channel));
    expect(configCard).not.toContain('allowed_users');
    expect(configCard).not.toContain('allowed_chats');
    expect(configCard).not.toContain('admins');
  });

  it('manages profile access lists through /invite and /remove', async () => {
    const h = await createHarness();

    await expect(
      h.run('/invite user @Alice', { mentions: [mention('ou-alice', 'Alice')] }),
    ).resolves.toBe(true);
    await expect(
      h.run('/invite admin @Bob', { mentions: [mention('ou-bob', 'Bob')] }),
    ).resolves.toBe(true);
    await expect(
      h.run('/invite group', {
        chatId: 'oc-group-1',
        scope: 'oc-group-1',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    let root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedUsers).toContain('ou-alice');
    expect(root?.profiles.claude?.access.admins).toEqual(['ou-admin', 'ou-bob']);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-group-1');
    expect(root?.profiles.claude?.access.chatPolicies).not.toHaveProperty('oc-group-1');
    expect(root?.profiles.claude?.preferences).not.toHaveProperty('access');

    await expect(
      h.run('/remove user @Alice', { mentions: [mention('ou-alice', 'Alice')] }),
    ).resolves.toBe(true);
    root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedUsers).not.toContain('ou-alice');
  });

  it('manages current-group no-at policy through /invite and /remove group flags', async () => {
    const h = await createHarness();

    await expect(
      h.run('/invite group no-at', {
        chatId: 'oc-group-1',
        scope: 'oc-group-1',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    let root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-group-1');
    expect(root?.profiles.claude?.access.chatPolicies).toMatchObject({
      'oc-group-1': { requireMention: false },
    });
    expect(lastMarkdown(h.channel)).toContain('不 @');

    await expect(
      h.run('/remove group no-at', {
        chatId: 'oc-group-1',
        scope: 'oc-group-1',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-group-1');
    expect(root?.profiles.claude?.access.chatPolicies['oc-group-1']).toBeUndefined();

    await expect(
      h.run('/invite group 免@', {
        chatId: 'oc-group-cn',
        scope: 'oc-group-cn',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.chatPolicies).toMatchObject({
      'oc-group-cn': { requireMention: false },
    });

    await expect(
      h.run('/remove group', {
        chatId: 'oc-group-cn',
        scope: 'oc-group-cn',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).not.toContain('oc-group-cn');
    expect(root?.profiles.claude?.access.chatPolicies['oc-group-cn']).toBeUndefined();
  });

  it('enables no-at for a group that is already allowed', async () => {
    const h = await createHarness();

    await expect(
      h.run('/invite group', {
        chatId: 'oc-already-allowed',
        scope: 'oc-already-allowed',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    await expect(
      h.run('/invite group no-at', {
        chatId: 'oc-already-allowed',
        scope: 'oc-already-allowed',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-already-allowed');
    expect(root?.profiles.claude?.access.chatPolicies).toMatchObject({
      'oc-already-allowed': { requireMention: false },
    });
    expect(lastMarkdown(h.channel)).toContain('不 @');
    expect(lastMarkdown(h.channel)).not.toContain('无需重复添加');
  });

  it('manages current-group ambient response policy through /invite and /remove group flags', async () => {
    const h = await createHarness();

    await expect(
      h.run('/invite group ambient quiet', {
        chatId: 'oc-ambient',
        scope: 'oc-ambient',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    let root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-ambient');
    expect(root?.profiles.claude?.access.chatPolicies['oc-ambient']).toMatchObject({
      responseMode: 'ambient',
      ambientLevel: 'quiet',
    });
    expect(lastMarkdown(h.channel)).toContain('看情况');

    await expect(
      h.run('/remove group ambient', {
        chatId: 'oc-ambient',
        scope: 'oc-ambient',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-ambient');
    expect(root?.profiles.claude?.access.chatPolicies['oc-ambient']).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已关闭当前群的不 @ 看情况回复');
  });

  it('warns immediately when ambient group policy is enabled without group-message scope', async () => {
    const h = await createHarness();
    setGrantedScopes(h.channel, []);

    await expect(
      h.run('/invite group ambient active', {
        chatId: 'oc-ambient-missing-scope',
        scope: 'oc-ambient-missing-scope',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-ambient-missing-scope');
    expect(root?.profiles.claude?.access.chatPolicies['oc-ambient-missing-scope']).toMatchObject({
      responseMode: 'ambient',
      ambientLevel: 'active',
    });
    expect(sdkMock.requestScopeGrantLink).toHaveBeenCalledWith({
      appId: 'app-id',
      tenantScopes: ['im:message.group_msg'],
    });
    expect(lastMarkdown(h.channel)).toContain('授权前，飞书不会把非 @ 群消息推给 bot');
    expect(JSON.stringify(h.channel.sent)).toContain('接收群里非 @ 消息还差一个权限');
  });

  it('manages current-group history policy independently from response mode', async () => {
    const h = await createHarness();

    await expect(
      h.run('/invite group no-at', {
        chatId: 'oc-history',
        scope: 'oc-history',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);
    await expect(
      h.run('/invite group history on', {
        chatId: 'oc-history',
        scope: 'oc-history',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    let root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-history');
    expect(root?.profiles.claude?.access.chatPolicies['oc-history']).toMatchObject({
      requireMention: false,
      responseMode: 'always',
      history: { enabled: true },
    });
    expect(lastMarkdown(h.channel)).toContain('历史记录');
    expect(lastMarkdown(h.channel)).toContain('只记录开启后的新消息');
    expect(lastMarkdown(h.channel)).toContain('agent 可按需查询');

    await expect(
      h.run('/invite group history off', {
        chatId: 'oc-history',
        scope: 'oc-history',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.chatPolicies['oc-history']).toMatchObject({
      requireMention: false,
      responseMode: 'always',
      history: { enabled: false },
    });
    expect(lastMarkdown(h.channel)).toContain('已关闭当前群历史记录');
  });

  it('does not invite a new group when only turning history off', async () => {
    const h = await createHarness();

    await expect(
      h.run('/invite group history off', {
        chatId: 'oc-history-off-only',
        scope: 'oc-history-off-only',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).not.toContain('oc-history-off-only');
    expect(root?.profiles.claude?.access.chatPolicies['oc-history-off-only']).toMatchObject({
      history: { enabled: false },
    });
    expect(lastMarkdown(h.channel)).toContain('响应模式保持不变');
  });

  it('does not claim a never-invited group remains allowed when only removing history', async () => {
    const h = await createHarness();

    await expect(
      h.run('/remove group history', {
        chatId: 'oc-history-remove-only',
        scope: 'oc-history-remove-only',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).not.toContain('oc-history-remove-only');
    expect(root?.profiles.claude?.access.chatPolicies['oc-history-remove-only']).toMatchObject({
      history: { enabled: false },
    });
    expect(lastMarkdown(h.channel)).not.toContain('仍保留在响应群名单里');
    expect(lastMarkdown(h.channel)).toContain('当前群不在响应群名单里');
  });

  it('treats no-at lookalike modifiers as no-at instead of removing the group', async () => {
    const h = await createHarness();

    await expect(
      h.run('/invite group no-at', {
        chatId: 'oc-lookalike',
        scope: 'oc-lookalike',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    await expect(
      h.run('/remove group no‑at', {
        chatId: 'oc-lookalike',
        scope: 'oc-lookalike',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-lookalike');
    expect(root?.profiles.claude?.access.chatPolicies['oc-lookalike']).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已关闭当前群的不 @');
  });

  it('does not remove a group when /remove group has an unknown modifier', async () => {
    const h = await createHarness();

    await expect(
      h.run('/invite group', {
        chatId: 'oc-unknown-modifier',
        scope: 'oc-unknown-modifier',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    await expect(
      h.run('/remove group not-no-at', {
        chatId: 'oc-unknown-modifier',
        scope: 'oc-unknown-modifier',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-unknown-modifier');
    expect(lastMarkdown(h.channel)).toContain('用法');
  });

  it('does not remove strict per-chat policy with /remove group no-at', async () => {
    const h = await createHarness();
    const root = await loadRootConfig(h.controls.configPath);
    const profile = root?.profiles.claude;
    expect(root).toBeTruthy();
    expect(profile).toBeTruthy();
    profile!.access = {
      ...profile!.access,
      allowedChats: ['oc-strict'],
      requireMentionInGroup: false,
      chatPolicies: {
        ...profile!.access.chatPolicies,
        'oc-strict': { requireMention: true },
      },
    };
    await saveRootConfig(root!, h.controls.configPath);

    await expect(
      h.run('/remove group no-at', {
        chatId: 'oc-strict',
        scope: 'oc-strict',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const next = await loadRootConfig(h.controls.configPath);
    expect(next?.profiles.claude?.access.allowedChats).toContain('oc-strict');
    expect(next?.profiles.claude?.access.chatPolicies['oc-strict']).toEqual({
      requireMention: true,
    });
    expect(lastMarkdown(h.channel)).toContain('没有单独的不 @ 设置');
  });

  it('adds every known bot group through /invite all group', async () => {
    const h = await createHarness();
    h.controls.knownChats = [
      { id: 'oc-group-1', name: 'Group One' },
      { id: 'oc-group-2', name: 'Group Two' },
    ];

    await expect(h.run('/invite all group')).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toEqual(['oc-group-1', 'oc-group-2']);
  });

  it('rejects no-at modifiers on /invite all group without partial updates', async () => {
    const h = await createHarness();
    h.controls.knownChats = [
      { id: 'oc-group-1', name: 'Group One' },
      { id: 'oc-group-2', name: 'Group Two' },
    ];

    await expect(h.run('/invite all group no-at')).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toEqual([]);
    expect(root?.profiles.claude?.access.chatPolicies).toEqual({});
    expect(lastMarkdown(h.channel)).toContain('不支持');
    expect(lastMarkdown(h.channel)).toContain('/invite group no-at');
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('commands-v1-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const workspaceRealpath = await realpath(tmp.workspace);
  const profileConfig = appConfig(workspaceRealpath);
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  workspaces.setCwd('chat-1', workspaceRealpath);

  const run = (content: string, overrides: RunOverrides = {}): Promise<boolean> => {
    const chatId = overrides.chatId ?? 'chat-1';
    const scope = overrides.scope ?? chatId;
    return tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, {
        chatId,
        senderId: overrides.senderId ?? 'ou-admin',
        mentions: overrides.mentions ?? [],
      }),
      scope,
      chatMode: overrides.chatMode ?? 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });
  };

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, agent, controls, run };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    preferences: { maxConcurrentRuns: 2 },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(
  content: string,
  opts: {
    chatId: string;
    senderId: string;
    mentions?: NormalizedMessage['mentions'];
  },
): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: opts.chatId,
    chatType: 'p2p',
    senderId: opts.senderId,
    senderName: 'User',
    content,
    resources: [],
    mentions: opts.mentions ?? [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function mention(openId: string, name: string): NonNullable<NormalizedMessage['mentions']>[number] {
  return {
    openId,
    name,
    isBot: false,
  } as NonNullable<NormalizedMessage['mentions']>[number];
}

function setGrantedScopes(channel: FakeChannel, scopes: string[]): void {
  (channel.rawClient as unknown as {
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
  }).application = {
    v6: {
      application: {
        get: vi.fn(async () => ({
          data: {
            app: {
              scopes: scopes.map((scope) => ({ scope })),
            },
          },
        })),
      },
    },
  };
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = lastContent(channel);
  expect(content.markdown).toBeTypeOf('string');
  return content.markdown as string;
}

function jsonStringFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
