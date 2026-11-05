import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('E2E RTM adapter boundary', () => {
  it('keeps development, unit-test and E2E optimizer caches independent without local certificates', () => {
    const cleanRoot = mkdtempSync(join(tmpdir(), 'rtm-cache-test-'));
    const script = `
      import { resolveConfig } from 'vite';
      process.chdir(${JSON.stringify(cleanRoot)});
      const caches = [];
      for (const mode of ['development', 'test', 'e2e']) {
        const config = await resolveConfig({ configFile: ${JSON.stringify(resolve('vite.config.ts'))}, mode }, 'serve');
        caches.push(config.cacheDir);
      }
      console.log(JSON.stringify(caches));
    `;
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
      const caches: string[] = JSON.parse(result.stdout.trim());
      expect(new Set(caches).size).toBe(3);
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  });

  it('resolves agora-rtm to the dedicated E2E adapter only in e2e mode', async () => {
    const script = `
      import { resolveConfig } from 'vite';
      for (const mode of ['e2e', 'development']) {
        const config = await resolveConfig({ configFile: 'vite.config.ts', mode }, 'serve');
        console.log(mode + '=' + await config.createResolver()('agora-rtm'));
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const resolutions = Object.fromEntries(
      result.stdout.trim().split('\n').map((line) => line.split('=', 2)),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(resolutions.e2e).toBe(
      resolve(process.cwd(), 'e2e/support/agora-rtm.ts'),
    );
    expect(resolutions.development).not.toBe(
      resolve(process.cwd(), 'e2e/support/agora-rtm.ts'),
    );
  });
});
