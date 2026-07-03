import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';

export type BridgeAgentSkillTarget = 'claude' | 'codex';

export type BridgeAgentSkillInstallStatus =
  | 'installed'
  | 'updated'
  | 'unchanged'
  | 'skipped-unmanaged';

export interface InstallBridgeAgentSkillsOptions {
  homeDir?: string;
  targets?: BridgeAgentSkillTarget[];
}

export interface BridgeAgentSkillInstallResult {
  target: BridgeAgentSkillTarget;
  path: string;
  status: BridgeAgentSkillInstallStatus;
}

const MANAGED_MARKER = '<!-- lark-channel-bridge-managed-skill:v1 -->';

const DEFAULT_TARGETS: BridgeAgentSkillTarget[] = ['claude', 'codex'];

export function bridgeAgentSkillPath(target: BridgeAgentSkillTarget, homeDir = homedir()): string {
  if (target === 'claude') {
    return join(homeDir, '.claude', 'skills', 'lark-channel-bridge', 'SKILL.md');
  }
  return join(homeDir, '.agents', 'skills', 'lark-channel-bridge', 'SKILL.md');
}

export async function installBridgeAgentSkills(
  opts: InstallBridgeAgentSkillsOptions = {},
): Promise<BridgeAgentSkillInstallResult[]> {
  const homeDir = opts.homeDir ?? homedir();
  const targets = opts.targets ?? DEFAULT_TARGETS;
  const content = bridgeAgentSkillContent();
  const results: BridgeAgentSkillInstallResult[] = [];
  for (const target of targets) {
    const path = bridgeAgentSkillPath(target, homeDir);
    results.push({
      target,
      path,
      status: await installManagedSkill(path, content),
    });
  }
  return results;
}

async function installManagedSkill(
  path: string,
  content: string,
): Promise<BridgeAgentSkillInstallStatus> {
  const existing = await readFile(path, 'utf8').catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  });
  if (existing === content) return 'unchanged';
  if (existing !== undefined && !existing.includes(MANAGED_MARKER)) return 'skipped-unmanaged';
  await writeFileAtomic(path, content, { mode: 0o600 });
  return existing === undefined ? 'installed' : 'updated';
}

export function bridgeAgentSkillContent(): string {
  return `---
name: lark-channel-bridge
description: Use when answering Feishu/Lark messages through lark-channel-bridge, especially when the user asks about group history, prior context, unmentioned group messages, bridge_context, or bridge-local history CLI access.
---

# Lark Channel Bridge

${MANAGED_MARKER}

You are running inside lark-channel-bridge when the prompt contains a bridge_context block or the environment contains LARK_CHANNEL=1.

## Runtime Context

- Use bridge_context.chat_id as the current Feishu/Lark chat id.
- Use bridge_context.thread_id only when it is present.
- Use LARK_CHANNEL_PROFILE as the current bridge profile. If it is unset, use the profile shown in the prompt.
- Do not unset LARK_CHANNEL, LARK_CHANNEL_HOME, LARK_CHANNEL_PROFILE, LARK_CHANNEL_CONFIG, or LARKSUITE_CLI_CONFIG_DIR.
- Do not read or print bridge config secrets.

## Group History Lookup

When the user asks whether you can read unmentioned group messages, asks about previous group discussion, asks for "context", "history", "what did we just discuss", or the task obviously depends on earlier group messages:

1. Run a status check for the current chat before answering:

\`\`\`bash
lark-channel-bridge history status --chat <bridge_context.chat_id> --profile "$LARK_CHANNEL_PROFILE"
\`\`\`

2. If status shows enabled=false, say group history is not enabled for this chat and ask an admin to run /invite group history on.
3. If status shows messageCount=0, say the current profile/chat has no recorded messages yet. Do not claim that unmentioned messages are impossible to access. Mention likely operational causes: no new messages after enablement, the bridge process did not receive the events, or the bridge needs /reconnect after app/event changes.
4. If records exist, use the smallest query that answers the question:

\`\`\`bash
lark-channel-bridge history tail --chat <bridge_context.chat_id> --limit 50 --profile "$LARK_CHANNEL_PROFILE"
lark-channel-bridge history search --chat <bridge_context.chat_id> --query "<keywords>" --limit 20 --profile "$LARK_CHANNEL_PROFILE"
lark-channel-bridge history around --chat <bridge_context.chat_id> --message <message_id> --before 30 --after 10 --profile "$LARK_CHANNEL_PROFILE"
\`\`\`

5. Base claims about group history on command output. If you did not run a history command, do not say you have read the history.
`;
}
