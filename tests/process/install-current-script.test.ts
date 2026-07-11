import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = 'bin/install-current-and-run.sh';

describe('install-current-and-run smoke contract', () => {
  it('prints help without running install steps', async () => {
    const { stdout, stderr } = await execFileAsync('bash', [script, '--help'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LARK_CHANNEL_USE_LOCAL: '',
        LARK_CHANNEL_NO_PROXY: '',
      },
    });

    expect(stderr).toBe('');
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('bin/install-current-and-run.sh [--local] [--no-proxy]');
    expect(stdout).toContain('Local mode skips git status checks');
    expect(stdout).toContain('unset HTTP(S) proxy');
    expect(stdout).not.toContain('pnpm install');
  });

  it('rejects unsupported actions before install/build side effects', async () => {
    await expect(
      execFileAsync('bash', [script, '--local', '--no-proxy', 'deploy'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LARK_CHANNEL_USE_LOCAL: '',
          LARK_CHANNEL_NO_PROXY: '',
        },
      }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('Unsupported action: deploy'),
    });
  });
});
