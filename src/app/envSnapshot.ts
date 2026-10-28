/**
 * 启动时读一次环境快照即固定。
 *
 * 与 `env.ts` 分开：那边是纯函数，这边读全局并带模块级状态。分文件让两者各有
 * 一份同名测试，而不必靠「另开一个测试文件」来绕开模块隔离。
 */

import { resolveEnv, type LabEnv, type ResolvedEnv } from './env';

declare global {
  interface Window {
    /** 上层页面必须在加载 app bundle 之前同步写好这个对象。 */
    __ENV__?: LabEnv;
  }
}

/** 记忆化的启动快照。`undefined` 表示还没读过。 */
let snapshot: ResolvedEnv | undefined;

/**
 * 读一次全局快照即固定。
 *
 * 刻意不监听变化、不轮询、不代理劫持 `window.__ENV__` —— 支持异步注入意味着要引入
 * 「等待 env」的加载态，以及注入迟到时已建立的 RTM 连接如何重连的问题，收益不成比例。
 * 上层页面必须在加载 app bundle 之前同步注入（见 README 的注入契约一节）。
 */
export function readEnvSnapshot(): ResolvedEnv {
  // 不做 `typeof window === 'undefined'` 的 SSR 守卫：本实验室只在浏览器里跑，
  // 加了就是一条永不执行、也无法被测试覆盖的分支。
  snapshot ??= resolveEnv({
    injected: window.__ENV__,
    buildTime: {
      VITE_APP_ID: import.meta.env.VITE_APP_ID as string | undefined,
      VITE_AUTH_MODE: import.meta.env.VITE_AUTH_MODE as string | undefined,
      PROD: import.meta.env.PROD,
    },
  });
  return snapshot;
}
