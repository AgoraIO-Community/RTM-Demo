import { describe, expect, it } from 'vitest';

import { resolveEnv } from './env';

describe('resolveEnv', () => {
  it('开发默认不鉴权，生产默认使用同源 Token Server', () => {
    const base = { VITE_APP_ID: 'app-id' };
    expect(resolveEnv({ buildTime: base })).not.toHaveProperty('auth');
    expect(resolveEnv({ buildTime: { ...base, PROD: true } })).toMatchObject({
      auth: { mode: 'token' },
    });
  });

  it('鉴权模式只由 VITE_AUTH_MODE 配置，App ID 仍支持页面注入', () => {
    expect(resolveEnv({
      injected: { appId: 'runtime-app' },
      buildTime: { VITE_AUTH_MODE: 'token' },
    })).toMatchObject({ appId: 'runtime-app', auth: { mode: 'token' } });
    expect(resolveEnv({
      injected: { appId: 'runtime-app' },
      buildTime: { PROD: true, VITE_AUTH_MODE: 'none' },
    })).not.toHaveProperty('auth');
    expect(resolveEnv({
      injected: { appId: 'runtime-app', ...{ authMode: 'token', tokenEndpoint: '/custom/token' } },
      buildTime: { VITE_AUTH_MODE: 'none' },
    })).not.toHaveProperty('auth');
  });

  it('未知鉴权模式不能静默降级', () => {
    expect(() => resolveEnv({
      buildTime: { VITE_APP_ID: 'app-id', VITE_AUTH_MODE: 'invalid' },
    })).toThrow('鉴权模式');
  });

  it('线上注入生效：window.__ENV__ 优先于 import.meta.env', () => {
    const result = resolveEnv({
      injected: { appId: 'injected-app-id' },
      buildTime: { VITE_APP_ID: 'build-time-app-id' },
    });

    expect(result.configured).toBe(true);
    expect(result.appId).toBe('injected-app-id');
    expect(result.source).toBe('window.__ENV__');
  });

  it('本地兜底生效：只有 import.meta.env 时用它', () => {
    const result = resolveEnv({
      injected: undefined,
      buildTime: { VITE_APP_ID: 'build-time-app-id' },
    });

    expect(result.configured).toBe(true);
    expect(result.appId).toBe('build-time-app-id');
    expect(result.source).toBe('import.meta.env');
  });

  it('未配置可被 UI 识别：两者都缺时返回未配置状态，不抛异常', () => {
    const result = resolveEnv({ injected: undefined, buildTime: {} });

    expect(result.configured).toBe(false);
    // 未配置时不得凭空造出一个 appId —— 源码里没有第三层硬编码兜底
    expect(result).not.toHaveProperty('appId');
  });

  it('空字符串与纯空白视为未配置，不是有效 appId', () => {
    expect(resolveEnv({ injected: { appId: '   ' }, buildTime: {} }).configured).toBe(false);
    expect(resolveEnv({ injected: undefined, buildTime: { VITE_APP_ID: '' } }).configured).toBe(
      false,
    );
  });

  it('注入值前后空白被裁掉', () => {
    const result = resolveEnv({ injected: { appId: '  padded-id  ' }, buildTime: {} });

    expect(result.configured).toBe(true);
    expect(result.appId).toBe('padded-id');
  });

  it('window.__ENV__ 存在但 appId 无效时，回落到 import.meta.env', () => {
    const result = resolveEnv({
      injected: { appId: '' },
      buildTime: { VITE_APP_ID: 'build-time-app-id' },
    });

    expect(result.configured).toBe(true);
    expect(result.appId).toBe('build-time-app-id');
    expect(result.source).toBe('import.meta.env');
  });
});
