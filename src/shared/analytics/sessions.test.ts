import { beforeEach, describe, expect, it, vi } from 'vitest';
import { experienceScenarios } from '../../app/experienceScenarios';
import { createAnalyticsTracker, type AnalyticsEvent } from './tracker';

const voice = experienceScenarios[0];
const call = experienceScenarios[1];
const day = 24 * 60 * 60 * 1000;
let now: number;
let sequence: number;
let events: AnalyticsEvent[];

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(), key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function page(url: string, session = memoryStorage(), flush = () => {}, shared = localStorage) {
  let href = url;
  const tracker = createAnalyticsTracker({
    environment: 'local', site: 'cn', now: () => now, uuid: () => `id-${++sequence}`,
    href: () => href, replaceHref: value => { href = value; },
    storage: kind => kind === 'local' ? shared : session,
    capture: event => events.push(event), flush,
  });
  return { tracker, session, href: () => href };
}

beforeEach(() => { now = 1_800_000_000_000; sequence = 0; events = []; });

describe('按入口隔离、跨标签页共享的体验会话', () => {
  it('新入口建立 B，旧入口 A 的页面继续使用 A 的来源和会话', () => {
    const a = page('https://example.com/social/voice-room?utm_source=website&utm_medium=rtm_hero');
    a.tracker.enterScene(voice);
    const sidA = events[0].properties.lab_session_id;
    const b = page('https://example.com/social/voice-room?utm_source=docs&utm_medium=demo_list');
    b.tracker.enterScene(voice);
    const sidB = events[1].properties.lab_session_id;
    a.tracker.docClick(voice, 'api');
    b.tracker.docClick(voice, 'source');
    expect(sidA).not.toBe(sidB);
    expect(events.at(-2)?.properties).toMatchObject({ lab_session_id: sidA, utm_source: 'website' });
    expect(events.at(-1)?.properties).toMatchObject({ lab_session_id: sidB, utm_source: 'docs' });
    expect(events.every(event => event.properties.visitor_id === events[0].properties.visitor_id)).toBe(true);
  });

  it('同标签页的新 UTM 只切换该页面绑定，不覆盖其他 A 页面', () => {
    const a = page('https://example.com/social/voice-room?utm_source=website&utm_medium=rtm_hero');
    a.tracker.enterScene(voice);
    const sid = events[0].properties.lab_session_id;
    const peer = page(a.tracker.prepareNavigation(voice, 'https://example.com/social/voice-room', true));
    peer.tracker.enterScene(voice);
    const b = page('https://example.com/social/voice-room?utm_source=docs&utm_medium=scenario_doc', a.session);
    b.tracker.enterScene(voice);
    peer.tracker.consoleClick(voice);
    expect(events.filter(event => event.event === 'lab_enter')).toHaveLength(2);
    expect(events.at(-1)?.properties).toMatchObject({ lab_session_id: sid, utm_source: 'website' });
  });

  it('内部新开同场景继承会话、共享任务去重，不产生场景切换或第二次进入', () => {
    const a = page('https://example.com/social/voice-room?utm_source=website&utm_medium=rtm_hero');
    a.tracker.enterScene(voice);
    const peer = page(a.tracker.prepareNavigation(voice, 'https://example.com/social/voice-room', true));
    peer.tracker.enterScene(voice);
    const progress = { scenarioId: voice.id, milestones: ['login', 'subscribe'] };
    a.tracker.updateProgress(voice, progress);
    peer.tracker.updateProgress(voice, progress);
    peer.tracker.docClick(voice, 'api');
    expect(events.map(event => event.event)).toEqual(['lab_enter', 'task_complete', 'doc_click']);
    expect(new Set(events.map(event => event.properties.lab_session_id)).size).toBe(1);
    expect(peer.href()).toBe('https://example.com/social/voice-room');
    expect(events[1].properties).not.toHaveProperty('task_index');
  });

  it('跨页交接只在目标场景到达时确认切换，刷新不重复', () => {
    const a = page('https://example.com/social/voice-room');
    a.tracker.enterScene(voice);
    const url = a.tracker.prepareNavigation(call, 'https://example.com/social/one-to-one-call', false);
    a.tracker.leave();
    const b = page(url, a.session);
    b.tracker.enterScene(call);
    b.tracker.leave();
    page(b.href(), a.session).tracker.enterScene(call);
    expect(events.map(event => event.event)).toEqual(['lab_enter', 'scene_switch']);
    expect(events[1].properties).toMatchObject({ from_scene: 'voice-room', to_scene: 'one-to-one-call' });
  });

  it('最后一个页面离开前发送，再清理共享会话；刷新仍可从标签页快照恢复', () => {
    let sharedKeysAtFlush = 0;
    const a = page('https://example.com/social/voice-room', memoryStorage(), () => {
      sharedKeysAtFlush = localStorage.length;
    });
    a.tracker.enterScene(voice);
    const visitor = events[0].properties.visitor_id;
    a.tracker.leave();
    expect(sharedKeysAtFlush).toBeGreaterThan(1);
    expect(localStorage.length).toBe(1);
    page(a.href(), a.session).tracker.enterScene(voice);
    expect(events).toHaveLength(1);
    expect(events[0].properties.visitor_id).toBe(visitor);
  });

  it('关闭 A 不影响继承页；最后继承页离开才清理会话，其他来源 B 保留', () => {
    const a = page('https://example.com/social/voice-room');
    a.tracker.enterScene(voice);
    const peer = page(a.tracker.prepareNavigation(voice, 'https://example.com/social/voice-room', true));
    peer.tracker.enterScene(voice);
    const b = page('https://example.com/social/voice-room?utm_source=docs&utm_medium=demo_list');
    b.tracker.enterScene(voice);
    a.tracker.leave();
    peer.tracker.docClick(voice, 'api');
    expect(events.at(-1)?.properties.lab_session_id).toBe(events[0].properties.lab_session_id);
    peer.tracker.leave();
    b.tracker.docClick(voice, 'source');
    expect(events.at(-1)?.properties.lab_session_id).toBe(events[1].properties.lab_session_id);
    b.tracker.leave();
    expect(localStorage.length).toBe(1);
  });

  it('浏览器复制标签页的存储快照不能注销仍活跃的来源文档', () => {
    const a = page('https://example.com/social/voice-room');
    a.tracker.enterScene(voice);
    const cloned = memoryStorage();
    for (let index = 0; index < a.session.length; index++) {
      const key = a.session.key(index)!;
      cloned.setItem(key, a.session.getItem(key)!);
    }
    const b = page(a.href(), cloned);
    b.tracker.enterScene(voice);
    b.tracker.leave();
    expect(localStorage.length).toBeGreaterThan(1);
    a.tracker.leave();
    expect(localStorage.length).toBe(1);
  });

  it('恢复活跃读到旧快照时，不能覆盖另一页面刚完成的任务去重', () => {
    const a = page('https://example.com/social/voice-room');
    a.tracker.enterScene(voice);
    let interleave = false;
    const progress = { scenarioId: voice.id, milestones: ['login', 'subscribe'] };
    const shared: Storage = {
      get length() { return localStorage.length; },
      key: index => localStorage.key(index), clear: () => localStorage.clear(),
      setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key),
      getItem: key => {
        const previous = localStorage.getItem(key);
        if (interleave && key.startsWith('rtm_lab_session_v2:')) {
          interleave = false;
          a.tracker.updateProgress(voice, progress);
        }
        return previous;
      },
    };
    const b = page(a.tracker.prepareNavigation(voice, 'https://example.com/social/voice-room', true), memoryStorage(), () => {}, shared);
    b.tracker.enterScene(voice);
    now += day - 1;
    interleave = true;
    b.tracker.resume();
    now += 2;
    a.tracker.resume();
    a.tracker.updateProgress(voice, progress);
    expect(events.filter(event => event.event === 'task_complete')).toHaveLength(1);
    expect(events.filter(event => event.event === 'lab_enter')).toHaveLength(1);
  });

  it('来源页准备交接后完成任务并关闭，迟到目标页恢复最新进度而非旧链接快照', () => {
    const a = page('https://example.com/social/voice-room');
    a.tracker.enterScene(voice);
    const link = a.tracker.prepareNavigation(voice, 'https://example.com/social/voice-room', true);
    const progress = { scenarioId: voice.id, milestones: ['login', 'subscribe'] };
    a.tracker.updateProgress(voice, progress);
    a.tracker.leave();
    const b = page(link);
    b.tracker.enterScene(voice);
    b.tracker.updateProgress(voice, progress);
    expect(events.map(event => event.event)).toEqual(['lab_enter', 'task_complete']);
    b.tracker.leave();
    expect(localStorage.length).toBe(1);
  });

  it('落盘后配额耗尽、读取仍正常时，内存中的完成记录不能被旧磁盘值覆盖', () => {
    let full = false;
    const shared: Storage = {
      get length() { return localStorage.length; },
      key: index => localStorage.key(index), clear: () => localStorage.clear(),
      getItem: key => localStorage.getItem(key), removeItem: key => localStorage.removeItem(key),
      setItem: (key, value) => {
        if (full) throw new DOMException('quota', 'QuotaExceededError');
        localStorage.setItem(key, value);
      },
    };
    const a = page('https://example.com/social/voice-room', memoryStorage(), () => {}, shared);
    a.tracker.enterScene(voice);
    full = true;
    const progress = { scenarioId: voice.id, milestones: ['login', 'subscribe'] };
    a.tracker.updateProgress(voice, progress);
    a.tracker.updateProgress(voice, progress);
    expect(events.filter(event => event.event === 'task_complete')).toHaveLength(1);
    a.tracker.leave();
    expect(localStorage.length).toBe(1);
  });

  it('24 小时边界由活跃检查触发，提前一毫秒仍保留原会话，不建立定时器', () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const a = page('https://example.com/social/voice-room');
    a.tracker.enterScene(voice);
    now += day - 1;
    a.tracker.resume();
    expect(events).toHaveLength(1);
    now += 1;
    expect(events).toHaveLength(1);
    a.tracker.resume();
    expect(events.map(event => event.event)).toEqual(['lab_enter', 'lab_enter']);
    expect(events[1].properties.lab_session_id).not.toBe(events[0].properties.lab_session_id);
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    timeout.mockRestore(); interval.mockRestore();
  });

  it('共享页实际事件延续会话，单纯激活、刷新不会延后最后上报时间', () => {
    const a = page('https://example.com/social/voice-room');
    a.tracker.enterScene(voice);
    const peer = page(a.tracker.prepareNavigation(voice, 'https://example.com/social/voice-room', true));
    peer.tracker.enterScene(voice);
    now += day - 1;
    peer.tracker.docClick(voice, 'api');
    now += 2;
    a.tracker.resume();
    expect(events.filter(event => event.event === 'lab_enter')).toHaveLength(1);
    now += day;
    a.tracker.resume();
    peer.tracker.resume();
    expect(events.filter(event => event.event === 'lab_enter')).toHaveLength(2);
    a.tracker.docClick(voice, 'api');
    peer.tracker.docClick(voice, 'source');
    expect(events.at(-2)?.properties.lab_session_id).toBe(events.at(-1)?.properties.lab_session_id);
  });
});
