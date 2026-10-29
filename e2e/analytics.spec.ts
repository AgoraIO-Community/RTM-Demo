import { gunzipSync } from 'node:zlib';
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

interface CapturedEvent { event: string; properties: Record<string, unknown> }

function decode(request: Request): CapturedEvent[] {
  const body = request.postDataBuffer();
  if (!body) return [];
  const raw = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body).toString() : body.toString();
  const value = raw.startsWith('data=')
    ? JSON.parse(Buffer.from(new URLSearchParams(raw).get('data')!, 'base64').toString())
    : JSON.parse(raw);
  return Array.isArray(value) ? value : value.batch ?? [value];
}

async function installAnalytics(context: BrowserContext, enabled = true, environment?: 'local' | 'prod') {
  const events: CapturedEvent[] = [];
  const requests: string[] = [];
  const referrers: string[] = [];
  await context.route('**/__test_ingest/**', async route => {
    requests.push(route.request().url());
    referrers.push(route.request().headers().referer ?? '');
    events.push(...decode(route.request()));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":1}' });
  });
  // Never contact a real analytics project, including accidental default-host requests.
  await context.route(/https:\/\/[^/]*posthog\.com\//, route => route.abort());
  await context.route(/https:\/\/(console\.shengwang\.cn|doc\.shengwang\.cn|github\.com)\//,
    route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>测试外链</title>' }));
  await context.addInitScript(({ enabled, environment }) => {
    // PostHog excludes webdriver traffic. Exercise human events without disabling
    // the production bot filter or contacting the real ingestion service.
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.assign(window, { __ENV__: {
      appId: '00000000000000000000000000000000',
      analytics: { enabled, environment, projectToken: 'phc_e2e_placeholder', apiHost: `${location.origin}/__test_ingest`, site: 'cn' },
    } });
  }, { enabled, environment });
  return { events, requests, referrers };
}

async function showExperience(page: Page) {
  const panel = page.getByRole('complementary', { name: '体验路径' });
  if (await panel.getAttribute('data-collapsed') === 'true') {
    await page.getByRole('button', { name: '体验路径', exact: true }).click();
  }
}

async function openResource(page: Page, name: string) {
  await showExperience(page);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name, exact: true }).click(),
  ]);
  await popup.close();
}

test('来源跨根跳转、刷新和整页场景切换保留，SDK 最终负载不带身份 URL', async ({ context, page }) => {
  const { events, requests, referrers } = await installAnalytics(context);
  await page.goto('/?utm_source=website&utm_medium=rtm_hero&nickname=secret-input#secret-fragment');
  await expect(page).toHaveURL(/\/social\/voice-room\?utm_source=website/);
  await expect.poll(() => events.filter(event => event.event === 'lab_enter').length).toBe(1);
  const first = events.find(event => event.event === 'lab_enter')!;
  expect(first.properties).toMatchObject({ utm_source: 'website', utm_medium: 'rtm_hero', landing_scene: 'voice-room' });
  await openResource(page, '产品简介');
  await expect.poll(() => events.filter(event => event.event === 'doc_click').length).toBe(1);

  await page.reload();
  await expect(page.getByRole('link', { name: '新开听众页' })).toBeVisible();
  expect(events.filter(event => event.event === 'lab_enter')).toHaveLength(1);
  await page.getByRole('link', { name: '1V1呼叫邀请', exact: true }).click();
  await expect(page).toHaveURL(/\/social\/one-to-one-call$/);
  await expect.poll(() => events.filter(event => event.event === 'scene_switch').length).toBe(1);
  const switched = events.find(event => event.event === 'scene_switch')!;
  expect(switched.properties).toMatchObject({
    from_scene: 'voice-room', to_scene: 'one-to-one-call',
    lab_session_id: first.properties.lab_session_id, utm_source: 'website', utm_medium: 'rtm_hero',
  });
  await openResource(page, '前往 Console 创建项目');
  await expect.poll(() => events.filter(event => event.event === 'console_click').length).toBe(1);
  expect(events.find(event => event.event === 'console_click')?.properties).toMatchObject({ tasks_done: 0, task_total: 4 });
  expect(requests.every(url => new URL(url).pathname.includes('/__test_ingest/'))).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/secret|nickname|\$current_url|\$referrer|\$initial|\$set|\$ip/);
  expect(events.every(event => event.properties.distinct_id === first.properties.visitor_id)).toBe(true);
  expect(events.every(event => event.properties.environment === 'local')).toBe(true);
  expect(referrers.every(value => value === '' || value === 'http://127.0.0.1:4173/')).toBe(true);
});

