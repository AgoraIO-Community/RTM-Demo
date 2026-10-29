import { afterEach, describe, expect, it, vi } from 'vitest';

import { appPath, getAppBasePath, normalizeBasePath } from './paths';

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
});

describe('应用公共路径', () => {
  it.each([
    ['/', '/'], ['/rtm-demo', '/rtm-demo/'], ['/rtm-demo/', '/rtm-demo/'],
    ['/products/rtm-demo', '/products/rtm-demo/'],
  ])('规范化 %s 为 %s', (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });

  it.each(['https://example.com', '//example.com', '/rtm-demo/../', '/rtm-demo?token=x', '/rtm-demo#x', '/bad%2fpath'])
  ('拒绝跨域或歧义基路径 %s', input => {
    expect(() => normalizeBasePath(input)).toThrow('应用基路径无效');
  });

  it('前缀内使用配置的 base，旧根入口保持兼容', () => {
    expect(getAppBasePath('/rtm-demo/social/voice-room', '/rtm-demo/')).toBe('/rtm-demo/');
    expect(getAppBasePath('/rtm-demo', '/rtm-demo/')).toBe('/rtm-demo/');
    expect(getAppBasePath('/social/voice-room', '/rtm-demo/')).toBe('/');
    expect(getAppBasePath('/rtm-demo-other/social/voice-room', '/rtm-demo/')).toBe('/');
  });

  it('浏览器中的 API 和新开页面都使用当前应用基路径', () => {
    vi.stubEnv('BASE_URL', '/rtm-demo/');
    window.history.replaceState(null, '', '/rtm-demo/social/voice-room?data=identity');
    expect(appPath('/api/token')).toBe('/rtm-demo/api/token');
    expect(appPath('/social/one-to-one-call')).toBe('/rtm-demo/social/one-to-one-call');
    window.history.replaceState(null, '', '/social/voice-room');
    expect(appPath('/api/token')).toBe('/api/token');
  });
});
