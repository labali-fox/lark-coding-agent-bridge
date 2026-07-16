import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = 'scripts/deploy-mac2015.sh';

type RegistryEntry = {
  id: string;
  profileName: string;
  pid: number;
};

async function writeExecutable(path: string, body: string) {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function runIsolatedStatus(options: {
  entries: RegistryEntry[];
  launchdPid?: number;
  registryRoot?: 'array' | 'entries';
}) {
  const root = await mkdtemp(join(tmpdir(), 'deploy-mac2015-test-'));
  const home = join(root, 'home');
  const remoteDir = join(root, 'remote');
  const bin = join(root, 'bin');
  const registryDir = join(home, '.lark-channel', 'registry');
  const registryReads = join(root, 'registry-reads');
  await Promise.all([
    mkdir(registryDir, { recursive: true }),
    mkdir(remoteDir, { recursive: true }),
    mkdir(bin, { recursive: true }),
  ]);

  const registry =
    options.registryRoot === 'array' ? options.entries : { entries: options.entries };
  await writeFile(join(registryDir, 'processes.json'), JSON.stringify(registry));
  await writeFile(
    join(remoteDir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0' }),
  );

  const realNode = process.execPath;
  await Promise.all([
    writeExecutable(
      join(bin, 'ssh'),
      '#!/usr/bin/env bash\nset -euo pipefail\nshift\nexec bash -c "$1"\n',
    ),
    writeExecutable(
      join(bin, 'node'),
      '#!/usr/bin/env bash\nset -euo pipefail\nif [ "${1:-}" = "-" ] && [ "${2:-}" = "claude" ]; then printf "read\\n" >> "$REGISTRY_READS"; fi\nexec "$REAL_NODE" "$@"\n',
    ),
    writeExecutable(
      join(bin, 'launchctl'),
      '#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$2" == gui/*/ai.lark-channel-bridge.bot.* ]]; then\n  [ -n "${LAUNCHD_PID:-}" ] || exit 1\n  printf "{\\n  pid = %s\\n}\\n" "$LAUNCHD_PID"\nfi\n',
    ),
    ...['git', 'npm', 'pnpm', 'lark-channel-bridge'].map((name) =>
      writeExecutable(join(bin, name), '#!/usr/bin/env bash\nexit 0\n'),
    ),
  ]);

  try {
    const result = await execFileAsync('bash', [script, 'status'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        REAL_NODE: realNode,
        REGISTRY_READS: registryReads,
        SSH_OPTS: '',
        LARK_BRIDGE_REMOTE: 'isolated-test-host',
        LARK_BRIDGE_REMOTE_DIR: remoteDir,
        LARK_BRIDGE_PROFILE: 'claude',
        ...(options.launchdPid === undefined
          ? { LAUNCHD_PID: '' }
          : { LAUNCHD_PID: String(options.launchdPid) }),
      },
    });
    const readCount = (await readFile(registryReads, 'utf8').catch(() => ''))
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    return { ...result, readCount, home };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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
    expect(body).toContain('launchd_service_pid()');
    expect(body).toContain('deployment_mode()');
    expect(body).toContain('ai.lark-channel-bridge.bot.${BRIDGE_PROFILE}');
    expect(body).toContain("printf 'deployment_mode=%s\\n'");
    expect(body).toContain('detached_log_path=');
  });

  it.each([
    {
      name: 'launchd',
      entries: [{ id: 'live', profileName: 'claude', pid: process.pid }],
      launchdPid: process.pid,
      expected: 'launchd',
    },
    {
      name: 'detached',
      entries: [{ id: 'live', profileName: 'claude', pid: process.pid }],
      expected: 'detached',
    },
    { name: 'stopped', entries: [], expected: 'stopped' },
    {
      name: 'loaded label with another PID',
      entries: [{ id: 'manual', profileName: 'claude', pid: process.pid }],
      launchdPid: 1,
      expected: 'detached',
    },
    {
      name: 'launchd PID after a detached registry row',
      entries: [
        { id: 'manual', profileName: 'claude', pid: process.pid },
        { id: 'managed', profileName: 'claude', pid: process.ppid },
      ],
      launchdPid: process.ppid,
      expected: 'launchd',
      expectedPid: process.ppid,
    },
    {
      name: 'stale registry row',
      entries: [{ id: 'stale', profileName: 'claude', pid: 2_147_483_647 }],
      launchdPid: 2_147_483_647,
      registryRoot: 'array' as const,
      expected: 'stopped',
    },
  ])(
    'reports $expected for $name',
    async ({ entries, launchdPid, registryRoot, expected, expectedPid }) => {
      const { stdout, home } = await runIsolatedStatus({
        entries,
        launchdPid,
        registryRoot,
      });

      expect(stdout).toContain(`deployment_mode=${expected}`);
      if (expected === 'stopped') {
        expect(stdout).not.toContain('deployment_pid=');
      } else {
        expect(stdout).toContain(`deployment_pid=${expectedPid ?? process.pid}`);
      }
      if (expected === 'detached') {
        expect(stdout).toContain(
          `detached_log_path=${home}/.lark-channel/logs/manual-bridge-claude.log`,
        );
      }
    },
  );

  it('uses one live registry snapshot when reporting mode and PID', async () => {
    const { readCount } = await runIsolatedStatus({
      entries: [{ id: 'live', profileName: 'claude', pid: process.pid }],
      launchdPid: process.pid,
    });

    expect(readCount).toBe(1);
  });
});
