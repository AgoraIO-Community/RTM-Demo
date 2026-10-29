import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { normalizeBasePath } from './src/shared/basePath';

export default defineConfig(({ mode }) => {
  const base = normalizeBasePath(process.env.VITE_BASE_PATH
    ?? (mode === 'e2e' ? '/' : loadEnv(mode, process.cwd(), 'VITE_BASE_PATH').VITE_BASE_PATH)
    ?? '/');
  const https = mode === 'https'
    ? {
        key: readFileSync(resolve('.cert/dev-key.pem')),
        cert: readFileSync(resolve('.cert/dev.pem')),
      }
    : undefined;

  return {
    base,
    plugins: [react()],
    server: https ? { https } : undefined,
  resolve: mode === 'e2e' ? {
    alias: {
      'agora-rtm': resolve('e2e/support/agora-rtm.ts'),
      // Replace only the scene's audio factory; the adapter reuses the real session.
      './rtc/call-audio': resolve('e2e/support/call-rtc.ts'),
    },
  } : undefined,
  // E2E 通过页面脚本显式注入环境，不读取开发者本机的任何 `.env*` 文件。
  // 普通 dev/build 的 envDir 保持默认值，因此 `.env.local` 仍正常生效。
  envDir: mode === 'e2e' ? false : undefined,
  /*
   * vendor 里的 RTM SDK 是 UMD/CJS 产物（`module.exports = ...`，无 `exports.default`）。
   * 生产构建走 Rollup 的 commonjs 转换没问题，但开发服务器不预构建它时会按 ESM 解析，
   * 于是浏览器报 `does not provide an export named 'default'`，整个 app 起不来。
   *
   * 显式列进 `optimizeDeps.include` 强制预构建成 ESM。**不要删** —— 它是软链进来的
   * 本地包，Vite 的自动依赖发现对软链包不可靠。
   */
  optimizeDeps: {
    include: mode === 'e2e' ? [] : ['agora-rtm'],
    exclude: mode === 'e2e' ? ['agora-rtm'] : [],
  },
  /*
   * 不配置 `build.rollupOptions.input`：只有根 `index.html` 一个入口，
   * 走 Vite 默认行为即可。
   */
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
  },
  };
});
