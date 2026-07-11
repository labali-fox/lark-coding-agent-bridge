import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearKeystoreDerivedKeyCache, setSecret } from '../../../src/config/keystore';
import { paths } from '../../../src/config/paths';
import { resolveAppSecret } from '../../../src/config/secret-resolver';
import { secretKeyForApp, type AppConfig } from '../../../src/config/schema';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('secret resolver', () => {
  it('adds App Secret recovery guidance when a bridge keystore entry cannot decrypt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-secret-resolver-'));
    roots.push(root);
    const storePaths = {
      secretsFile: join(root, 'secrets.enc'),
      keystoreSaltFile: join(root, '.keystore.salt'),
    };
    const appId = 'cli_test';
    await setSecret(secretKeyForApp(appId), 'old-secret', storePaths);
    await writeFile(storePaths.keystoreSaltFile, Buffer.alloc(32, 7));
    clearKeystoreDerivedKeyCache();

    const cfg: AppConfig = {
      accounts: {
        app: {
          id: appId,
          secret: { source: 'exec', provider: 'bridge', id: secretKeyForApp(appId) },
          tenant: 'feishu',
        },
      },
      secrets: {
        providers: {
          bridge: {
            source: 'exec',
            command: paths.secretsGetterScript,
          },
        },
      },
    };

    await expect(resolveAppSecret(cfg, storePaths)).rejects.toThrow(
      /App Secret for cli_test could not be decrypted.*lark-channel-bridge secrets set --profile <profile> --app-id cli_test/s,
    );
  });
});
