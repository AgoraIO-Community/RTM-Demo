import { describe, expect, it, vi } from 'vitest';
import type { CaptureResult, PostHogConfig } from 'posthog-js';

import { experienceScenarios } from '../../app/experienceScenarios';
import { resolveAnalyticsConfig, sanitizePostHogEvent, startAnalytics } from './posthog';

describe('PostHog 配置和隐私边界', () => {
  it('没有 Project token 时关闭，显式禁用覆盖构建期配置', () => {
    expect(resolveAnalyticsConfig({})).toBeUndefined();
    expect(resolveAnalyticsConfig({ injected: { enabled: false }, buildTime: {
      VITE_POSTHOG_PROJECT_TOKEN: 'phc_placeholder',
    } })).toBeUndefined();
  });

  it('运行时配置优先，默认使用 US 采集域名', () => {
    expect(resolveAnalyticsConfig({ buildTime: { VITE_POSTHOG_PROJECT_TOKEN: 'phc_placeholder' } }))
      .toEqual({ projectToken: 'phc_placeholder', apiHost: 'https://us.i.posthog.com', site: 'cn', environment: 'local' });
    expect(resolveAnalyticsConfig({
      injected: { projectToken: 'phc_runtime', apiHost: 'https://example.com/ingest/', site: 'global' },
      buildTime: { VITE_POSTHOG_PROJECT_TOKEN: 'phc_build' },
    })).toEqual({ projectToken: 'phc_runtime', apiHost: 'https://example.com/ingest', site: 'global', environment: 'local' });
  });

  it.each([
    [false, 'rtm-demo.shengwang.cn', 'local'],
    [true, 'rtm-demo.shengwang.cn', 'prod'],
    [true, 'localhost', 'local'],
    [true, '127.0.0.1', 'local'],
    [true, '192.168.1.10', 'local'],
    [true, '10.0.0.8', 'local'],
    [true, '172.16.0.8', 'local'],
    [true, '172.32.0.8', 'prod'],
    [true, '[::1]', 'local'],
    [true, 'demo.localhost', 'local'],
    [true, 'computer.local', 'local'],
  ])('PROD=%s、域名 %s 默认标记 %s', (prod, hostname, environment) => {
    expect(resolveAnalyticsConfig({ hostname, buildTime: { PROD: prod, VITE_POSTHOG_PROJECT_TOKEN: 'phc_placeholder' } }))
      .toMatchObject({ environment });
  });

  it('环境支持构建期配置与运行时覆盖，非法值关闭采集', () => {
    const buildTime = { VITE_POSTHOG_PROJECT_TOKEN: 'phc_placeholder', VITE_ANALYTICS_ENVIRONMENT: 'prod' };
    expect(resolveAnalyticsConfig({ buildTime })).toMatchObject({ environment: 'prod' });
    expect(resolveAnalyticsConfig({ buildTime, injected: { environment: 'local' } }))
      .toMatchObject({ environment: 'local' });
    expect(resolveAnalyticsConfig({ buildTime: { ...buildTime, VITE_ANALYTICS_ENVIRONMENT: 'staging' } })).toBeUndefined();
  });

  it.each(['javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/?token=private'])
  ('拒绝无效采集地址 %s', apiHost => {
    expect(resolveAnalyticsConfig({ injected: { projectToken: 'phc_placeholder', apiHost } })).toBeUndefined();
  });

  it('过滤最终事件负载的 URL、用户内容、SDK 属性和 person 更新', () => {
    const event: CaptureResult = {
      uuid: '019c0000-0000-7000-8000-000000000001', event: 'console_click',
      timestamp: new Date(1_800_000_000_000),
      properties: {
        visitor_id: 'v_anonymous', lab_session_id: 's_anonymous', ts: 1_800_000_000_000,
        site: 'cn', environment: 'prod', scene: 'voice-room', utm_source: 'website', utm_medium: 'rtm_hero',
        tasks_done: 2, task_total: 5, nickname: 'secret-nickname', token: 'untrusted',
        $current_url: 'https://example.com/?room=secret-room&token=secret-token',
        $referrer: 'https://example.com/private', $ip: '203.0.113.1',
        $set: { email: 'private@example.com' }, $initial_current_url: 'secret-url',
      },
      $set: { name: 'secret-name' }, $set_once: { $initial_referrer: 'secret-referrer' },
    };
    const clean = sanitizePostHogEvent(event, 'phc_placeholder');
    expect(clean).toMatchObject({
      event: 'console_click', properties: {
        token: 'phc_placeholder', distinct_id: 'v_anonymous',
        visitor_id: 'v_anonymous', lab_session_id: 's_anonymous', tasks_done: 2, task_total: 5,
        environment: 'prod',
        $process_person_profile: false, $geoip_disable: true,
      },
    });
    expect(Object.keys(clean!.properties).sort()).toEqual([
      '$geoip_disable', '$process_person_profile', 'distinct_id', 'environment', 'lab_session_id', 'scene', 'site',
      'task_total', 'tasks_done', 'token', 'ts', 'utm_medium', 'utm_source', 'visitor_id',
    ]);
    expect(JSON.stringify(clean)).not.toMatch(/secret|private|203\.0\.113/);
    expect(clean).not.toHaveProperty('$set');
    expect(clean).not.toHaveProperty('$set_once');
  });

  it('非约定事件直接丢弃', () => {
    expect(sanitizePostHogEvent({ uuid: 'id', event: '$autocapture', properties: {} }, 'phc_placeholder')).toBeNull();
    expect(sanitizePostHogEvent(null, 'phc_placeholder')).toBeNull();
  });

  it.each([undefined, 'staging', 'secret-room-name'])('缺失或非法环境 %s 的事件不能混入看板', environment => {
    const event: CaptureResult = {
      uuid: '019c0000-0000-7000-8000-000000000001', event: 'doc_click', properties: {
        visitor_id: 'v_anonymous', lab_session_id: 's_anonymous', ts: 1_800_000_000_000,
        site: 'cn', environment, scene: 'voice-room', utm_source: 'direct', utm_medium: 'none', link_type: 'api',
      },
    };
    expect(sanitizePostHogEvent(event, 'phc_placeholder')).toBeNull();
  });

  it('禁用时不加载 SDK、不写入浏览器存储', () => {
    const load = vi.fn();
    expect(startAnalytics(undefined, load)).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('加载 SDK 后按序发送积压事件，离站点击即时发送，关闭所有自动采集', async () => {
    let config!: Partial<PostHogConfig>;
    const sent: { event: string; properties: Record<string, unknown>; options?: Record<string, unknown> }[] = [];
    class SDK {
      init(_key: string, options: Partial<PostHogConfig>) { config = options; return this; }
      capture(event: string, properties: Record<string, unknown>, options?: Record<string, unknown>) {
        sent.push({ event, properties, options });
      }
    }
    const analytics = startAnalytics({ projectToken: 'phc_placeholder', site: 'cn', environment: 'prod', apiHost: 'https://example.com' },
      async () => ({ PostHog: SDK }));
    analytics!.enterScene(experienceScenarios[0]);
    analytics!.consoleClick(experienceScenarios[0]);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map(event => event.event)).toEqual(['lab_enter', 'console_click']);
    expect(sent.every(event => event.properties.environment === 'prod')).toBe(true);
    expect(sent[1].options).toMatchObject({ send_instantly: true, transport: 'sendBeacon' });
    expect(config).toMatchObject({
      autocapture: false, capture_pageview: false, capture_pageleave: false,
      capture_exceptions: false, capture_performance: false, capture_heatmaps: false,
      capture_dead_clicks: false, disable_session_recording: true, person_profiles: 'never',
      disable_external_dependency_loading: true, advanced_disable_flags: true,
      save_campaign_params: false, save_referrer: false, persistence: 'memory',
    });
  });

  it('SDK 未加载完成就离开，先发送已过滤的缓冲事件，迟到 SDK 不再重复发送', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'sendBeacon');
    const requests: { url: string; blob: Blob }[] = [];
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true,
      value: (url: string, blob: Blob) => { requests.push({ url, blob }); return true; } });
    let resolve!: (value: { PostHog: new () => { init(): void; capture(): void } }) => void;
    const sent: string[] = [];
    class SDK { init() {} capture() { sent.push('event'); } }
    try {
      const analytics = startAnalytics({ projectToken: 'phc_placeholder', site: 'cn', environment: 'local', apiHost: 'https://example.com/ingest' },
        () => new Promise(ready => { resolve = ready; }))!;
      analytics.enterScene(experienceScenarios[0]);
      await Promise.resolve();
      analytics.leave();
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('https://example.com/ingest/i/v0/e/');
      const payload = JSON.parse(await requests[0].blob.text());
      expect(payload.batch).toHaveLength(1);
      expect(payload.batch[0]).toMatchObject({ event: 'lab_enter', properties: { token: 'phc_placeholder', environment: 'local' } });
      expect(JSON.stringify(payload)).not.toMatch(/\$current_url|\$set|task_index|scene_enter/);
      resolve({ PostHog: SDK });
      await Promise.resolve(); await Promise.resolve();
      expect(sent).toEqual([]);
    } finally {
      if (original) Object.defineProperty(navigator, 'sendBeacon', original);
      else Reflect.deleteProperty(navigator, 'sendBeacon');
    }
  });

  it('SDK 导入失败不会产生未处理异常或阻止后续业务', async () => {
    const load = vi.fn().mockRejectedValue(new Error('chunk unavailable'));
    const analytics = startAnalytics({ projectToken: 'phc_placeholder', site: 'cn', environment: 'local', apiHost: 'https://example.com' }, load)!;
    expect(() => analytics.enterScene(experienceScenarios[0])).not.toThrow();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(() => analytics.consoleClick(experienceScenarios[0])).not.toThrow();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
