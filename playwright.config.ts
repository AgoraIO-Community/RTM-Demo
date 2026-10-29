import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeBasePath } from './src/shared/basePath';

const e2eBasePath = normalizeBasePath(process.env.E2E_BASE_PATH ?? '/');

const chromeForTesting = join(
  homedir(),
  '.agent-browser',
  'browsers',
  'chrome-148.0.7778.97',
  'Google Chrome for Testing.app',
  'Contents',
  'MacOS',
  'Google Chrome for Testing',
);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    trace: 'retain-on-failure',
    launchOptions: existsSync(chromeForTesting) ? { executablePath: chromeForTesting } : undefined,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npm run dev -- --mode e2e --host 127.0.0.1 --port 4173 --base ${e2eBasePath}`,
    url: `http://127.0.0.1:4173${e2eBasePath}`,
    // 不复用普通 mode 启动的服务，否则它可能已经加载了本机 `.env.local`。
    reuseExistingServer: false,
  },
});
