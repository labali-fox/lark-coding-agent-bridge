import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = 'scripts/deploy-mac2015.sh';

describe('deploy-mac2015 script contract', () => {
  it('prints a safe help contract without opening ssh', async () => {
    const { stdout, stderr } = await execFileAsync('bash', [script, '--help'], {
      cwd: process.cwd(),
    });

    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: scripts/deploy-mac2015.sh [status|deploy]');
    expect(stdout).toContain('/Users/ys-aquria/code/lark-coding-agent-bridge');
    expect(stdout).toContain('LARK_CHANNEL_NO_PROXY=1');
    expect(stdout).toContain('No App Secret or profile secret values are printed.');
    expect(stdout).not.toContain('--app-secret');
  });

  it('rejects unsupported modes before opening ssh', async () => {
    await expect(
      execFileAsync('bash', [script, 'destroy'], {
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('Unsupported mode: destroy'),
    });
  });

  it('supports the current registry object shape when finding running bots', async () => {
    const body = await readFile(script, 'utf8');

    expect(body).toContain('Array.isArray(root.entries) ? root.entries');
  });

  it('reports the active deployment mode and detached log path', async () => {
    const body = await readFile(script, 'utf8');

    expect(body).toContain('gui_domain_available()');
    expect(body).toContain('launchd_service_loaded()');
    expect(body).toContain('deployment_mode()');
    expect(body).toContain('ai.lark-channel-bridge.bot.${BRIDGE_PROFILE}');
    expect(body).toContain("printf 'deployment_mode=%s\\n'");
    expect(body).toContain('detached_log_path=');
  });
});
