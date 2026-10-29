/**
 * 环境配置解析：window.__ENV__ → import.meta.env → 未配置。
 *
 * 本文件是纯逻辑，不读全局、不带状态。读一次启动快照的职责在 `envSnapshot.ts`。
 *
 * 优先级不可颠倒：`import.meta.env` 是构建期烧进 bundle 的常量，若让它优先，
 * 上层网站就永远换不掉 appId。
 *
 * 源码里刻意没有第三层硬编码兜底。真实 appId 只能由运行时注入或本地环境变量提供，
 * 不得提交到开源仓库。
 */

import type { TokenAuthConfig } from '../shared/utils/token';
import type { AnalyticsSettings } from '../shared/analytics/posthog';

export interface LabEnv {
  appId?: string;
  analytics?: AnalyticsSettings;
}

/** 构建期注入的本地兜底配置（Vite 的 import.meta.env 子集）。 */
export interface BuildTimeEnv {
  VITE_APP_ID?: string;
  VITE_AUTH_MODE?: string;
  PROD?: boolean;
}

export interface EnvInputs {
  injected?: LabEnv;
  buildTime: BuildTimeEnv;
}

/** appId 的来源，仅用于引导页与 README 的自诊断提示。 */
export type EnvSource = 'window.__ENV__' | 'import.meta.env';

/**
 * 未配置分支显式标注 `appId?: undefined`，而不是省略这两个键：
 * 这样 `configured` 仍能做判别式窄化（调用方 check 过就拿到 `string`），
 * 同时未窄化时读属性也合法（`string | undefined`），不必在每个读取点加断言。
 * 运行时刻意不设置这两个键 —— 未配置时不得凭空造出一个 appId。
 */
export type ResolvedEnv =
  | { configured: true; appId: string; source: EnvSource; auth?: TokenAuthConfig }
  | { configured: false; appId?: undefined; source?: undefined };

/** 空字符串与纯空白都不是有效 appId，裁掉前后空白后再判定。 */
function normalizeAppId(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * 解析 appId。纯函数，输入显式传入 —— 调用方负责在启动时读一次全局快照。
 * 未配置时返回可被 UI 识别的状态，不抛异常（这不是异常，是未配置）。
 */
export function resolveEnv({ injected, buildTime }: EnvInputs): ResolvedEnv {
  const fromInjected = normalizeAppId(injected?.appId);
  const fromBuildTime = normalizeAppId(buildTime.VITE_APP_ID);
  const appId = fromInjected || fromBuildTime;
  if (!appId) return { configured: false };
  const mode = buildTime.VITE_AUTH_MODE ?? (buildTime.PROD ? 'token' : 'none');
  if (mode !== 'none' && mode !== 'token') throw new Error('鉴权模式必须为 none 或 token');
  return {
    configured: true, appId, source: fromInjected ? 'window.__ENV__' : 'import.meta.env',
    ...(mode === 'token' ? { auth: { mode: 'token' as const } } : {}),
  };
}
