import { describe, expect, it } from 'vitest';

import { mergeTraces } from './mergeTraces';
import { createTraceStore, type TraceEntry } from './traceStore';

function entry(overrides: Partial<TraceEntry> & Pick<TraceEntry, 'at' | 'seq' | 'uid'>): TraceEntry {
  return {
    kind: 'api',
    role: 'host',
    name: 'login',
    ...overrides,
  };
}

describe('mergeTraces', () => {
  it('两份 trace 按时间戳归并成一条时间线', () => {
    const host = [entry({ at: 100, seq: 1, uid: 'host-a', name: 'login' })];
    const audience = [
      entry({ at: 50, seq: 1, uid: 'audience-b', role: 'audience', name: 'login' }),
      entry({ at: 150, seq: 2, uid: 'audience-b', role: 'audience', name: 'subscribe' }),
    ];

    expect(mergeTraces([host, audience]).map((item) => item.at)).toEqual([50, 100, 150]);
  });

  it('同毫秒时按各实例内部的单调递增序号做稳定排序', () => {
    const host = [
      entry({ at: 100, seq: 1, uid: 'host-a', name: 'acquireLock' }),
      entry({ at: 100, seq: 2, uid: 'host-a', name: 'getMetadata' }),
      entry({ at: 100, seq: 3, uid: 'host-a', name: 'setMetadata' }),
    ];

    // 同毫秒的三条必须保持 1 → 2 → 3 的实例内顺序
    expect(mergeTraces([host]).map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('同毫秒跨实例时保持各自实例内的相对次序', () => {
    const host = [
      entry({ at: 100, seq: 1, uid: 'host-a', name: 'h1' }),
      entry({ at: 100, seq: 2, uid: 'host-a', name: 'h2' }),
    ];
    const audience = [
      entry({ at: 100, seq: 1, uid: 'audience-b', role: 'audience', name: 'a1' }),
      entry({ at: 100, seq: 2, uid: 'audience-b', role: 'audience', name: 'a2' }),
    ];

    const merged = mergeTraces([host, audience]);
    const hostOrder = merged.filter((item) => item.uid === 'host-a').map((item) => item.name);
    const audienceOrder = merged
      .filter((item) => item.uid === 'audience-b')
      .map((item) => item.name);

    expect(hostOrder).toEqual(['h1', 'h2']);
    expect(audienceOrder).toEqual(['a1', 'a2']);
  });

  it('归并后每条仍带自己的 uid 与角色 —— 来源不能丢', () => {
    const host = [entry({ at: 100, seq: 1, uid: 'host-a', role: 'host' })];
    const audience = [entry({ at: 101, seq: 1, uid: 'audience-b', role: 'audience' })];

    expect(mergeTraces([host, audience])).toEqual([
      expect.objectContaining({ uid: 'host-a', role: 'host' }),
      expect.objectContaining({ uid: 'audience-b', role: 'audience' }),
    ]);
  });

  it('不改写入参数组', () => {
    const host = [
      entry({ at: 200, seq: 1, uid: 'host-a' }),
      entry({ at: 100, seq: 2, uid: 'host-a' }),
    ];
    const before = [...host];

    mergeTraces([host]);

    expect(host).toEqual(before);
  });

  it('空输入返回空数组，不抛异常', () => {
    expect(mergeTraces([])).toEqual([]);
    expect(mergeTraces([[], []])).toEqual([]);
  });

  it('可直接归并多个 store 的快照', () => {
    const hostStore = createTraceStore({ uid: 'host-a', role: 'host' });
    const audienceStore = createTraceStore({ uid: 'audience-b', role: 'audience' });

    hostStore.record({ at: 100, kind: 'api', name: 'login' });
    audienceStore.record({ at: 90, kind: 'api', name: 'login' });
    hostStore.record({ at: 110, kind: 'event', name: 'message' });

    const merged = mergeTraces([hostStore.getEntries(), audienceStore.getEntries()]);

    expect(merged.map((item) => [item.uid, item.name])).toEqual([
      ['audience-b', 'login'],
      ['host-a', 'login'],
      ['host-a', 'message'],
    ]);
  });

  it('超过两份也能归并 —— 会议室/课堂是三端以上', () => {
    const teacher = [entry({ at: 100, seq: 1, uid: 'teacher-a', role: 'teacher' })];
    const student = [entry({ at: 90, seq: 1, uid: 'student-b', role: 'student' })];
    const assistant = [entry({ at: 110, seq: 1, uid: 'assistant-c', role: 'assistant' })];

    expect(mergeTraces([teacher, student, assistant]).map((item) => item.role)).toEqual([
      'student',
      'teacher',
      'assistant',
    ]);
  });
});
