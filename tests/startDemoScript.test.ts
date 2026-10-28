import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 这份测试守的是仓库的「启动契约」：一条命令能起来，默认命令指向根目录的实验室，
 * 构建只产出单入口，vitest 的 setup 住在 `src/test/` 下。
 *
 * 断言全部写成正向形式（「应该是什么」），不写「不应该是什么」—— 后者需要预设
 * 一份历史清单，读的人无从判断清单为何如此。
 */
describe('start-demo.sh', () => {
  it('provides an executable environment check for one-command startup', () => {
    const script = resolve(process.cwd(), 'start-demo.sh');
    expect(() => accessSync(script, constants.X_OK)).not.toThrow();

    const result = spawnSync(script, ['--check'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Demo environment is ready');
    expect(result.stdout).toContain('scenes/voice-room');
    // 版本来自当前 npm 安装结果。
    expect(result.stdout).toContain('agora-rtm@2.3.0');
    expect(result.stdout).toContain('agora-rtc-sdk-ng@4.24.6');
  });

  it('documents LAN HTTPS on port 8080 as the default startup mode', () => {
    const script = resolve(process.cwd(), 'start-demo.sh');
    const result = spawnSync(script, ['--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Default URL: https://<LAN IPv4>:8080/');
    expect(result.stdout).toContain('Default listen address: 0.0.0.0');
    expect(result.stdout).toContain('--http');
    expect(result.stdout).toContain('--https');
    expect(result.stdout).toContain('--both');
    expect(result.stdout).toContain('--no-open');
  });

  it('defaults to HTTPS on all interfaces without opening a browser', () => {
    const script = readFileSync(resolve(process.cwd(), 'start-demo.sh'), 'utf8');

    expect(script).toMatch(/^server_mode="https"$/m);
    expect(script).toMatch(/^open_browser="false"$/m);
    expect(script).toContain('demo_host=${RTM_DEMO_HOST:-0.0.0.0}');
    expect(script).toContain('--http) server_mode="http" ;;');
  });

  it('supports HTTP, HTTPS and dual-server development modes', () => {
    const script = readFileSync(resolve(process.cwd(), 'start-demo.sh'), 'utf8');
    const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    const gitignore = readFileSync(resolve(process.cwd(), '.gitignore'), 'utf8');

    expect(script).toContain('https://$demo_public_host:$https_port/');
    expect(script).toContain('mkcert -cert-file');
    expect(script).toContain('npm run dev:https');
    expect(viteConfig).toContain("mode === 'https'");
    expect(viteConfig).toContain(".cert/dev-key.pem");
    expect(gitignore).toContain('.cert/');
  });

  it('keeps the four default npm workflows pointed at this package', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    // 四条默认命令都在本包内执行，不跨包委托（`--prefix` 会破坏这一点）
    expect(packageJson.scripts.dev).toBe('vite --host 127.0.0.1 --port 8080');
    expect(packageJson.scripts['dev:https']).toBe('vite --mode https --host 127.0.0.1 --port 8080');
    expect(packageJson.scripts.build).toBe('tsc -b && vite build');
    expect(packageJson.scripts.test).toBe('vitest run');
    expect(packageJson.scripts['test:e2e']).toBe('playwright test');

    for (const command of Object.values(packageJson.scripts)) {
      expect(command).not.toContain('--prefix');
    }
  });

  it('builds exactly one entry from the repo root', () => {
    // 只有一个入口页
    expect(existsSync(resolve(process.cwd(), 'index.html'))).toBe(true);

    /*
     * 断言不配置多入口。匹配的是 `rollupOptions`（多入口必经的配置项）而不是
     * 某个具体文件名 —— 前者是行为，后者只是字符。注释先剥掉，避免说明性文字
     * 意外命中。
     */
    const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    const withoutComments = viteConfig
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toContain('rollupOptions');
  });

  it('runs vitest setup from src/test', () => {
    const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain('./src/test/setup.ts');
    expect(existsSync(resolve(process.cwd(), 'src/test/setup.ts'))).toBe(true);
  });

  it('loads the application without embedding a real App ID', () => {
    const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

    expect(indexHtml).toContain('src="/src/app/main.tsx"');
    expect(indexHtml).not.toMatch(/[0-9a-fA-F]{32}/);
  });

  it('keeps archived applications outside this single-application repository', () => {
    for (const archivedPath of [
      'demos/voice-room',
      'src/legacy',
      'legacy.html',
      'e2e/scenarios.spec.ts',
    ]) {
      expect(existsSync(resolve(process.cwd(), archivedPath)), archivedPath).toBe(false);
    }

  });

  it('isolates e2e from the developer local env without changing normal dev mode', () => {
    const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    const playwrightConfig = readFileSync(resolve(process.cwd(), 'playwright.config.ts'), 'utf8');

    expect(viteConfig).toContain("mode === 'e2e' ? false : undefined");
    expect(playwrightConfig).toContain('--mode e2e');
    expect(playwrightConfig).toContain('reuseExistingServer: false');
  });
});
