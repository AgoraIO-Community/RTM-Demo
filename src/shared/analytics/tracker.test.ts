import { beforeEach, describe, expect, it } from 'vitest';

import { experienceScenarios } from '../../app/experienceScenarios';
import { createAnalyticsTracker, type AnalyticsEvent } from './tracker';

const voice = experienceScenarios[0];
const call = experienceScenarios[1];
const fullProgress = { scenarioId: 'voice-room', milestones: [
  'login', 'subscribe', 'remote-member', 'seat-signal', 'seat-occupied',
  'interaction-sent', 'interaction-received', 'state-synced',
] };
let now: number;
let href: string;
let serial: number;
let events: AnalyticsEvent[];

function tracker(overrides: Partial<Parameters<typeof createAnalyticsTracker>[0]> = {}) {
  return createAnalyticsTracker({
    site: 'cn', environment: 'local', capture: event => events.push(event), now: () => now,
    uuid: () => `random-${++serial}`, href: () => href,
    referrer: () => 'https://doc.shengwang.cn/sensitive?token=secret#input',
    ...overrides,
  });
}

beforeEach(() => {
  now = 1_800_000_000_000;
  serial = 0;
  href = 'https://rtm-demo.shengwang.cn/?utm_source=website&utm_medium=rtm_hero';
  events = [];
});