test('真实体验进度产生任务事件，刷新去重，资源链接与双标签页各自计数', async ({ context, page }) => {
  const { events } = await installAnalytics(context);
  await page.goto('/social/voice-room');
  await page.getByLabel('房间标题').fill('隐私测试房间');
  await page.getByLabel('房主昵称').fill('隐私测试昵称');
  await page.getByRole('button', { name: '创建并进入', exact: true }).click();
  await expect(page.getByLabel('房主语聊房')).toBeVisible();
  await expect.poll(() => events.filter(event => event.event === 'task_complete').length).toBe(1);
  expect(events.find(event => event.event === 'task_complete')?.properties).toMatchObject({ task_id: 'connection' });
  expect(events.find(event => event.event === 'task_complete')?.properties).not.toHaveProperty('task_index');
  const session = events.find(event => event.event === 'lab_enter')!.properties.lab_session_id;
  await openResource(page, '前往 Console 创建项目');
  await expect.poll(() => events.filter(event => event.event === 'console_click').length).toBe(1);
  expect(events.find(event => event.event === 'console_click')?.properties.tasks_done).toBe(1);
  await page.reload();
  await expect(page.getByLabel('房主语聊房')).toBeVisible();
  await showExperience(page);
  // A refreshed business page can reset progress; analytics must report the
  // visible progress, rather than its historical task deduplication collection.
  const displayedDone = Number(await page.getByRole('progressbar', { name: '场景任务完成进度' }).getAttribute('aria-valuenow'));
  await openResource(page, '前往 Console 创建项目');
  await expect.poll(() => events.filter(event => event.event === 'console_click').length).toBe(2);
  expect(events.filter(event => event.event === 'task_complete')).toHaveLength(1);
  expect(events.filter(event => event.event === 'console_click')[1].properties.tasks_done).toBe(displayedDone);

  for (const label of ['产品简介', '最佳实践', 'API参考', 'Demo 源码']) await openResource(page, label);
  await expect.poll(() => events.filter(event => event.event === 'doc_click').length).toBe(4);
  expect(events.filter(event => event.event === 'doc_click').map(event => event.properties.link_type))
    .toEqual(['overview', 'practice', 'api', 'source']);

  const peer = await context.newPage();
  await peer.goto('/social/voice-room');
  await expect.poll(() => events.filter(event => event.event === 'lab_enter').length).toBe(2);
  const entries = events.filter(event => event.event === 'lab_enter');
  expect(entries[1].properties.lab_session_id).not.toBe(session);
  expect(entries[1].properties.visitor_id).toBe(entries[0].properties.visitor_id);
  expect(entries[0].properties).toMatchObject({ utm_source: 'direct', utm_medium: 'none' });
  expect(JSON.stringify(events)).not.toMatch(/隐私测试|\$current_url|\$set|nickname|roomId/);
  await peer.close();
});

test('明确禁用时不加载 PostHog，不写埋点存储或发送请求', async ({ context, page }) => {
  const { requests } = await installAnalytics(context, false);
  const sdkRequests: string[] = [];
  page.on('request', request => { if (/posthog-js|module\.no-external/.test(request.url())) sdkRequests.push(request.url()); });
  await page.goto('/social/voice-room');
  await openResource(page, '前往 Console 创建项目');
  expect(requests).toEqual([]);
  expect(sdkRequests).toEqual([]);
  expect(await page.evaluate(() => [
    localStorage.getItem('rtm_lab_visitor_v1:local'), sessionStorage.getItem('rtm_lab_session_v1:local'),
  ])).toEqual([null, null]);
});

for (const environment of ['local', 'prod'] as const) {
  test(`同一项目上报 ${environment} 环境，最终 SDK 负载保留环境且刷新不重复进入`, async ({ context, page }) => {
    const { events } = await installAnalytics(context, true, environment);
    await page.goto('/social/voice-room');
    await openResource(page, '前往 Console 创建项目');
    await expect.poll(() => events.filter(event => event.event === 'lab_enter').length).toBe(1);
    await expect.poll(() => events.filter(event => event.event === 'console_click').length).toBe(1);
    await page.reload();
    await openResource(page, '产品简介');
    await expect.poll(() => events.filter(event => event.event === 'doc_click').length).toBe(1);
    expect(events.filter(event => event.event === 'lab_enter')).toHaveLength(1);
    expect(events.every(event => event.properties.environment === environment)).toBe(true);
    expect(events.every(event => event.properties.token === 'phc_e2e_placeholder')).toBe(true);
  });
}

