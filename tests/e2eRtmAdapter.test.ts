import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('E2E RTM adapter boundary', () => {
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