describe('匿名体验事件', () => {
  it('首次进入记录来源和 referrer 域名，重复挂载不重复计数', () => {
    const analytics = tracker();
    analytics.enterScene(voice);
    analytics.enterScene(voice);

    expect(events.map(event => event.event)).toEqual(['lab_enter']);
    expect(events[0].properties).toMatchObject({
      site: 'cn', environment: 'local', scene: 'voice-room', landing_scene: 'voice-room',
      utm_source: 'website', utm_medium: 'rtm_hero', referrer: 'doc.shengwang.cn',
      visitor_id: 'v_random-1', lab_session_id: 's_random-2', ts: now,
    });
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it.each([
    ['', 'direct', 'none'],
    ['?utm_source=docs&utm_medium=scenario_doc', 'docs', 'scenario_doc'],
    ['?utm_source=console&utm_medium=banner', 'console', 'banner'],
    ['?utm_source=someone-secret&utm_medium=room-name', 'unknown', 'unknown'],
    ['?utm_source=website', 'unknown', 'unknown'],
  ])('入口 %s 使用约定来源', (query, source, medium) => {
    href = `https://rtm-demo.shengwang.cn/social/voice-room${query}`;
    tracker().enterScene(voice);
    expect(events[0].properties).toMatchObject({ utm_source: source, utm_medium: medium });
  });

  it('不同 UTM 新建会话并使用新来源，访客身份保持', () => {
    tracker().enterScene(voice);
    href = 'https://rtm-demo.shengwang.cn/social/voice-room?utm_source=docs&utm_medium=demo_list';
    tracker().enterScene(voice);

    expect(events.map(event => event.event)).toEqual(['lab_enter', 'lab_enter']);
    expect(events[1].properties).toMatchObject({
      visitor_id: events[0].properties.visitor_id,
      utm_source: 'docs', utm_medium: 'demo_list',
    });
    expect(events[1].properties.lab_session_id).not.toBe(events[0].properties.lab_session_id);
  });

  it('静置 24 小时后不刷新也会在下次点击前开始新会话', () => {
    const analytics = tracker();
    analytics.enterScene(voice);
    now += 24 * 60 * 60 * 1000;
    href = 'https://rtm-demo.shengwang.cn/social/voice-room';
    analytics.consoleClick(voice);

    expect(events.map(event => event.event)).toEqual([
      'lab_enter', 'lab_enter', 'console_click',
    ]);
    expect(events[2].properties).toMatchObject({
      visitor_id: events[0].properties.visitor_id,
      utm_source: 'direct', utm_medium: 'none', tasks_done: 0, task_total: 5,
    });
    expect(events[2].immediate).toBe(true);
  });

  it('导航意图直到目标场景加载才计切换，刷新不重复切换', () => {
    const analytics = tracker();
    analytics.enterScene(voice);
    analytics.prepareSceneSwitch(voice, call);
    expect(events).toHaveLength(1);
    href = 'https://rtm-demo.shengwang.cn/social/one-to-one-call';
    tracker().enterScene(call);
    tracker().enterScene(call);

    expect(events.filter(event => event.event === 'scene_switch')).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({
        from_scene: 'voice-room', to_scene: 'one-to-one-call', scene: 'one-to-one-call',
      }) }),
    ]);
    expect(events.at(-1)?.properties.lab_session_id).toBe('s_random-2');
  });

  it('忽略当前场景和待开放入口', () => {
    const analytics = tracker();
    analytics.enterScene(experienceScenarios[2]);
    analytics.prepareSceneSwitch(voice, voice);
    analytics.prepareSceneSwitch(voice, experienceScenarios[2]);
    expect(events).toEqual([]);
    expect(sessionStorage.length).toBe(0);
  });

  it('一个任务必须满足全部里程碑，跨刷新仅记录一次完成', () => {
    const analytics = tracker();
    analytics.enterScene(voice);
    analytics.updateProgress(voice, { scenarioId: 'voice-room', milestones: ['login'] });
    expect(events.filter(event => event.event === 'task_complete')).toHaveLength(0);
    analytics.updateProgress(voice, { scenarioId: 'voice-room', milestones: ['login', 'subscribe'] });
    tracker().updateProgress(voice, { scenarioId: 'voice-room', milestones: ['login', 'subscribe'] });

    expect(events.filter(event => event.event === 'task_complete')).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({ task_id: 'connection' }) }),
    ]);
    expect(events.find(event => event.event === 'task_complete')!.properties).not.toHaveProperty('task_index');
  });

  it('五个任务全部满足时仅记录一次场景完成，耗时包含刷新', () => {
    tracker().enterScene(voice);
    now += 123_456;
    const analytics = tracker();
    analytics.updateProgress(voice, fullProgress);
    analytics.updateProgress(voice, fullProgress);
    analytics.consoleClick(voice, fullProgress);

    expect(events.filter(event => event.event === 'task_complete')).toHaveLength(5);
    expect(events.filter(event => event.event === 'scene_complete')).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({ task_total: 5, duration_sec: 123 }) }),
    ]);
    expect(events.at(-1)?.properties).toMatchObject({ tasks_done: 5, task_total: 5 });
  });

  it('历史任务去重集合不能替代当前页面全部完成，也不混用其他场景进度', () => {
    const analytics = tracker();
    analytics.updateProgress(voice, { scenarioId: 'voice-room', milestones: ['login', 'subscribe'] });
    tracker().updateProgress(voice, { ...fullProgress, milestones: fullProgress.milestones.slice(2) });
    analytics.consoleClick(voice, { scenarioId: 'one-to-one-call', milestones: fullProgress.milestones });
    expect(events.filter(event => event.event === 'scene_complete')).toHaveLength(0);
    expect(events.at(-1)?.properties.tasks_done).toBe(0);
  });

  it('开发资源只记录链接类型，发送错误不会影响业务', () => {
    const analytics = tracker();
    analytics.docClick(call, 'source');
    expect(events.at(-1)).toMatchObject({
      event: 'doc_click', properties: { scene: 'one-to-one-call', link_type: 'source' }, immediate: true,
    });
    const broken = tracker({ capture: () => { throw new Error('offline'); } });
    expect(() => broken.docClick(call, 'api')).not.toThrow();
  });

  it('存储禁用时内存内仍能保持会话并去重', () => {
    const analytics = tracker({ storage: () => { throw new Error('blocked'); } });
    analytics.enterScene(voice);
    analytics.enterScene(voice);
    analytics.updateProgress(voice, fullProgress);
    analytics.updateProgress(voice, fullProgress);
    expect(events.filter(event => event.event === 'lab_enter')).toHaveLength(1);
    expect(events.filter(event => event.event === 'task_complete')).toHaveLength(5);
    expect(events.filter(event => event.event === 'scene_complete')).toHaveLength(1);
  });

  it('损坏的存储状态会重建，不阻止场景进入', () => {
    tracker().enterScene(voice);
    const key = sessionStorage.key(0)!;
    sessionStorage.setItem(key, '{"id":"bad","lastAt":null,"scenes":null}');
    expect(() => tracker().enterScene(voice)).not.toThrow();
    expect(events.filter(event => event.event === 'lab_enter')).toHaveLength(2);
  });

  it('同源切换 local/prod 时身份和去重隔离，回到原环境保留会话', () => {
    tracker().updateProgress(voice, fullProgress);
    const local = events[0].properties;
    tracker({ environment: 'prod' }).updateProgress(voice, fullProgress);
    const prod = events.find(event => event.event === 'lab_enter' && event.properties.environment === 'prod')!.properties;
    expect(prod.lab_session_id).not.toBe(local.lab_session_id);
    expect(prod.visitor_id).not.toBe(local.visitor_id);
    const returned = tracker();
    returned.updateProgress(voice, fullProgress);
    returned.docClick(voice, 'api');
    expect(events.filter(event => event.event === 'lab_enter')).toHaveLength(2);
    expect(events.filter(event => event.event === 'task_complete')).toHaveLength(10);
    expect(events.filter(event => event.event === 'scene_complete')).toHaveLength(2);
    expect(events.at(-1)?.properties.environment).toBe('local');
    expect(events.at(-1)?.properties.lab_session_id).toBe(local.lab_session_id);
  });
});
