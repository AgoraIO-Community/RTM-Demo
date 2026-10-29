import { gunzipSync } from 'node:zlib';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const base = process.env.E2E_BASE_PATH ?? '/';
const path = (value = '') => `${base}${value.replace(/^\//, '')}`;
type Event = { event: string; properties: Record<string, unknown> };
async function configure(context: BrowserContext) {
  const events: Event[] = [];
  await context.route('**/__test_ingest/**', async route => {
    const buffer = route.request().postDataBuffer();
    if (buffer) {
      const text = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer).toString() : buffer.toString();
      const payload = text.startsWith('data=')
        ? JSON.parse(Buffer.from(new URLSearchParams(text).get('data')!, 'base64').toString()) : JSON.parse(text);
      events.push(...(Array.isArray(payload) ? payload : payload.batch ?? [payload]));
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":1}' });
  });
  await context.route(/https:\/\/[^/]*posthog\.com\//, route => route.abort());
  await context.route('https://console.shengwang.cn/**', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<title>测试外链</title>',
  }));
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.assign(window, { __ENV__: {
      appId: '00000000000000000000000000000000',
      analytics: {
        enabled: true, environment: 'prod', site: 'cn', projectToken: 'phc_e2e_placeholder',
        apiHost: `${location.origin}/__test_ingest`,
      },
    } });
  });
  return { events };
}

async function clickConsole(page: Page) {
  if (await page.getByRole('complementary', { name: '体验路径' }).getAttribute('data-collapsed') === 'true') {
    await page.getByRole('button', { name: '体验路径', exact: true }).click();
  }
  const [popup] = await Promise.all([
    page.waitForEvent('popup'), page.getByRole('link', { name: '前往 Console 创建项目' }).click(),
  ]);
  await popup.close();
}

test('短入口、刷新与场景切换保留公共路径和 PostHog 来源', async ({ context, page }) => {
  const { events } = await configure(context);
  await page.goto(`${path()}?utm_source=website&utm_medium=rtm_hero&token=secret-value#secret-hash`);
  await expect(page).toHaveURL(new RegExp(`${path('social/voice-room')}\\?utm_source=website`));
  await expect.poll(() => events.filter(event => event.event === 'lab_enter').length, { timeout: 10_000 }).toBe(1);
  expect(await page.locator('meta[name="rtm-demo-base"]').getAttribute('content')).toBe(base);
  const mainPath = await page.locator('script[type="module"][src]').last().getAttribute('src');
  expect(mainPath).toBe(path('src/app/main.tsx'));
  expect(JSON.stringify(events)).not.toMatch(/secret-value|secret-hash|\$current_url|\$referrer/);

  await page.reload();
  await expect(page.getByRole('link', { name: '新开听众页' })).toBeVisible();
  await page.getByRole('link', { name: '1V1呼叫邀请', exact: true }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:4173${path('social/one-to-one-call')}`);
  await expect.poll(() => events.filter(event => event.event === 'scene_switch').length, { timeout: 10_000 }).toBe(1);
  await clickConsole(page);
  await expect.poll(() => events.filter(event => event.event === 'console_click').length).toBe(1);
  expect(events.every(event => event.properties.utm_source === 'website' && event.properties.utm_medium === 'rtm_hero')).toBe(true);
  const conversion = events.find(event => event.event === 'console_click');
  expect(conversion?.properties).toMatchObject({
    utm_source: 'website', utm_medium: 'rtm_hero', environment: 'prod',
  });
});

test('语聊房身份 URL、新开听众页、离房 URL 均保留公共前缀', async ({ context, page }) => {
  const { events } = await configure(context);
  await page.goto(path('social/voice-room'));
  await expect(page.getByRole('link', { name: '新开听众页' })).toHaveAttribute('href', path('social/voice-room'));
  await page.getByLabel('房间标题').fill('子路径测试房间');
  await page.getByLabel('房主昵称').fill('私密测试昵称');
  await page.getByRole('button', { name: '创建并进入', exact: true }).click();
  await expect(page.getByLabel('房主语聊房')).toBeVisible();
  await expect(page).toHaveURL(/[?&]data=/);
  expect(new URL(page.url()).pathname).toBe(path('social/voice-room'));
  expect([...new URL(page.url()).searchParams.keys()]).toEqual(['data']);
  await expect.poll(() => events.some(event => event.event === 'task_complete'), { timeout: 10_000 }).toBe(true);
  const current = page.url();
  await Promise.all([
    page.waitForEvent('load'), page.getByRole('link', { name: '语聊房', exact: true }).click(),
  ]);
  await expect(page).toHaveURL(current);
  await expect(page.getByLabel('房主语聊房')).toBeVisible();
  await page.getByRole('button', { name: '暂时离开', exact: true }).click();
  await expect(page.getByRole('link', { name: '新开听众页' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(path('social/voice-room'));
  expect(JSON.stringify(events)).not.toMatch(/私密测试昵称|子路径测试房间|\?data=/);
});

test('1V1 新开体验页和刷新使用同一公共路径', async ({ context, page }) => {
  await configure(context);
  await page.goto(path('social/one-to-one-call'));
  const link = page.getByRole('link', { name: '新开体验页' });
  await expect(link).toHaveAttribute('href', path('social/one-to-one-call'));
  const [peer] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  await expect(peer).toHaveURL(`http://127.0.0.1:4173${path('social/one-to-one-call')}`);
  await peer.reload();
  await expect(peer.getByTestId('one-to-one-call-workbench')).toBeVisible();
  await peer.close();
});

test('浏览器 Token 请求保留前缀并校验签发结果', async ({ context, page }) => {
  await configure(context);
  const requests: string[] = [];
  await page.route('**/api/token', async route => {
    requests.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...route.request().postDataJSON(), token: 'fixture-short-lived-token', expiresAt: Date.now() + 60_000,
    }) });
  });
  await page.goto(path('social/voice-room'));
  const token = await page.evaluate(async modulePath => {
    const { getAgoraToken } = await import(modulePath);
    return getAgoraToken({ service: 'rtm', appId: 'fixture-app', userId: 'fixture-user' }, { mode: 'token' });
  }, path('src/shared/utils/token.ts'));
  expect(token).toBe('fixture-short-lived-token');
  expect(requests).toEqual([path('api/token')]);
});
