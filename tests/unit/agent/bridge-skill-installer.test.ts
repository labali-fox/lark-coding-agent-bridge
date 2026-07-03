import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bridgeAgentSkillPath,
  installBridgeAgentSkills,
} from '../../../src/agent/bridge-skill-installer';

const roots: string[] = [];

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-agent-skill-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bridge agent skill installer', () => {
  it('installs managed skills for Claude Code and Codex user scopes', async () => {
    const homeDir = await tempHome();

    const results = await installBridgeAgentSkills({ homeDir });

    expect(results).toEqual([
      {
        target: 'claude',
        path: bridgeAgentSkillPath('claude', homeDir),
        status: 'installed',
      },
      {
        target: 'codex',
        path: bridgeAgentSkillPath('codex', homeDir),
        status: 'installed',
      },
    ]);
    const claudeSkill = await readFile(bridgeAgentSkillPath('claude', homeDir), 'utf8');
    const codexSkill = await readFile(bridgeAgentSkillPath('codex', homeDir), 'utf8');
    expect(claudeSkill).toContain('name: lark-channel-bridge');
    expect(claudeSkill).toContain('<!-- lark-channel-bridge-managed-skill:v1 -->');
    expect(claudeSkill).toContain('lark-channel-bridge history status --chat');
    expect(claudeSkill).toContain('bridge_context.chat_id');
    expect(claudeSkill).toContain('LARK_CHANNEL_PROFILE');
    expect(claudeSkill).not.toContain('lark-cli');
    expect(codexSkill).toBe(claudeSkill);
  });

  it('is idempotent when managed skill content is already current', async () => {
    const homeDir = await tempHome();
    await installBridgeAgentSkills({ homeDir });

    await expect(installBridgeAgentSkills({ homeDir })).resolves.toEqual([
      {
        target: 'claude',
        path: bridgeAgentSkillPath('claude', homeDir),
        status: 'unchanged',
      },
      {
        target: 'codex',
        path: bridgeAgentSkillPath('codex', homeDir),
        status: 'unchanged',
      },
    ]);
  });

  it('updates older managed skills without overwriting unmanaged user files', async () => {
    const homeDir = await tempHome();
    const claudePath = bridgeAgentSkillPath('claude', homeDir);
    const codexPath = bridgeAgentSkillPath('codex', homeDir);
    await mkdir(join(claudePath, '..'), { recursive: true });
    await mkdir(join(codexPath, '..'), { recursive: true });
    await writeFile(claudePath, 'custom user skill\n', 'utf8');
    await writeFile(codexPath, '<!-- lark-channel-bridge-managed-skill:v1 -->\nold\n', 'utf8');

    await expect(installBridgeAgentSkills({ homeDir })).resolves.toEqual([
      {
        target: 'claude',
        path: claudePath,
        status: 'skipped-unmanaged',
      },
      {
        target: 'codex',
        path: codexPath,
        status: 'updated',
      },
    ]);
    await expect(readFile(claudePath, 'utf8')).resolves.toBe('custom user skill\n');
    await expect(readFile(codexPath, 'utf8')).resolves.toContain(
      'lark-channel-bridge history status --chat',
    );
  });
});
