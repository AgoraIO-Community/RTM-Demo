import { describe, expect, it, vi } from 'vitest';

import { TRACE_LIMIT, createTraceStore } from './traceStore';

/** 造一条 api 条目的最小输入（store 负责补 seq 与 uid/role）。 */
function apiInput(name: string, at = 1_000) {
  return { at, kind: 'api' as const, name };
}

describe('createTraceStore', () => {
  it('实例自己贴 uid 与角色 —— 归并后来源不能丢', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });

    store.record(apiInput('login'));

    const [entry] = store.getEntries();
    expect(entry.uid).toBe('host-aaa111');
    expect(entry.role).toBe('host');
  });

  it('seq 在实例内单调递增，从 1 开始', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });

    store.record(apiInput('login'));
    store.record(apiInput('subscribe'));
    store.record(apiInput('publish'));

    expect(store.getEntries().map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it('kind 只有 api 与 event 两种', () => {
    const store = createTraceStore({ uid: 'audience-bbb222', role: 'audience' });

    store.record({ at: 1_000, kind: 'api', name: 'login' });
    store.record({ at: 1_001, kind: 'event', name: 'message' });

    expect(store.getEntries().map((entry) => entry.kind)).toEqual(['api', 'event']);
  });

  it('可选字段按需保留：摘要、耗时、错误码与错误信息', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });

    store.record({
      at: 1_000,
      kind: 'api',
      name: 'acquireLock',
      summary: 'seats-lock',
      durationMs: 42,
      errorCode: -14008,
      errorMessage: 'LOCK_NOT_EXIST',
    });

    const [entry] = store.getEntries();
    expect(entry.summary).toBe('seats-lock');
    expect(entry.durationMs).toBe(42);
    expect(entry.errorCode).toBe(-14008);
    expect(entry.errorMessage).toBe('LOCK_NOT_EXIST');
  });
});

describe('环形上限', () => {
  it('上限是模块常量，客户拷走后可自行调整', () => {
    expect(TRACE_LIMIT).toBe(500);
  });

  it('超出上限静默丢弃最旧的，总量不再增长', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });

    for (let index = 0; index < TRACE_LIMIT + 30; index += 1) {
      store.record(apiInput(`call-${index}`));
    }

    const entries = store.getEntries();
    expect(entries).toHaveLength(TRACE_LIMIT);
    // 丢的是最旧的：最早 30 条已不在，最新一条仍在
    expect(entries[0].name).toBe('call-30');
    expect(entries[entries.length - 1].name).toBe(`call-${TRACE_LIMIT + 29}`);
  });

  it('丢弃是静默的 —— 没有任何「已截断」标记条目', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });

    for (let index = 0; index < TRACE_LIMIT + 5; index += 1) {
      store.record(apiInput(`call-${index}`));
    }

    // 每一条都是真实采集的 api/event，不存在合成的提示条目
    for (const entry of store.getEntries()) {
      expect(entry.kind === 'api' || entry.kind === 'event').toBe(true);
      expect(entry.name).toMatch(/^call-\d+$/);
    }
  });

  it('丢弃最旧不影响 seq 继续单调递增', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });

    for (let index = 0; index < TRACE_LIMIT + 3; index += 1) {
      store.record(apiInput(`call-${index}`));
    }

    const entries = store.getEntries();
    expect(entries[entries.length - 1].seq).toBe(TRACE_LIMIT + 3);
  });
});

describe('订阅', () => {
  it('订阅者在每次写入后被调用', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });
    const listener = vi.fn();

    store.subscribe(listener);
    store.record(apiInput('login'));
    store.record(apiInput('subscribe'));

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('subscribe 返回退订函数，退订后不再收到通知', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });
    const listener = vi.fn();

    const unsubscribe = store.subscribe(listener);
    store.record(apiInput('login'));
    unsubscribe();
    store.record(apiInput('subscribe'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('多个订阅者都收到通知', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });
    const first = vi.fn();
    const second = vi.fn();

    store.subscribe(first);
    store.subscribe(second);
    store.record(apiInput('login'));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('可按 record 返回的 seq 原位补充摘要，并通知订阅者', () => {
    const store = createTraceStore({ uid: 'caller-aaa111', role: 'caller' });
    const listener = vi.fn();
    store.subscribe(listener);
    const targetSeq = store.record({ at: 1_000, kind: 'event', name: 'message', summary: '待消费' });
    store.record({ at: 1_001, kind: 'api', name: 'publish' });

    store.update(targetSeq, { summary: '已忽略：信令已过期' });

    expect(store.getEntries()[0]).toMatchObject({
      seq: targetSeq, kind: 'event', name: 'message', summary: '已忽略：信令已过期',
    });
    expect(store.getEntries()[1]?.name).toBe('publish');
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe('快照', () => {
  it('取快照返回的数组被改写不影响 store 内部状态', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });
    store.record(apiInput('login'));

    const snapshot = store.getEntries();
    (snapshot as unknown as unknown[]).push({ bogus: true });
    (snapshot as unknown as unknown[]).length = 0;

    expect(store.getEntries()).toHaveLength(1);
    expect(store.getEntries()[0].name).toBe('login');
  });

  it('原地改写快照里的条目对象也不影响 store 内部状态', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });
    store.record(apiInput('login'));

    // 浅拷贝挡不住这一手：数组是新的，元素对象却与内部共享引用。
    const snapshot = store.getEntries();
    (snapshot[0] as { name: string }).name = 'tampered';
    (snapshot as unknown as unknown[])[0] = { bogus: true };

    expect(store.getEntries()[0].name).toBe('login');
  });

  it('getEntries 在没有写入时返回同一个引用 —— 供 useSyncExternalStore 判定未变', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });
    store.record(apiInput('login'));

    expect(store.getEntries()).toBe(store.getEntries());
  });

  it('写入后 getEntries 返回新引用 —— 外部 store 订阅据此重渲染', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });
    store.record(apiInput('login'));
    const before = store.getEntries();

    store.record(apiInput('subscribe'));

    expect(store.getEntries()).not.toBe(before);
  });
});

describe('清空', () => {
  it('clear 清掉条目并通知订阅者', () => {
    const store = createTraceStore({ uid: 'host-aaa111', role: 'host' });
    const listener = vi.fn();
    store.record(apiInput('login'));
    store.subscribe(listener);

    store.clear();

    expect(store.getEntries()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
