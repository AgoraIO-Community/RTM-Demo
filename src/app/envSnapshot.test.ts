import { describe, expect, it } from 'vitest';

import { readEnvSnapshot } from './envSnapshot';

/**
 * 这里断言的是模块级记忆化行为，所以整个文件只能有一次「首次调用」。
 * vitest 按文件隔离模块，`window.__ENV__` 必须在第一次调用之前写好。
 */
describe('readEnvSnapshot', () => {
  it('启动时读一次快照即固定，之后改 window.__ENV__ 不再生效', () => {
    window.__ENV__ = { appId: 'first-snapshot' };

    const first = readEnvSnapshot();
    expect(first).toEqual({
      configured: true,
      appId: 'first-snapshot',
      source: 'window.__ENV__',
    });

    // 注入迟到不被支持：不监听变化、不轮询、不代理劫持全局对象
    window.__ENV__ = { appId: 'changed-later' };

    const second = readEnvSnapshot();
    // 同一个对象，说明是记忆化的快照而不是每次重读
    expect(second).toBe(first);
  });

  it('读快照不写入任何 storage —— 新骨架的运行时配置一律不落 storage', () => {
    sessionStorage.clear();
    localStorage.clear();

    readEnvSnapshot();

    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});
