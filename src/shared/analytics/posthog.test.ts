import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureResult, PostHogConfig } from 'posthog-js';

import { experienceScenarios } from '../../app/experienceScenarios';
import { resolveAnalyticsConfig, sanitizePostHogEvent, startAnalytics } from './posthog';

describe('可选账号身份关联', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  const settings = { projectToken: 'phc_placeholder', site: 'cn' as const, environment: 'prod' as const,
    apiHost: 'https://example.com', identityEndpoint: '/rtm-demo/api/auth/session' };

  function sdkHarness() {
    let config!: Partial<PostHogConfig>;
    const sent: CaptureResult[] = [];
    class SDK {
      init(_token: string, options: Partial<PostHogConfig>) { config = options; }
      capture(event: string, properties: Record<string, unknown>) {
        sent.push({ uuid: '019c0000-0000-7000-8000-000000000001', event, properties });
      }
    }
    return { load: async () => ({ PostHog: SDK }), sent, config: () => config,
      clean(event: CaptureResult) {
        if (typeof config.before_send !== 'function') throw new Error('缺少负载过滤函数');
        return config.before_send(event);
      },
    };
  }

  it('身份接口仅接受显式注入的本站路径', () => {
    expect(resolveAnalyticsConfig({ injected: settings })).toMatchObject({ identityEndpoint: settings.identityEndpoint });
    for (const identityEndpoint of ['https://evil.invalid/session', '//evil.invalid/session', '/api/../session', '/api/session?token=private', '/api/%2fsession']) {
      expect(resolveAnalyticsConfig({ injected: { ...settings, identityEndpoint } })).toBeUndefined();
    }
  });

  it('已登录页面从首个事件起使用稳定身份，只保留 ID 且不信任事件伪造的身份', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ authenticated: true,
      identity: { id: 'sso:account-main', email: 'private@example.com' }, access_token: 'private-token' }));
    vi.stubGlobal('fetch', request);
    const sdk = sdkHarness();
    const analytics = startAnalytics(settings, sdk.load)!;
    analytics.enterScene(experienceScenarios[0]);
    analytics.consoleClick(experienceScenarios[0]);
    await vi.waitFor(() => expect(sdk.sent).toHaveLength(2));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(settings.identityEndpoint, expect.objectContaining({
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
    }));
    expect(sdk.config()).toMatchObject({ person_profiles: 'identified_only',
      bootstrap: { distinctID: 'sso:account-main', isIdentifiedID: true } });
    const event = { ...sdk.sent[0], properties: { ...sdk.sent[0].properties,
      distinct_id: 'forged-user', accountUid: 'forged-user', email: 'private@example.com', $set: { email: 'private@example.com' } } };
    const clean = sdk.clean(event);
    expect(clean).toMatchObject({ properties: { distinct_id: 'sso:account-main', $process_person_profile: true } });
    expect(JSON.stringify(clean)).not.toMatch(/private|forged|\$set|accountUid/);
    expect(clean?.properties.visitor_id).toMatch(/^v_/);
  });

  it.each([
    [401, { authenticated: true, identity: { id: 'sso:account-main' } }],
    [200, { authenticated: false, identity: { id: 'sso:account-main' } }],
    [200, { authenticated: true }],
    [200, { authenticated: true, identity: { id: 'private@example.com' } }],
  ])('接口状态 %s 或无合法身份时继续匿名发送', async (status, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })));
    const sdk = sdkHarness();
    startAnalytics(settings, sdk.load)!.enterScene(experienceScenarios[0]);
    await vi.waitFor(() => expect(sdk.sent).toHaveLength(1));
    expect(sdk.config()).toMatchObject({ person_profiles: 'never', bootstrap: { isIdentifiedID: false } });
    const clean = sdk.clean(sdk.sent[0]);
    expect(clean?.properties.distinct_id).toBe(clean?.properties.visitor_id);
    expect(clean?.properties.$process_person_profile).toBe(false);
  });

  it('未配置身份接口的普通本地运行不发身份请求', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const sdk = sdkHarness();
    const { identityEndpoint: _endpoint, ...anonymous } = settings;
    startAnalytics(anonymous, sdk.load)!.enterScene(experienceScenarios[0]);
    await vi.waitFor(() => expect(sdk.sent).toHaveLength(1));
    expect(request).not.toHaveBeenCalled();
    expect(sdk.config()).toMatchObject({ person_profiles: 'never' });
  });

  it('网络异常只回退匿名，不阻止场景埋点', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('unavailable')));
    const sdk = sdkHarness();
    startAnalytics(settings, sdk.load)!.enterScene(experienceScenarios[0]);
    await vi.waitFor(() => expect(sdk.sent).toHaveLength(1));
    expect(sdk.config()).toMatchObject({ person_profiles: 'never' });
  });

  it('身份请求超时会取消请求并回退匿名', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    })));
    const sdk = sdkHarness();
    startAnalytics(settings, sdk.load)!.enterScene(experienceScenarios[0]);
    controller.abort();
    await vi.waitFor(() => expect(sdk.sent).toHaveLength(1));
    expect(timeout).toHaveBeenCalledWith(1500);
    expect(sdk.config()).toMatchObject({ person_profiles: 'never' });
  });

  it('身份返回前离开时先匿名发送，迟到身份不会让同页后续事件切换账号', async () => {
    let resolveIdentity!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveIdentity = resolve; })));
    const original = Object.getOwnPropertyDescriptor(navigator, 'sendBeacon');
    const beacons: Blob[] = [];
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: (_url: string, body: Blob) => {
      beacons.push(body); return true;
    } });
    try {
      const sdk = sdkHarness();
      const analytics = startAnalytics(settings, sdk.load)!;
      analytics.enterScene(experienceScenarios[0]);
      analytics.flush();
      analytics.consoleClick(experienceScenarios[0]);
      resolveIdentity(Response.json({ authenticated: true, identity: { id: 'sso:late-account' } }));
      await vi.waitFor(() => expect(sdk.sent).toHaveLength(1));
      const initial = JSON.parse(await beacons[0].text()).batch[0];
      const later = sdk.clean(sdk.sent[0]);
      expect(initial.properties.distinct_id).toBe(initial.properties.visitor_id);
      expect(later?.properties.distinct_id).toBe(initial.properties.distinct_id);
      expect(later?.properties.$process_person_profile).toBe(false);
      expect(sdk.config()).toMatchObject({ person_profiles: 'never' });
    } finally {
      if (original) Object.defineProperty(navigator, 'sendBeacon', original);
      else Reflect.deleteProperty(navigator, 'sendBeacon');
    }
  });
});

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