test('内部新开页继承会话与来源，正常关闭后清理，刷新不会重新计访问', async ({ context, page }) => {
  const { events } = await installAnalytics(context);
  await page.goto('/social/voice-room?utm_source=website&utm_medium=rtm_hero');
  await expect.poll(() => events.filter(event => event.event === 'lab_enter').length).toBe(1);
  const sid = events[0].properties.lab_session_id;
  const [peer] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link', { name: '新开听众页' }).click()]);
  await expect(peer).toHaveURL('http://127.0.0.1:4173/social/voice-room');
  await openResource(peer, '产品简介');
  await expect.poll(() => events.filter(event => event.event === 'doc_click').length).toBe(1);
  expect(events.at(-1)?.properties).toMatchObject({ lab_session_id: sid, utm_source: 'website', utm_medium: 'rtm_hero' });
  for (const tab of [page, peer]) {
    if (await tab.getByRole('complementary', { name: '体验路径' }).getAttribute('data-collapsed') === 'false'
      && (tab.viewportSize()?.width ?? 1440) < 1024) {
      await tab.getByRole('button', { name: '体验路径', exact: true }).click();
    }
  }
  await page.getByLabel('房间标题').fill('共享会话左端');
  await peer.getByLabel('房间标题').fill('共享会话右端');
  await Promise.all([
    page.getByRole('button', { name: '创建并进入', exact: true }).click(),
    peer.getByRole('button', { name: '创建并进入', exact: true }).click(),
  ]);
  await expect(page.getByLabel('房主语聊房')).toBeVisible();
  await expect(peer.getByLabel('房主语聊房')).toBeVisible();
  await expect.poll(() => events.filter(event => event.event === 'task_complete').length).toBe(1);
  await page.reload();
  await openResource(page, 'API参考');
  await expect.poll(() => events.filter(event => event.event === 'doc_click').length).toBe(2);
  expect(events.filter(event => event.event === 'lab_enter')).toHaveLength(1);
  expect(events.some(event => event.event === 'scene_switch' || event.event === 'scene_enter')).toBe(false);
  await page.close();
  await openResource(peer, '最佳实践');
  await expect.poll(() => events.filter(event => event.event === 'doc_click').length).toBe(3);
  expect(events.at(-1)?.properties.lab_session_id).toBe(sid);

  await context.route('**/__analytics_observer', route => route.fulfill({ contentType: 'text/html', body: '<title>观察存储</title>' }));
  const observer = await context.newPage();
  await observer.goto('/__analytics_observer');
  await peer.close();
  await expect.poll(() => observer.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('rtm_lab_'))))
    .toEqual(['rtm_lab_visitor_v1:local']);
});

test('不同入口会话并存，24 小时无上报在恢复活跃时才切换会话', async ({ context, page }) => {
  await page.clock.setFixedTime(Date.now());
  const { events } = await installAnalytics(context);
  await page.goto('/social/voice-room?utm_source=website&utm_medium=rtm_hero');
  await expect.poll(() => events.filter(event => event.event === 'lab_enter').length).toBe(1);
  const sidA = events[0].properties.lab_session_id;
  const b = await context.newPage();
  await b.goto('/social/one-to-one-call?utm_source=docs&utm_medium=scenario_doc');
  await openResource(b, '产品简介');
  await expect.poll(() => events.filter(event => event.event === 'lab_enter').length).toBe(2);
  const sidB = events.find(event => event.event === 'lab_enter' && event.properties.utm_source === 'docs')!.properties.lab_session_id;
  expect(sidA).not.toBe(sidB);
  await openResource(page, 'API参考');
  await expect.poll(() => events.filter(event => event.event === 'doc_click' && event.properties.lab_session_id === sidA).length).toBe(1);
  await page.clock.setFixedTime(Date.now() + 24 * 60 * 60 * 1000 + 1000);
  expect(events.filter(event => event.event === 'lab_enter')).toHaveLength(2);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => events.filter(event => event.event === 'lab_enter').length).toBe(3);
  const newEntry = events.filter(event => event.event === 'lab_enter').at(-1)!;
  expect(newEntry.properties.lab_session_id).not.toBe(sidA);
  expect(newEntry.properties).toMatchObject({ utm_source: 'website', utm_medium: 'rtm_hero' });
});
