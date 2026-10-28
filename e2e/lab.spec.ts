/**
 * 实验室端到端测试。
 *
 * ## 用占位 App ID，刻意不验证真实连通性
 *
 * 这里注入假 App ID，`e2e` mode 使用无网络的页面会话/RTC adapter。e2e 要验证的是外壳、
 * 路由、渲染与交互，而不是 Agora 后端可用性。把真实凭证塞进 e2e 会让测试在
 * 没网、凭证过期、配额用尽时无故变红，而这些都不是代码问题。
 *
 * 完整真实链路仍需有效凭证**人工验收**（见票 25）。
 *
 * ## 因此「控制台无报错」需要一份白名单
 *
 * 假 App ID 必然引发登录失败的报错 —— 那是预期行为，不是缺陷。所以断言的是
 * **没有未预期的报错**：先滤掉可归因于「故意用了假凭证」的那一类，剩下的必须为空。
 * 白名单只列失败原因的特征串，不做宽泛匹配，否则真实的渲染错误会被一起吞掉。
 */

import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { TraceEntry } from '../src/shared/timeline/traceStore';

/** 占位 App ID。32 位十六进制，形状合法但不对应任何真实项目。 */
const PLACEHOLDER_APP_ID = '00000000000000000000000000000000';

/**
 * 可归因于「故意用了假 App ID」的报错特征。
 *
 * 只匹配连接与鉴权失败这一类。**不要往这里加通用词**（如 `error`、`failed`）——
 * 那会把真实的渲染错误也滤掉，这条断言就形同虚设。
 */
const EXPECTED_NOISE = [
  // RTM 登录失败。-10003 是 INVALID_APP_ID，占位 App ID 必然走到这里。
  // 匹配具体错误码而不是 `RTM:ERROR` 前缀 —— 后者会把 RTM 的所有报错一并滤掉。
  'Error Code -10003',
  'LOGIN_ERROR',
  'INVALID_APP_ID',
  'invalid vendor key',
  'CAN_NOT_GET_GATEWAY_SERVER',
  'dynamic key expired',
  'AgoraRTMError',
  'AgoraRTCError',
  'Agora-SDK',
  // 连不上网关时的传输层噪声
  'WebSocket',
  'net::ERR_',
  'Failed to fetch',
  'ERR_CERT',
  // 假凭证下网关返回的 4xx/5xx
  'agora.io',
  'sd-rtn.com',
  // jsdom/浏览器对麦克风设备的限制（CI 无音频设备）
  'enumerateDevices',
  'NOT_SUPPORTED',
  'Permission denied',
  'NotFoundError',
  'NotAllowedError',
];

function isExpectedNoise(message: string): boolean {
  return EXPECTED_NOISE.some((pattern) => message.includes(pattern));
}

/** 开始收集控制台报错与页面异常，返回「取出未预期部分」的函数。 */
function collectErrors(page: Page): () => string[] {
  const messages: string[] = [];

  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    messages.push(`console: ${message.text()} (${location.url}:${location.lineNumber})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) messages.push(`http ${response.status()} ${response.url()}`);
  });

  return () => messages.filter((message) => !isExpectedNoise(message));
}

/** 注入占位 App ID。必须在 bundle 加载**之前**跑 —— env 快照只在启动时读一次。 */
async function withAppId(page: Page): Promise<void> {
  await page.addInitScript((appId) => {
    (window as unknown as { __ENV__: { appId: string } }).__ENV__ = { appId };
  }, PLACEHOLDER_APP_ID);
}

const LONG_TRACE_SUMMARY = '更新房间公告并同步给所有在线成员，保留完整诊断内容。'.repeat(8);
const LONG_API_NAME = 'storage.setChannelMetadataWithAVeryLongOperationNameForOverflowCoverage';
const LONG_TRACE_ERROR = '共享状态写入超时，请检查连接后重试；完整错误信息不得因固定行高而丢失。'.repeat(4);

/**
 * 只替换测试请求中的 trace 读取边界，渲染真实面板、外壳与 CSS。
 * 不给生产应用增加 fixture 入口，也不改 RTM/RTC adapter 的行为。
 */
async function withVisualTraceFixtures(page: Page): Promise<void> {
  const entries = [
    { kind: 'api', name: LONG_API_NAME, summary: LONG_TRACE_SUMMARY, durationMs: 12.345 },
    { kind: 'event', name: 'presence', eventTag: 'REMOTE_STATE_CHANGED', summary: LONG_TRACE_SUMMARY },
    { kind: 'api', name: 'rtm.publish', summary: LONG_TRACE_SUMMARY, errorCode: -11001, errorMessage: LONG_TRACE_ERROR },
    { kind: 'event', name: 'linkState' },
  ].map((entry, index) => ({ ...entry, at: 1_700_000_000_000 + index, seq: index + 1, uid: 'visual-fixture', role: 'host' }));

  await page.route('**/src/shared/timeline/useMergedTraces.ts*', async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const declaration = 'export function useMergedTraces(';
    expect(original).toContain(declaration);
    const body = original.replace(declaration, 'export function originalUseMergedTraces(')
      + `\nconst visualEntries = ${JSON.stringify(entries)};\nexport function useMergedTraces() { return visualEntries; }\n`;
    await route.fulfill({ response, body });
  });
}

/**
 * Only this ordering case substitutes the trace source. Keep the real subscription hook
 * and merge so shuffled timestamps exercise the production ordering boundary. The local
 * event appends immutable snapshots; it never calls an RTM adapter or enters a room.
 */
async function withUpdatingTraceFixtures(page: Page, initialEntries: readonly TraceEntry[]) {
  const eventName = 'e2e:timeline:append';
  await page.route('**/src/shared/timeline/useMergedTraces.ts*', async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    const declaration = 'export function useMergedTraces(';
    expect(original.split(declaration)).toHaveLength(2);
    const body = original.replace(declaration, 'export function originalUseMergedTraces(') + `
      let fixtureEntries = ${JSON.stringify(initialEntries)};
      const fixtureListeners = new Set();
      const fixtureSources = [{
        getEntries: () => fixtureEntries,
        subscribe: listener => {
          fixtureListeners.add(listener);
          return () => fixtureListeners.delete(listener);
        },
      }];
      window.addEventListener(${JSON.stringify(eventName)}, event => {
        fixtureEntries = [...fixtureEntries, ...event.detail];
        fixtureListeners.forEach(listener => listener());
      });
      export function useMergedTraces() { return originalUseMergedTraces(fixtureSources); }
    `;
    await route.fulfill({ response, body });
  });
  return async (entries: readonly TraceEntry[]) => {
    await page.evaluate(({ eventName, entries }) => {
      window.dispatchEvent(new CustomEvent(eventName, { detail: entries }));
    }, { eventName, entries });
  };
}

/**
 * 仅用于下面两个昵称刷新用例：让既有 E2E adapter 的 Metadata Map 跨刷新保留，
 * 模拟云端目录的持久性。仍由原 adapter 执行每次读写/版本检查/事件分发；
 * 不预置、不创建或替换目录，且不修改生产代码、真实 SDK 或其他测试的行为。
 */
async function withPersistentE2eMetadata(page: Page): Promise<void> {
  let cachedFixture: { body: string; headers: Record<string, string>; status: number } | undefined;
  await page.route('**/e2e/support/agora-rtm.ts*', async (route) => {
    if (cachedFixture) {
      await route.fulfill(cachedFixture);
      return;
    }
    const response = await route.fetch();
    const original = await response.text();
    if (original.includes('const E2E_METADATA_PREFIX =')) {
      cachedFixture = { body: original, headers: response.headers(), status: response.status() };
      await route.fulfill(cachedFixture);
      return;
    }
    const declaration = 'const records = new Map();';
    expect(original.split(declaration)).toHaveLength(2);
    const body = original.replace(declaration, `
      const e2eMetadataKey = 'e2e:nickname:metadata';
      const records = new Map(JSON.parse(sessionStorage.getItem(e2eMetadataKey) ?? '[]'));
      const writeRecord = records.set.bind(records);
      records.set = (key, value) => {
        const result = writeRecord(key, value);
        sessionStorage.setItem(e2eMetadataKey, JSON.stringify([...records]));
        return result;
      };
    `);
    cachedFixture = { body, headers: response.headers(), status: response.status() };
    await route.fulfill(cachedFixture);
  });
}

/** Only these chat layout cases echo publishes through the existing synthetic message event. */
async function withE2eChatEcho(page: Page): Promise<void> {
  await page.route('**/e2e/support/agora-rtm.ts*', async (route) => {
    const response = await route.fetch();
    const original = await response.text();
    if (original.includes('const E2E_BUS_NAME =')) {
      await route.fulfill({ response, body: original });
      return;
    }
    const publishMethod = /async publish\(\)\s*\{\s*\}/g;
    expect([...original.matchAll(publishMethod)]).toHaveLength(1);
    const body = original.replace(publishMethod, `async publish(channelName, message, options) {
      if (options.channelType === 'MESSAGE') emit('message', {
        timestamp: Date.now(), channelName, channelType: 'MESSAGE',
        publisher: userId, messageType: 'STRING', message,
      });
    }`);
    await route.fulfill({ response, body });
  });
}

/** 数据流在 <1280 视口默认收为窄栏；需要读取条目时先展开。 */
async function ensureTimelineExpanded(page: Page): Promise<void> {
  const toggle = page.getByTestId('timeline-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}

/** 窄屏下展开的数据流覆盖主区；回到主区操作前先收起。 */
async function ensureTimelineCollapsed(page: Page): Promise<void> {
  const toggle = page.getByTestId('timeline-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'true' && (page.viewportSize()?.width ?? 1440) <= 760) await toggle.click();
}

/** 单端入口不自动连接，导航前只需确认角色选择页已稳定渲染。 */
async function waitForPlaceholderLoginToSettle(page: Page): Promise<void> {
  await expect(page.getByTestId('voice-room-entry')).toBeVisible();
}

function audienceInviteData(roomId = 'voice-room-invite'): string {
  return Buffer.from(JSON.stringify({
    version: 2,
    nameKey: 'vrn-v1-3ClZaE065tpz4y0sNaEmKBQTaEx_QY2Fr4abald0wPc',
    roomId,
    role: 'audience',
    pageUid: null,
    nickname: null,
  })).toString('base64url');
}

/** 在浏览器外读取用户可见 URL，只核对页面身份与昵称，不读取 SDK 内部状态。 */
function readRoomIdentity(page: Page): { pageUid: string; nickname: string; role: string; roomId: string } {
  const params = new URL(page.url()).searchParams;
  expect([...params.keys()]).toEqual(['data']);
  return JSON.parse(Buffer.from(params.get('data')!, 'base64url').toString('utf8'));
}

/** 创建一个共享同源状态的 Host/Audience 双页面房间。 */
async function openTwoPartyRoom(context: BrowserContext, hostPage: Page, flow: string) {
  const roomName = `回归-${flow}-${Date.now().toString(36)}`;
  await withAppId(hostPage);
  await hostPage.goto('/social/voice-room');
  await hostPage.getByLabel('房间标题').fill(roomName);
  await hostPage.getByLabel('房主昵称').fill('小周');
  await hostPage.getByRole('button', { name: '创建并进入', exact: true }).click();
  const hostRoom = hostPage.getByLabel('房主语聊房');
  await expect(hostRoom).toBeVisible();
  await expect(hostPage.getByTestId('voice-room-loading-overlay')).toHaveCount(0);

  const audiencePage = await context.newPage();
  await withAppId(audiencePage);
  await audiencePage.goto('/social/voice-room');
  await audiencePage.getByLabel('加入的房间名称').fill(roomName);
  await audiencePage.getByLabel('观众昵称').fill('小明');
  await audiencePage.getByRole('button', { name: '加入房间', exact: true }).click();
  const audienceRoom = audiencePage.getByLabel('听众语聊房');
  await expect(audienceRoom).toBeVisible();
  await expect(audiencePage.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
  await expect(hostRoom.getByText('小明', { exact: true })).toBeVisible();
  await expect(audienceRoom.getByText('小周', { exact: true })).toBeVisible();
  return { roomName, hostRoom, audiencePage, audienceRoom };
}

/** 返回包含指定 API/Event 名称和摘要的真实数据流行。 */
async function expectTrace(page: Page, name: string, summary: string | RegExp) {
  await ensureTimelineExpanded(page);
  const row = page.getByTestId('trace-row').filter({
    has: page.locator('.lab-trace__name').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  }).filter({ hasText: summary }).first();
  await expect(row).toBeVisible();
  return row;
}

/** 双端业务回归只跑一次桌面项目；移动项目继续覆盖响应式布局。 */
function skipNonDesktop(projectName: string): void {
  test.skip(projectName !== 'desktop-chromium', '双端业务闭环由桌面 Chromium 覆盖');
}

/** Audience 选择 2 号麦并发起申请，等待 Host 收到请求。 */
async function requestSecondSeat(audienceRoom: Locator, hostRoom: Locator) {
  await audienceRoom.getByRole('button', { name: /^2 号麦位 空麦位$/ }).click();
  await expect(audienceRoom.getByRole('button', { name: '等待审批', exact: true })).toBeVisible();
  await expect(hostRoom.getByRole('button', { name: '同意小明上麦', exact: true })).toBeVisible();
}

/** Host 选择 2 号空麦并向在线听众小明发出邀请。 */
async function inviteAudienceToSecondSeat(hostRoom: Locator, audienceRoom: Locator) {
  await hostRoom.getByRole('button', { name: /^2 号麦位 空麦位$/ }).click();
  await hostRoom.getByRole('button', { name: '邀请小明上麦', exact: true }).click();
  await expect(audienceRoom.getByRole('status')).toContainText('SEAT 02');
}

test.describe('外壳与导航', () => {
  test.beforeEach(async ({ page }) => {
    await withAppId(page);
  });

  test('首页渲染，7 个一级场景 可见', async ({ page }) => {
    const unexpected = collectErrors(page);
    await page.goto('/');

    const primaryNav = page.getByRole('navigation', { name: '一级场景分类' });
    await expect(primaryNav).toBeVisible();
    await expect(primaryNav.getByRole('link')).toHaveCount(7);

    expect(unexpected()).toEqual([]);
  });

  test('根路径仍默认重定向到语聊房', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/social\/voice-room$/);
  });

  test('一级导航直接切换场景，体验路径显示对应状态', async ({ page }) => {
    const unexpected = collectErrors(page);
    await page.goto('/');
    await waitForPlaceholderLoginToSettle(page);
    await page.getByRole('link', { name: '游戏互动' }).click();
    await expect(page.getByRole('navigation', { name: '二级场景' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '游戏互动' })).toBeVisible();
    const path = page.getByRole('complementary', { name: '体验路径' });
    if (await path.getByRole('button', { name: '体验路径' }).getAttribute('aria-expanded') === 'false') {
      await path.getByRole('button', { name: '体验路径' }).click();
    }
    await expect(path.getByText('游戏互动的体验任务正在准备中。')).toBeVisible();
    expect(unexpected()).toEqual([]);
  });

  test('1V1 呼叫邀请进入真实工作台', async ({ page }) => {
    const unexpected = collectErrors(page);
    await page.goto('/');

    await waitForPlaceholderLoginToSettle(page);
    await page.getByRole('link', { name: '1V1呼叫邀请' }).click();

    await expect(page.getByTestId('one-to-one-call-workbench')).toBeVisible();
    await expect(page.getByLabel('对方呼叫 ID')).toBeVisible();
    await expect(page.getByTestId('scene-placeholder')).toHaveCount(0);

    expect(unexpected()).toEqual([]);
  });

  test('场景导航整页加载，返回也建立新页面，主题保留而面板状态重置', async ({ page }) => {
    await page.addInitScript(() => { Reflect.set(window, '__sceneDocumentId', crypto.randomUUID()); });
    await page.goto('/');
    const firstDocument = await page.evaluate(() => Reflect.get(window, '__sceneDocumentId') as string);
    const timeline = page.getByRole('complementary', { name: '时间线' });
    await expect(timeline).toBeVisible();
    await waitForPlaceholderLoginToSettle(page);
    await page.getByTestId('theme-toggle').click();
    const theme = await page.locator('html').getAttribute('data-theme');
    await ensureTimelineExpanded(page);
    await page.getByRole('button', { name: '折叠数据流' }).click();
    await page.getByRole('link', { name: '1V1呼叫邀请' }).click();
    await expect(page.getByTestId('one-to-one-call-workbench')).toBeVisible();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__sceneDocumentId'))).not.toBe(firstDocument);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme!);
    await expect(page.getByRole('navigation', { name: '一级场景分类' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: '体验路径' })).toBeVisible();
    await expect(timeline).toBeVisible();
    const callDocument = await page.evaluate(() => Reflect.get(window, '__sceneDocumentId') as string);
    const expectedTimeline = page.viewportSize()!.width < 1280 ? 'collapsed' : 'expanded';
    await expect(page.locator('.lab-workspace')).toHaveAttribute('data-timeline', expectedTimeline);
    await page.getByLabel('对方呼叫 ID').fill('call-remote02');
    await page.getByTestId('one-to-one-call-workbench').getByRole('button', { name: '发起呼叫', exact: true }).click();
    const experiencePath = page.getByRole('complementary', { name: '体验路径' });
    if (await experiencePath.getByRole('button', { name: '体验路径' }).getAttribute('aria-expanded') === 'false') {
      await experiencePath.getByRole('button', { name: '体验路径' }).click();
    }
    await expect(experiencePath.getByRole('button', { name: '发起或接收呼叫 已完成' })).toBeVisible();
    await page.getByRole('link', { name: '语聊房', exact: true }).click();
    await expect(page.getByTestId('voice-room-entry')).toBeVisible();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__sceneDocumentId'))).not.toBe(firstDocument);
    await page.goBack();
    await expect(page.getByTestId('one-to-one-call-workbench')).toBeVisible();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__sceneDocumentId'))).not.toBe(callDocument);
    await expect(page.locator('.oc-state-tag')).toHaveText('IDLE');
    if (await experiencePath.getByRole('button', { name: '体验路径' }).getAttribute('aria-expanded') === 'false') {
      await experiencePath.getByRole('button', { name: '体验路径' }).click();
    }
    await expect(experiencePath.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});

test.describe('1V1 呼叫邀请场景', () => {
  test('三页面多来电逐项处理，接听一条不清空其他邀请', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    const receiver = await context.newPage();
    const third = await context.newPage();
    for (const endpoint of [page, receiver, third]) await withAppId(endpoint);
    await Promise.all([page, receiver, third].map(endpoint => endpoint.goto('/social/one-to-one-call')));
    for (const endpoint of [page, receiver, third]) await expect(endpoint.getByTestId('one-to-one-call-workbench')).toBeVisible();
    const receiverId = (await receiver.locator('.oc-call-id code').textContent())!;
    for (const [endpoint, nickname] of [[page, '主叫甲'], [third, '主叫乙']] as const) {
      await endpoint.getByLabel('你的昵称（选填）').fill(nickname);
      await endpoint.getByLabel('对方呼叫 ID').fill(receiverId);
      await endpoint.getByTestId('one-to-one-call-workbench').getByRole('button', { name: '发起呼叫', exact: true }).click();
    }
    const first = receiver.getByRole('article', { name: '来自主叫甲的来电' });
    const second = receiver.getByRole('article', { name: '来自主叫乙的来电' });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    await first.getByRole('button', { name: '接听', exact: true }).click();
    await expect(page.getByText('音频通话中')).toBeVisible();
    await expect(receiver.getByText('音频通话中')).toBeVisible();
    await expect(second).toBeVisible();
    await expect(second.getByRole('button', { name: '接听', exact: true })).toBeDisabled();
    await second.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(third.getByText('对方已拒绝')).toBeVisible();
    await expect(receiver.getByText('音频通话中')).toBeVisible();
    await receiver.getByRole('button', { name: '挂断', exact: true }).click();
    await expect(page.getByText('通话已结束')).toBeVisible();
    await third.close();
    await receiver.close();
  });

  test('ACK发送失败时被叫等待确认并按原截止结束，媒体等待独立超时', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    const peer = await context.newPage();
    await withAppId(page);
    await withAppId(peer);
    const time = Date.now();
    await Promise.all([page.clock.install({ time }), peer.clock.install({ time })]);
    await Promise.all([page.goto('/social/one-to-one-call'), peer.goto('/social/one-to-one-call')]);
    await expect(peer.getByTestId('one-to-one-call-workbench')).toBeVisible();
    await page.evaluate(() => {
      const publish = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (data: unknown) {
        const event = data as { kind?: string; customType?: string; message?: string };
        if (event.kind === 'message' && event.customType === 'CALL_KIT_ACCEPT'
          && event.message && JSON.parse(event.message).type === 'ack') throw new Error('模拟 ACK 发布失败');
        publish.call(this, data);
      };
    });
    const peerId = (await peer.locator('.oc-call-id code').textContent())!;
    await page.getByLabel('对方呼叫 ID').fill(peerId);
    await page.getByTestId('one-to-one-call-workbench').getByRole('button', { name: '发起呼叫', exact: true }).click();
    await peer.getByRole('button', { name: '接听', exact: true }).click();
    await expect(peer.getByText('等待主叫确认接听')).toBeVisible();
    await expect(page.getByText('正在建立音频连接')).toBeVisible();
    await peer.clock.fastForward(30_000);
    await expect(peer.getByText('接听确认超时')).toBeVisible();
    await expect(peer.locator('.oc-state-tag')).toHaveText('IDLE');
    await page.clock.fastForward(15_000);
    await expect(page.getByText('音频连接超时')).toBeVisible();
    await peer.close();
  });

  test('无人接听到期后主叫显示无应答，被叫自动结束，下一次呼叫使用新 callId', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    await withAppId(page);
    const peer = await context.newPage();
    await withAppId(peer);
    const time = Date.now();
    await Promise.all([page.clock.install({ time }), peer.clock.install({ time })]);
    await Promise.all([
      page.goto('/social/one-to-one-call'), peer.goto('/social/one-to-one-call'),
    ]);
    await expect(peer.getByTestId('one-to-one-call-workbench')).toBeVisible();
    const peerId = (await peer.locator('.oc-call-id code').textContent())!;
    await page.getByLabel('对方呼叫 ID').fill(peerId);
    await page.getByTestId('one-to-one-call-workbench').getByRole('button', { name: '发起呼叫', exact: true }).click();
    await expect(peer.getByRole('button', { name: '接听' })).toBeVisible();
    const invite = await expectTrace(page, 'rtm.publish', /CALL_KIT_INVITE/);
    const firstCall = (await invite.textContent())!.match(/callId=([^\s]+)/)![1];
    await Promise.all([page.clock.fastForward(30_000), peer.clock.fastForward(30_000)]);
    await expect(page.getByText('对方无应答')).toBeVisible();
    await expect(peer.getByText('邀请已过期')).toBeVisible();
    await expect(page.locator('.oc-state-tag')).toHaveText('IDLE');
    await expect(peer.locator('.oc-state-tag')).toHaveText('IDLE');
    await page.getByTestId('one-to-one-call-workbench').getByRole('button', { name: '发起呼叫', exact: true }).click();
    await expect(peer.getByRole('button', { name: '接听' })).toBeVisible();
    const nextInvite = await expectTrace(page, 'rtm.publish', /CALL_KIT_INVITE/);
    expect((await nextInvite.textContent())!.match(/callId=([^\s]+)/)![1]).not.toBe(firstCall);
    await peer.close();
  });

  test('双页面完成邀请、ACK、媒体状态、静音与挂断', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    const unexpectedA = collectErrors(page);
    await withAppId(page);
    const peer = await context.newPage();
    const unexpectedB = collectErrors(peer);
    await withAppId(peer);
    await Promise.all([
      page.goto('/social/one-to-one-call'),
      peer.goto('/social/one-to-one-call'),
    ]);
    await Promise.all([
      expect(page.getByTestId('one-to-one-call-workbench')).toBeVisible(),
      expect(peer.getByTestId('one-to-one-call-workbench')).toBeVisible(),
    ]);

    const peerId = (await peer.locator('.oc-call-id code').textContent())!;
    await page.getByLabel('对方呼叫 ID').fill(peerId);
    await page.getByTestId('one-to-one-call-workbench').getByRole('button', { name: '发起呼叫', exact: true }).click();
    await expect(peer.getByRole('button', { name: '接听' })).toBeVisible();
    await expect(page.getByText('对方正在响铃')).toBeVisible();
    await expect(page.getByRole('button', { name: '发起或接收呼叫 已完成' })).toBeVisible();
    await expect(peer.getByRole('button', { name: '发起或接收呼叫 已完成' })).toBeVisible();
    await expectTrace(page, 'rtm.publish', /CALL_KIT_INVITE/);
    await expectTrace(peer, 'message', /CALL_KIT_INVITE .*已消费/);
    await expect(peer.getByTestId('trace-row').filter({ hasText: 'rtm.publish' })).toHaveCount(0);

    await peer.getByRole('button', { name: '接听' }).click();
    await expect(page.getByText('音频通话中')).toBeVisible();
    await expect(peer.getByText('音频通话中')).toBeVisible();
    await expect(page.getByRole('button', { name: '响应呼叫邀请 已完成' })).toBeVisible();
    await expect(peer.getByRole('button', { name: '响应呼叫邀请 已完成' })).toBeVisible();
    await expectTrace(peer, 'rtm.publish', /CALL_KIT_ACCEPT .*type=accepted/);
    await expectTrace(page, 'rtm.publish', /CALL_KIT_ACCEPT .*type=ack/);
    await expectTrace(peer, 'message', /CALL_KIT_ACCEPT .*type=ack .*已消费/);
    await peer.getByRole('button', { name: '关闭麦克风' }).click();
    await expect(peer.getByRole('button', { name: '打开麦克风' })).toBeVisible();
    await peer.getByRole('button', { name: '挂断' }).click();
    await expect(peer.getByText('通话已结束')).toBeVisible();
    await expect(page.getByText('通话已结束')).toBeVisible();
    await expect(page.getByTestId('trace-row').filter({ hasText: 'CALL_KIT_END' })).toHaveCount(0);
    await expect(peer.getByTestId('trace-row').filter({ hasText: 'CALL_KIT_END' })).toHaveCount(0);

    await expect(page.locator('.oc-state-tag')).toHaveText('IDLE');
    await expect(peer.locator('.oc-state-tag')).toHaveText('IDLE');
    await page.getByTestId('one-to-one-call-workbench').getByRole('button', { name: '发起呼叫', exact: true }).click();
    await expect(peer.getByRole('button', { name: '接听' })).toBeVisible();
    await peer.getByRole('button', { name: '接听' }).click();
    await expect(page.getByText('音频通话中')).toBeVisible();
    await expect(peer.getByText('音频通话中')).toBeVisible();
    await expect(peer.getByRole('button', { name: '关闭麦克风' })).toBeVisible();
    await peer.getByRole('button', { name: '挂断' }).click();
    await expect(page.getByText('通话已结束')).toBeVisible();
    await expect(peer.getByText('通话已结束')).toBeVisible();

    expect(unexpectedA()).toEqual([]);
    expect(unexpectedB()).toEqual([]);
    await peer.close();
  });

  test('未接听直接取消只完成结束任务，不完成响应邀请', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    await withAppId(page);
    const peer = await context.newPage();
    await withAppId(peer);
    await Promise.all([
      page.goto('/social/one-to-one-call'),
      peer.goto('/social/one-to-one-call'),
    ]);
    const peerId = (await peer.locator('.oc-call-id code').textContent())!;
    await page.getByLabel('对方呼叫 ID').fill(peerId);
    await page.getByTestId('one-to-one-call-workbench').getByRole('button', { name: '发起呼叫', exact: true }).click();
    await expect(peer.getByRole('button', { name: '接听' })).toBeVisible();
    await page.getByRole('button', { name: '取消呼叫' }).click();
    for (const endpoint of [page, peer]) {
      await expect(endpoint.getByText('呼叫已取消')).toBeVisible();
      await expect(endpoint.locator('.oc-state-tag')).toHaveText('IDLE');
      await expect(endpoint.getByRole('button', { name: '响应呼叫邀请 待体验' })).toBeVisible();
      await expect(endpoint.getByRole('button', { name: '建立真实音频 待体验' })).toBeVisible();
      await expect(endpoint.getByRole('button', { name: '结束通话 已完成' })).toBeVisible();
    }
    await peer.close();
  });

  test('拒绝与取消让两端收敛到明确结果', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    await withAppId(page);
    const peer = await context.newPage();
    await withAppId(peer);
    await Promise.all([
      page.goto('/social/one-to-one-call'),
      peer.goto('/social/one-to-one-call'),
    ]);
    const pageId = (await page.locator('.oc-call-id code').textContent())!;
    const peerId = (await peer.locator('.oc-call-id code').textContent())!;

    await page.getByLabel('对方呼叫 ID').fill(peerId);
    await page.getByTestId('one-to-one-call-workbench').getByRole('button', { name: '发起呼叫', exact: true }).click();
    await peer.getByRole('button', { name: '拒绝' }).click();
    await expect(page.getByText('对方已拒绝')).toBeVisible();
    await expect(page.getByRole('button', { name: '响应呼叫邀请 已完成' })).toBeVisible();
    await expect(peer.getByRole('button', { name: '响应呼叫邀请 已完成' })).toBeVisible();
    await expect(page.locator('.oc-state-tag')).toHaveText('IDLE');
    await expect(peer.locator('.oc-state-tag')).toHaveText('IDLE');

    await peer.getByLabel('对方呼叫 ID').fill(pageId);
    await peer.getByTestId('one-to-one-call-workbench').getByRole('button', { name: '发起呼叫', exact: true }).click();
    await expect(page.getByRole('button', { name: '接听' })).toBeVisible();
    await peer.getByRole('button', { name: '取消呼叫' }).click();
    await expect(page.getByText('呼叫已取消')).toBeVisible();
    await expect(peer.getByText('呼叫已取消')).toBeVisible();
    await expect(page.locator('.oc-state-tag')).toHaveText('IDLE');
    await expect(peer.locator('.oc-state-tag')).toHaveText('IDLE');
    await page.getByTestId('one-to-one-call-workbench').getByRole('button', { name: '发起呼叫', exact: true }).click();
    await expect(peer.getByRole('button', { name: '接听' })).toBeVisible();
    await peer.getByRole('button', { name: '拒绝' }).click();
    await expect(page.getByText('对方已拒绝')).toBeVisible();
    await peer.close();
  });
});

test.describe('语聊房场景', () => {
  test.beforeEach(async ({ page }) => {
    await withAppId(page);
  });

  test('首次打开只显示 Host/Audience 选择，不创建隐藏双端', async ({ page }) => {
    const unexpected = collectErrors(page);
    await page.goto('/social/voice-room');

    await expect(page.getByTestId('voice-room-entry')).toBeVisible();
    await expect(page.getByLabel('房间标题')).toBeVisible();
    await expect(page.getByLabel('房主昵称')).toHaveValue('');
    await expect(page.getByLabel('观众昵称')).toHaveValue('');
    await expect(page.getByLabel('房主昵称')).not.toHaveAttribute('required');
    await expect(page.getByLabel('观众昵称')).not.toHaveAttribute('required');
    await expect(page.getByText('在声音里，相遇', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('voice-room-entry').getByRole('heading', { name: '语聊房：麦位与房内互动' })).toBeVisible();
    await expect(page.getByTestId('voice-room-entry').getByText('CREATE · HOST')).toBeVisible();
    await expect(page.getByLabel('加入的房间名称')).toBeVisible();
    await expect(page.getByText('通过邀请链接加入', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('房主语聊房')).toHaveCount(0);
    await expect(page.getByLabel('听众语聊房')).toHaveCount(0);

    expect(unexpected()).toEqual([]);
  });

  test('Host/Audience 入口在定高卡片内可滚动到达', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 577 });
    await page.goto('/social/voice-room');
    await expect(page.getByTestId('voice-room-entry')).toBeVisible();

    const entry = page.getByTestId('voice-room-entry');
    const audiencePanel = page.locator('.vr-entry__choice-panel').nth(1);
    await expect(audiencePanel).toBeAttached();
    const dimensions = await entry.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    const entryBox = await entry.boundingBox();
    expect(dimensions.clientHeight).toBeLessThanOrEqual(520);
    expect(dimensions.scrollHeight).toBeGreaterThanOrEqual(dimensions.clientHeight);
    // 左右栏各自 padding-top，不与主区卡片强制等高；卡片必须完整落在视口内。
    expect(entryBox!.y + entryBox!.height).toBeLessThanOrEqual(577);
    await audiencePanel.scrollIntoViewIfNeeded();
    await expect(page.getByLabel('加入的房间名称')).toBeVisible();
    for (const target of [
      page.getByRole('button', { name: '创建并进入', exact: true }),
      page.getByRole('button', { name: '加入房间', exact: true }),
    ]) {
      await target.scrollIntoViewIfNeeded();
      await expect(target).toBeInViewport({ ratio: 1 });
    }
    await entry.evaluate(element => element.scrollTo({ top: 0 }));
    await expect(entry.getByRole('heading', { name: '语聊房：麦位与房内互动' })).toBeInViewport({ ratio: 1 });
    await expect(page.getByText('通过邀请链接加入', { exact: true })).toHaveCount(0);
    await expect(page.getByText('本机最近房间')).toHaveCount(0);
  });

  test('Host 创建时先挂载房间壳与 loading 蒙层，订阅后移除蒙层', async ({ page }) => {
    await page.goto('/social/voice-room');

    await page.getByLabel('房间标题').fill('E2E 房间');
    await page.getByRole('button', { name: '创建并进入' }).click();
    await expect(page.getByLabel('房主语聊房')).toBeVisible();
    await expect(page.getByTestId('voice-room-loading-overlay')).toContainText('正在准备房间…');
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    await expect(page.getByLabel('房主语聊房').getByText('HOST', { exact: true })).toBeVisible();
    await expect(page.getByLabel('房主语聊房').locator('.vr-single__header')).not.toContainText(/host-/);
    await expect(page.getByTestId('voice-room-entry')).toHaveCount(0);

    const initializeTrace = await expectTrace(page, 'storage.setChannelMetadata', /hostUserId=Host, announcement=空/);
    await expect(initializeTrace).not.toContainText('initialize');
    await expect(initializeTrace).toContainText('forcedMutedUserIds=空');

    const controlBounds = await page.locator('.vr-single__panel .vr-single__control-group').evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: Math.round(rect.left), right: Math.round(rect.right) };
      }),
    );
    expect(new Set(controlBounds.map(({ left }) => left)).size).toBe(1);
    expect(new Set(controlBounds.map(({ right }) => right)).size).toBe(1);

    const room = page.getByLabel('房主语聊房');
    await expect(room.getByRole('button', { name: '复制观众邀请链接' })).toHaveCount(0);
    const roomUrl = page.url();
    await page.getByRole('navigation', { name: '一级场景分类' }).getByRole('link', { name: '语聊房', exact: true }).click();
    await expect(page).toHaveURL(roomUrl);
    await expect(room).toBeVisible();
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    await expect(room.getByText('HOST', { exact: true })).toBeVisible();
  });

  test('移动端首次加载停留在页面顶部，不被公屏自动滚动带走', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await page.goto('/social/voice-room');
    await expect(page.getByTestId('voice-room-entry')).toBeVisible();

    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('choose 页仅提供名称入口，不展示邀请输入和最近房间', async ({ page }) => {
    await page.goto('/social/voice-room');
    await expect(page.getByLabel('加入的房间名称')).toBeVisible();
    await expect(page.getByText('通过邀请链接加入', { exact: true })).toHaveCount(0);
    await expect(page.getByText('暂无可加入的本地房间。')).toHaveCount(0);
    await expect(page.getByLabel('邀请链接', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '通过邀请加入', exact: true })).toHaveCount(0);
  });

  test('Audience 直达邀请 URL 不闪现 choose，成功后 URL 仍只有 data', async ({ page }) => {
    await page.goto(`/social/voice-room?data=${audienceInviteData()}`);
    await expect(page.getByLabel('听众语聊房')).toBeVisible();
    await expect(page.getByLabel('听众语聊房').getByLabel('我的上麦')).toHaveCount(0);
    const composer = page.getByLabel('听众语聊房').getByLabel('聊天内容').locator('..');
    await expect(composer.locator('button').last()).toHaveText('申请上麦');
    await expect(page.getByTestId('connection-state')).toHaveText(/CONNECTED/);
    // 应用级 listener 从 login 起记录 linkState，数据流默认展示连接事件：登录成功的那一条可见；
    // 手动「隐藏连接」后不再展示。e2e 的无网络会话只在 login 时发出这一条。
    await ensureTimelineExpanded(page);
    const timeline = page.getByRole('complementary', { name: '时间线' });
    await expect(timeline.getByText('linkState')).toHaveCount(1);
    await page.getByRole('button', { name: '隐藏连接' }).click();
    await expect(timeline.getByText('linkState')).toHaveCount(0);
    await page.waitForFunction(() => {
      const encoded = new URL(location.href).searchParams.get('data');
      if (!encoded) return false;
      const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)))) as {
        nickname?: string | null;
      };
      return typeof payload.nickname === 'string';
    });
    const identityBeforeRefresh = await page.evaluate(() => {
      const encoded = new URL(location.href).searchParams.get('data')!;
      const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)))) as {
        pageUid: string;
        nickname: string;
      };
    });
    expect(identityBeforeRefresh.nickname).toMatch(/^[A-Z][a-z]+_\d{3}$/);
    await expect(page.getByLabel('听众语聊房').locator('.vr-single__nickname')).toHaveText(identityBeforeRefresh.nickname);
    expect(await page.evaluate(() => [...new URL(location.href).searchParams.keys()])).toEqual(['data']);
    expect(await page.evaluate(() => document.querySelector('[data-testid="voice-room-entry"]') === null)).toBe(true);

    await page.reload();
    await expect(page.getByLabel('听众语聊房')).toBeVisible();
    await expect(page.getByLabel('听众语聊房').locator('.vr-single__nickname')).toHaveText(identityBeforeRefresh.nickname);
    await expect(page.getByTestId('voice-room-entry')).toHaveCount(0);
    expect(await page.evaluate(() => [...new URL(location.href).searchParams.keys()])).toEqual(['data']);
    const identityAfterRefresh = await page.evaluate(() => {
      const encoded = new URL(location.href).searchParams.get('data')!;
      const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)))) as {
        pageUid: string;
        nickname: string;
      };
    });
    expect(identityAfterRefresh).toMatchObject(identityBeforeRefresh);
  });

  test('Host 创建后 Audience 可按同名加入、退出并再次加入', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    const { roomName, hostRoom, audiencePage, audienceRoom } = await openTwoPartyRoom(context, page, '加入');
    await expectTrace(page, 'presence', /REMOTE_JOIN.*小明/);
    await expectTrace(audiencePage, 'presence', /SNAPSHOT.*小周, 小明|SNAPSHOT.*小明, 小周/);

    await audienceRoom.getByRole('button', { name: '退出房间', exact: true }).click();
    await expect(audiencePage.getByTestId('voice-room-entry')).toBeVisible();
    await expect(hostRoom.getByText('小明', { exact: true })).toHaveCount(0);
    await expectTrace(page, 'presence', /REMOTE_LEAVE/);

    await audiencePage.getByLabel('加入的房间名称').fill(roomName);
    await audiencePage.getByRole('button', { name: '加入房间', exact: true }).click();
    await expect(audienceRoom).toBeVisible();
    await expect(hostRoom.getByText('小明', { exact: true })).toBeVisible();
    await expectTrace(audiencePage, 'rtm.subscribe', /voice-room-\.\.\.-[a-z0-9]{4}/i);
  });
});

test.describe('语聊房双端业务回归', () => {
  test('公告、聊天与爱心同步到双方，并留下对应 API/Event 数据流', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    const { hostRoom, audiencePage, audienceRoom } = await openTwoPartyRoom(context, page, '消息');

    await hostRoom.getByLabel('房间公告').fill('今晚八点开始');
    await hostRoom.getByRole('button', { name: '发布', exact: true }).click();
    await expect(audienceRoom.locator('.vr-single__announcement')).toHaveText('今晚八点开始');
    await audienceRoom.getByLabel('聊天内容').fill('大家好');
    await audienceRoom.getByRole('button', { name: '发送聊天', exact: true }).click();
    await expect(hostRoom.getByTestId('voice-room-chat-feed')).toContainText('小明');
    await expect(hostRoom.getByTestId('voice-room-chat-feed')).toContainText('大家好');
    await hostRoom.getByRole('button', { name: '发送爱心消息', exact: true }).click();
    await expect(audienceRoom.getByTestId('voice-room-chat-feed')).toContainText('送出爱心');
    await expect(page.getByRole('complementary', { name: '体验路径' }).getByRole('button', { name: '发送房内消息 已完成' })).toBeVisible();
    await expect(audiencePage.getByRole('complementary', { name: '体验路径' }).getByRole('button', { name: '发送房内消息 已完成' })).toBeVisible();

    await expectTrace(page, 'storage.setChannelMetadata', /announcement=今晚八点开始/);
    await expectTrace(audiencePage, 'storage', /UPDATE.*announcement=今晚八点开始/);
    const chatPublish = await expectTrace(audiencePage, 'rtm.publish', /voice-room-\.\.\.-[a-z0-9]{4}: to ALL chat\.message/i);
    await expect(chatPublish.locator('.lab-trace__tag')).toHaveText('MESSAGE');
    await expectTrace(page, 'message', /chat\.message from 小明: 大家好/);
    await expectTrace(audiencePage, 'message', /emoji\.reaction from 小周/);
  });

  test('Audience 申请 2 号麦后 Host 拒绝，双方收到 USER 信令数据流', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    const { hostRoom, audiencePage, audienceRoom } = await openTwoPartyRoom(context, page, '申请拒绝');
    await requestSecondSeat(audienceRoom, hostRoom);
    await hostRoom.getByRole('button', { name: '拒绝小明上麦', exact: true }).click();
    await expect(audienceRoom.getByText('上麦申请被拒绝', { exact: true })).toBeVisible();
    await expect(audienceRoom.getByRole('button', { name: '申请上麦', exact: true })).toBeVisible();

    const requestPublish = await expectTrace(audiencePage, 'rtm.publish', /to 小周 seat\.request 2号麦/);
    await expect(requestPublish.locator('.lab-trace__tag')).toHaveText('USER');
    await expectTrace(page, 'message', /seat\.request 2号麦 from 小明/);
    await expectTrace(page, 'rtm.publish', /to 小明 seat\.rejected 2号麦/);
    await expectTrace(audiencePage, 'message', /seat\.rejected 2号麦 from 小周/);
  });

  test('Audience 申请获批后占用 2 号麦，并可主动下麦', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    const { hostRoom, audiencePage, audienceRoom } = await openTwoPartyRoom(context, page, '申请同意');
    await requestSecondSeat(audienceRoom, hostRoom);
    await hostRoom.getByRole('button', { name: '同意小明上麦', exact: true }).click();
    await expect(hostRoom.getByRole('button', { name: /2 号麦位 小明/ })).toBeVisible();
    await expect(audienceRoom.getByRole('button', { name: /2 号麦位 小明/ })).toBeVisible();
    await expect(page.getByRole('complementary', { name: '体验路径' }).getByRole('button', { name: '申请与审批上麦 已完成' })).toBeVisible();
    await expect(audiencePage.getByRole('complementary', { name: '体验路径' }).getByRole('button', { name: '申请与审批上麦 已完成' })).toBeVisible();
    await audienceRoom.getByRole('button', { name: '下麦', exact: true }).click();
    await expect(hostRoom.getByRole('button', { name: /^2 号麦位 空麦位$/ })).toBeVisible();
    await expect(audienceRoom.getByRole('button', { name: '申请上麦', exact: true })).toBeVisible();

    await expectTrace(page, 'storage.setChannelMetadata', /seats=2号麦 小明/);
    await expectTrace(audiencePage, 'rtm.publish', /to 小周 seat\.left 2号麦/);
    await expectTrace(page, 'message', /seat\.left 2号麦 from 小明/);
    await expectTrace(audiencePage, 'presence.removeState', /muted, microphoneError/);
  });

  test('Host 邀请 2 号麦后 Audience 拒绝，邀请卡关闭且 Host 收到反馈', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    const { hostRoom, audiencePage, audienceRoom } = await openTwoPartyRoom(context, page, '邀请拒绝');
    await inviteAudienceToSecondSeat(hostRoom, audienceRoom);
    await audienceRoom.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(audienceRoom.getByText('房主邀请你上麦', { exact: true })).toHaveCount(0);
    await expect(hostRoom.getByText('小明 拒绝了上麦邀请', { exact: true })).toBeVisible();

    await expectTrace(page, 'rtm.publish', /to 小明 seat\.invited 2号麦/);
    await expectTrace(audiencePage, 'message', /seat\.invited 2号麦 from 小周/);
    await expectTrace(audiencePage, 'rtm.publish', /to 小周 seat\.invitation\.rejected/);
    await expectTrace(page, 'message', /seat\.invitation\.rejected from 小明/);
  });

  test('Host 邀请获接受后占用 2 号麦，Audience 可再次下麦', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    const { hostRoom, audiencePage, audienceRoom } = await openTwoPartyRoom(context, page, '邀请接受');
    await inviteAudienceToSecondSeat(hostRoom, audienceRoom);
    await audienceRoom.getByRole('button', { name: '接受', exact: true }).click();
    await expect(hostRoom.getByRole('button', { name: /2 号麦位 小明/ })).toBeVisible();
    await expect(audienceRoom.getByRole('button', { name: /2 号麦位 小明/ })).toBeVisible();
    await audienceRoom.getByRole('button', { name: '下麦', exact: true }).click();
    await expect(hostRoom.getByRole('button', { name: /^2 号麦位 空麦位$/ })).toBeVisible();

    await expectTrace(audiencePage, 'rtm.publish', /to 小周 seat\.invitation\.accepted 2号麦/);
    await expectTrace(page, 'message', /seat\.invitation\.accepted 2号麦 from 小明/);
    await expectTrace(page, 'storage.setChannelMetadata', /seats=2号麦 空/);
  });

  test('Host 可对在麦 Audience 强制静音、解除静音并强制下麦', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    const { hostRoom, audiencePage, audienceRoom } = await openTwoPartyRoom(context, page, '麦控');
    await requestSecondSeat(audienceRoom, hostRoom);
    await hostRoom.getByRole('button', { name: '同意小明上麦', exact: true }).click();
    const occupiedSeat = hostRoom.getByRole('button', { name: /2 号麦位 小明/ });
    await expect(occupiedSeat).toBeVisible();
    await occupiedSeat.click();
    await hostRoom.getByRole('button', { name: '静音', exact: true }).click();
    await expect(audienceRoom.getByRole('button', { name: '已被静音', exact: true })).toBeVisible();
    await hostRoom.getByRole('button', { name: '解除静音', exact: true }).click();
    await expect(audienceRoom.getByRole('button', { name: '闭麦', exact: true })).toBeVisible();
    await hostRoom.getByRole('button', { name: '下麦', exact: true }).click();
    await expect(audienceRoom.getByRole('button', { name: '申请上麦', exact: true })).toBeVisible();

    await expectTrace(page, 'storage.setChannelMetadata', /forcedMutedUserIds=小明/);
    await expectTrace(audiencePage, 'storage', /UPDATE.*forcedMutedUserIds=空/);
    await expectTrace(page, 'storage.setChannelMetadata', /seats=2号麦 空/);
  });

  test('Host 暂时离开后 Audience 显示 Host 和 AWAY，原 Host 可返回同一房间', async ({ context, page }, testInfo) => {
    skipNonDesktop(testInfo.project.name);
    const { hostRoom, audiencePage, audienceRoom } = await openTwoPartyRoom(context, page, '房主返回');
    const before = readRoomIdentity(page);
    await hostRoom.getByRole('button', { name: '暂时离开', exact: true }).click();
    await expect(page.getByRole('button', { name: '以 Host 身份返回', exact: true })).toBeVisible();
    await expect(audienceRoom.locator('[title="房主暂时离开"]')).toBeVisible();
    await expect(audienceRoom.locator('.vr-single__seat-copy strong').first()).toHaveText('Host');
    await expect(audienceRoom.getByRole('button', { name: '申请上麦', exact: true })).toBeDisabled();
    await expectTrace(audiencePage, 'presence', /REMOTE_LEAVE/);

    await page.getByRole('button', { name: '以 Host 身份返回', exact: true }).click();
    await expect(hostRoom).toBeVisible();
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    expect(readRoomIdentity(page)).toMatchObject(before);
    await expect(audienceRoom.locator('[title="房主暂时离开"]')).toHaveCount(0);
    await expect(audienceRoom.getByText('小周', { exact: true })).toBeVisible();
    await expectTrace(audiencePage, 'presence', /REMOTE_JOIN.*小周/);
    await expectTrace(audiencePage, 'presence', /小周 \(user-…[a-z0-9]{4}\) muted=false/i);
  });
});

test.describe('入房昵称', () => {
  test.beforeEach(async ({ page }) => { await withAppId(page); });

  test('Host 自填中文与 Emoji，组合输入不提前提交，刷新保留昵称和身份', async ({ page }) => {
    await withPersistentE2eMetadata(page);
    await page.goto('/social/voice-room');
    const nickname = '🌟 小明';
    const hostInput = page.getByLabel('房主昵称');
    const audienceInput = page.getByLabel('观众昵称');
    await page.getByLabel('房间标题').fill('自填房主昵称');
    await audienceInput.fill('观众草稿');
    await hostInput.fill(`  ${nickname}  `);
    await expect(audienceInput).toHaveValue('观众草稿');
    await hostInput.dispatchEvent('compositionstart', { data: '小明' });
    await hostInput.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    await expect(page.getByRole('button', { name: '创建并进入' })).toBeEnabled();
    await expect(page.getByLabel('房主语聊房')).toHaveCount(0);
    await hostInput.dispatchEvent('compositionend', { data: '小明' });
    await hostInput.press('Enter');
    const room = page.getByLabel('房主语聊房');
    await expect(room).toBeVisible();
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    const beforeRefresh = readRoomIdentity(page);
    expect(beforeRefresh).toMatchObject({ role: 'host', nickname });
    expect(beforeRefresh.pageUid).toBeTruthy();
    await expect(room.locator('.vr-single__seat-copy strong').first()).toHaveText(nickname);
    await expect(room.locator('.vr-single__seat-avatar').first()).toHaveText('🌟');
    await room.getByLabel('聊天内容').fill('自定义昵称的本端消息');
    await room.getByRole('button', { name: '发送聊天', exact: true }).click();
    await expect(room.getByLabel('聊天内容')).toHaveValue('');
    await ensureTimelineExpanded(page);
    // 既有 adapter 不回送 message，这里只验证出站频道消息摘要，不冒充远端接收或公屏回显。
    await expect(page.getByRole('complementary', { name: '时间线' }).getByTestId('trace-row')
      .filter({ has: page.locator('.lab-trace__name').filter({ hasText: /^rtm\.publish$/ }) }))
      .toContainText('to ALL chat.message');

    await page.reload();
    await expect(room).toBeVisible();
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    expect(readRoomIdentity(page)).toMatchObject(beforeRefresh);
    await expect(room.locator('.vr-single__seat-copy strong').first()).toHaveText(nickname);
    await ensureTimelineExpanded(page);
    await expect(page.locator('.lab-trace__name').filter({ hasText: /^storage\.setChannelMetadata$/ })).toHaveCount(0);
    await ensureTimelineCollapsed(page);
    await page.getByRole('button', { name: '暂时离开' }).click();
    await expect(hostInput).toHaveValue(nickname);
    await expect(audienceInput).toHaveValue('');
  });

  test('Audience 按名称使用自填昵称，同页换角色及刷新保持同一 UID', async ({ page }) => {
    await withPersistentE2eMetadata(page);
    await page.goto('/social/voice-room');
    const roomName = '自填观众昵称';
    const nickname = '小雨 🎧';
    await page.getByLabel('房间标题').fill(roomName);
    await page.getByLabel('房主昵称').fill('房主草稿');
    await page.getByLabel('观众昵称').fill(nickname);
    await page.getByRole('button', { name: '创建并进入' }).click();
    await expect(page.getByLabel('房主语聊房')).toBeVisible();
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    const hostIdentity = readRoomIdentity(page);
    await page.getByRole('button', { name: '暂时离开' }).click();
    await expect(page.getByLabel('房主昵称')).toHaveValue('房主草稿');
    await expect(page.getByLabel('观众昵称')).toHaveValue(nickname);
    await page.getByLabel('加入的房间名称').fill(roomName);
    await page.getByLabel('观众昵称').press('Enter');
    const room = page.getByLabel('听众语聊房');
    await expect(room).toBeVisible();
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    const beforeRefresh = readRoomIdentity(page);
    expect(beforeRefresh).toMatchObject({ role: 'audience', nickname, pageUid: hostIdentity.pageUid, roomId: hostIdentity.roomId });
    await expect(room.locator('.vr-single__nickname')).toHaveText(nickname);

    await page.reload();
    await expect(room).toBeVisible();
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    expect(readRoomIdentity(page)).toMatchObject(beforeRefresh);
    await expect(room.locator('.vr-single__nickname')).toHaveText(nickname);
    await ensureTimelineExpanded(page);
    await expect(page.locator('.lab-trace__name').filter({ hasText: /^storage\.setChannelMetadata$/ })).toHaveCount(0);
    await ensureTimelineCollapsed(page);
    await page.getByRole('button', { name: '退出房间', exact: true }).click();
    await expect(page.getByLabel('观众昵称')).toHaveValue(nickname);
    await expect(page.getByLabel('房主昵称')).toHaveValue('');
  });

  test('20 个 Emoji 可用，21 个报错且两卡片独立；空白昵称保留角色默认值', async ({ page }) => {
    await page.goto('/social/voice-room');
    const roomName = '昵称边界验证';
    const hostInput = page.getByLabel('房主昵称');
    const audienceInput = page.getByLabel('观众昵称');
    const create = page.getByRole('button', { name: '创建并进入' });
    const join = page.getByRole('button', { name: '加入房间', exact: true });
    await page.getByLabel('房间标题').fill(roomName);
    await page.getByLabel('加入的房间名称').fill(roomName);
    await hostInput.fill('😀'.repeat(20));
    await expect(hostInput).toHaveValue('😀'.repeat(20));
    await expect(hostInput).toHaveAttribute('aria-invalid', 'false');
    await expect(create).toBeEnabled();
    await hostInput.fill('😀'.repeat(21));
    await expect(hostInput).toHaveAttribute('aria-invalid', 'true');
    await expect(hostInput).toHaveAccessibleDescription('昵称最多 20 个字符');
    await expect(create).toBeDisabled();
    await expect(join).toBeEnabled();
    await expect(audienceInput).toHaveValue('');
    await audienceInput.fill('听'.repeat(21));
    await expect(audienceInput).toHaveAttribute('aria-invalid', 'true');
    await expect(audienceInput).toHaveAccessibleDescription('昵称最多 20 个字符');
    await expect(join).toBeDisabled();
    await hostInput.fill('   ');
    await expect(hostInput).toHaveAttribute('aria-invalid', 'false');
    await expect(create).toBeEnabled();
    await audienceInput.fill('');
    await expect(audienceInput).toHaveAttribute('aria-invalid', 'false');
    await expect(join).toBeEnabled();
    await create.click();
    await expect(page.getByLabel('房主语聊房')).toBeVisible();
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    expect(readRoomIdentity(page).nickname).toBe('Host');
    await page.getByRole('button', { name: '暂时离开' }).click();
    await join.click();
    await expect(page.getByLabel('听众语聊房')).toBeVisible();
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    const audienceNickname = readRoomIdentity(page).nickname;
    expect(audienceNickname).toMatch(/^[A-Z][a-z]+_\d{3}$/);
    await expect(page.getByLabel('听众语聊房').locator('.vr-single__nickname')).toHaveText(audienceNickname);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}：低视口下两卡片昵称与提交按钮均可滚动到达`, async ({ page }, testInfo) => {
      const width = testInfo.project.name === 'desktop-chromium' ? 1280 : 412;
      await page.setViewportSize({ width, height: 577 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto('/social/voice-room');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByLabel('房间标题').fill('滚动可达验证');
      await page.getByLabel('加入的房间名称').fill('滚动可达验证');
      for (const [label, submit] of [['房主昵称', '创建并进入'], ['观众昵称', '加入房间']]) {
        const input = page.getByLabel(label, { exact: true });
        await input.scrollIntoViewIfNeeded();
        await input.fill('😀'.repeat(20));
        await expect(input).toBeInViewport({ ratio: 1 });
        const button = page.getByRole('button', { name: submit, exact: true });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport({ ratio: 1 });
        await expect(button).toBeEnabled();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`nickname-entry-${theme}.png`) });
    });
  }
});

test.describe('时间线面板', () => {
  test.beforeEach(async ({ page }) => {
    await withAppId(page);
  });

  test('可折叠、可展开', async ({ page }) => {
    const unexpected = collectErrors(page);
    await page.goto('/social/voice-room');

    const timeline = page.getByRole('complementary', { name: '时间线' });
    const body = page.locator('.lab-body');
    await ensureTimelineExpanded(page);
    await expect(body).toHaveAttribute('data-timeline', 'expanded');

    await page.getByTestId('timeline-toggle').click();
    await expect(body).toHaveAttribute('data-timeline', 'collapsed');
    // 折叠态仍留一条竖条与条目计数，数据不清空
    await expect(timeline).toBeVisible();
    await expect(page.getByTestId('timeline-count')).toBeVisible();
    const collapsedBox = await timeline.boundingBox();
    expect(collapsedBox!.width).toBeLessThanOrEqual(50);

    await page.getByTestId('timeline-toggle').click();
    await expect(body).toHaveAttribute('data-timeline', 'expanded');

    expect(unexpected()).toEqual([]);
  });

  test('<1280 时右栏优先收起为窄栏，<1024 时左栏也收起', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', '只在桌面项目里改视口验证断点');

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/social/voice-room');
    const timeline = page.getByRole('complementary', { name: '时间线' });
    const roomEntry = page.getByTestId('voice-room-entry');
    const workspace = page.locator('.lab-workspace');

    // 宽屏：三栏都展开，时间线在主区右侧
    await expect(workspace).toHaveAttribute('data-left', 'expanded');
    await expect(workspace).toHaveAttribute('data-timeline', 'expanded');
    const wideTimeline = await timeline.boundingBox();
    const wideEntry = await roomEntry.boundingBox();
    expect(wideTimeline!.x).toBeGreaterThan(wideEntry!.x);
    expect(wideTimeline!.width).toBeGreaterThanOrEqual(400);

    // <1280：右栏收为 48px 窄栏，左栏仍展开
    await page.setViewportSize({ width: 1100, height: 1000 });
    await expect(workspace).toHaveAttribute('data-timeline', 'collapsed');
    await expect(workspace).toHaveAttribute('data-left', 'expanded');
    const narrowTimeline = await timeline.boundingBox();
    expect(narrowTimeline!.width).toBeLessThanOrEqual(50);
    expect(narrowTimeline!.x).toBeGreaterThan(wideEntry!.x);

    // <1024：左栏也收起
    await page.setViewportSize({ width: 900, height: 1000 });
    await expect(workspace).toHaveAttribute('data-left', 'collapsed');
  });
});

test.describe('env 未配置', () => {
  /**
   * 显式注入空 appId，验证空白配置会被 `normalizeAppId` 收敛为未配置。
   */
  test('渲染引导页，不进场景', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __ENV__: { appId: string } }).__ENV__ = { appId: '' };
    });
    const unexpected = collectErrors(page);
    await page.goto('/social/voice-room');

    const guide = page.getByTestId('env-guide');
    await expect(guide).toBeVisible();
    await expect(page.getByTestId('voice-room-entry')).toHaveCount(0);

    // 未配置不是异常，引导页不该用报错口吻
    await expect(guide).toContainText('VITE_APP_ID');
    await expect(guide).toContainText('__ENV__');
    await expect(guide).not.toContainText(/错误|失败|异常/);

    expect(unexpected()).toEqual([]);
  });
});


test.describe('体验路径与工作台适配', () => {
  test.beforeEach(async ({ page }) => { await withAppId(page); });

  test('连接入房推进任务；公屏本地回显不完成双向互动，清空日志保留进度', async ({ page }) => {
    await page.goto('/social/voice-room');
    const path = page.getByRole('complementary', { name: '体验路径' });
    const toggle = path.getByRole('button', { name: '体验路径' });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    const progress = path.getByRole('progressbar');
    await expect(progress).toHaveAttribute('aria-valuenow', '0');
    const mobileGuide = (page.viewportSize()?.width ?? 1440) <= 800;
    if (mobileGuide) await toggle.click();
    await page.getByLabel('房间标题').fill('体验路径验证');
    await page.getByRole('button', { name: '创建并进入' }).click();
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    if (mobileGuide) await toggle.click();
    await expect(progress).toHaveAttribute('aria-valuenow', '1');
    await expect(path.getByRole('button', { name: '建立房间连接 已完成' })).toBeVisible();
    if (mobileGuide) await toggle.click();
    const room = page.getByLabel('房主语聊房');
    await room.getByLabel('聊天内容').fill('本端测试消息');
    await room.getByLabel('聊天内容').press('Enter');
    if (mobileGuide) await toggle.click();
    // 本地回显不构成远端完成证据；任务只有「已完成 / 待体验」两种状态。
    await expect(path.getByRole('button', { name: '发送房内消息 待体验' })).toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuenow', '1');
    if (mobileGuide) await toggle.click();
    await ensureTimelineExpanded(page);
    await page.getByRole('button', { name: '清空', exact: true }).click();
    await ensureTimelineCollapsed(page);
    if (mobileGuide) await toggle.click();
    await expect(progress).toHaveAttribute('aria-valuenow', '1');
    if (mobileGuide) await toggle.click();
    await page.getByRole('link', { name: '电商直播', exact: true }).click();
    // 占位页正文也有「语聊房」链接，限定到顶栏导航。
    await page.getByRole('navigation', { name: '一级场景分类' }).getByRole('link', { name: '语聊房', exact: true }).click();
    if (mobileGuide) await toggle.click();
    await expect(progress).toHaveAttribute('aria-valuenow', '0');
  });

  test('体验路径向左收起，说明悬浮或聚焦显示且不展开子任务', async ({ page }, testInfo) => {
    await page.goto('/social/voice-room');
    await expect(page.getByTestId('voice-room-entry')).toBeVisible();
    const path = page.getByRole('complementary', { name: '体验路径' });
    const toggle = path.getByRole('button', { name: '体验路径', exact: true });
    const mobile = (page.viewportSize()?.width ?? 1440) <= 800;
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    const expanded = await path.boundingBox();
    const mainBefore = await page.locator('.lab-body').boundingBox();
    expect(expanded!.width).toBeGreaterThanOrEqual(250);
    const step = path.getByRole('button', { name: /^建立房间连接/ });
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    if (mobile) await step.tap(); else await step.hover();
    await expect(page.getByRole('tooltip')).toContainText('填写名称创建房间');
    const tipBox = await page.getByRole('tooltip').boundingBox();
    expect(tipBox!.x).toBeGreaterThanOrEqual(0);
    expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expect(path.locator('ol > li')).toHaveCount(5);
    await expect(path.locator('li ul')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('task-help.png') });
    await step.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await step.focus();
    await toggle.click();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    const collapsed = await path.boundingBox();
    expect(collapsed!.width).toBeLessThanOrEqual(50);
    expect(collapsed!.x).toBe(expanded!.x);
    const mainAfter = await page.locator('.lab-body').boundingBox();
    if (!mobile) expect(mainAfter!.width - mainBefore!.width).toBeGreaterThan(190);
    await expect(page.getByLabel('加入的房间名称')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('guide-collapsed.png') });
    await toggle.click();
    await expect(path.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    if (mobile) {
      await page.getByRole('button', { name: '收起体验路径', exact: true }).click({ position: { x: 350, y: 300 } });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('从桌面到手机，房间与通用组件不产生页面横向溢出', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', '在一个浏览器中验证所有宽度');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/social/voice-room');
    await expect(page.getByTestId('voice-room-entry')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('desktop-entry.png') });
    await page.getByLabel('房间标题').fill('布局验证房间');
    await page.getByRole('button', { name: '创建并进入' }).click();
    await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
    await expect(page.getByLabel('房主语聊房')).toBeVisible();
    for (const width of [1440, 1280, 1100, 900, 800, 412]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `页面宽度 ${width}`).toBe(true);
      const room = page.getByLabel('房主语聊房');
      const roomBounds = await room.boundingBox();
      const inputBounds = await room.getByLabel('聊天内容').boundingBox();
      expect(inputBounds!.height, `${width} 下消息输入框高度`).toBeGreaterThanOrEqual(46);
      for (const name of ['发送聊天', '发送礼物消息', '发送爱心消息', '闭麦']) {
        const bounds = await room.getByRole('button', { name, exact: true }).boundingBox();
        expect(bounds!.width, `${width} 下 ${name} 的按钮宽度`).toBeGreaterThanOrEqual(32);
        expect(bounds!.y + bounds!.height, `${width} 下 ${name} 不被房间裁切`).toBeLessThanOrEqual(roomBounds!.y + roomBounds!.height);
      }
      if ([1440, 1280, 412].includes(width)) await page.screenshot({ path: testInfo.outputPath(`room-${width}.png`), fullPage: true });
    }
    const path = page.getByRole('complementary', { name: '体验路径' });
    const pathToggle = path.getByRole('button', { name: '体验路径', exact: true });
    if (await pathToggle.getAttribute('aria-expanded') === 'false') await pathToggle.click();
    for (const name of ['前往 Console 创建项目', '产品简介', '最佳实践', 'API参考']) {
      await path.getByRole('link', { name, exact: true }).scrollIntoViewIfNeeded();
      await expect(path.getByRole('link', { name, exact: true })).toBeVisible();
    }
  });
});


test('名称入口：查无房间、同一 Host 恢复和离房后按名称加入', async ({ page }) => {
  await withAppId(page);
  const errors = collectErrors(page);
  await page.goto('/social/voice-room');
  await page.getByLabel('加入的房间名称').fill('名称回归房');
  await page.getByRole('button', { name: '加入房间', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('未找到该房间');
  await page.getByLabel('房间标题').fill('名称回归房');
  await page.getByRole('button', { name: '创建并进入' }).click();
  await expect(page.getByLabel('房主语聊房')).toBeVisible();
  await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
  const firstRoomId = readRoomIdentity(page).roomId;
  await page.getByRole('button', { name: '暂时离开' }).click();
  await expect(page.getByRole('button', { name: '以 Host 身份返回' })).toBeVisible();
  await page.getByRole('button', { name: '以 Host 身份返回' }).click();
  await expect(page.getByLabel('房主语聊房')).toBeVisible();
  expect(readRoomIdentity(page).roomId).toBe(firstRoomId);
  await ensureTimelineExpanded(page);
  const timeline = page.getByRole('complementary', { name: '时间线' });
  await expect(timeline).toContainText('rtm.unsubscribe');
  await expect(timeline.locator('.lab-trace__name').filter({ hasText: /^rtm\.subscribe$/ })).toHaveCount(2);
  await expect(timeline.locator('.lab-trace__name').filter({ hasText: /^presence\.setState$/ })).toHaveCount(2);
  await ensureTimelineCollapsed(page);
  await page.getByRole('button', { name: '暂时离开' }).click();
  await page.getByRole('button', { name: '加入房间', exact: true }).click();
  await expect(page.getByLabel('听众语聊房')).toBeVisible();
  await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
  expect(errors()).toEqual([]);
});


test('房主解散直接返回入口，可同名重建且刷新不会恢复已解散房间', async ({ page }) => {
  await withAppId(page);
  await page.goto('/social/voice-room');
  await page.getByLabel('房间标题').fill('解散返回验证');
  await page.getByRole('button', { name: '创建并进入' }).click();
  await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
  await expect(page.getByLabel('房主语聊房')).toBeVisible();
  const oldUrl = page.url();
  await page.getByRole('button', { name: '解散房间', exact: true }).click();
  await expect(page.getByTestId('voice-room-entry')).toBeVisible();
  await expect(page.getByTestId('voice-room-ended')).toHaveCount(0);
  await expect(page).toHaveURL(/\/social\/voice-room$/);
  await ensureTimelineExpanded(page);
  await expect(page.getByRole('complementary', { name: '时间线' })).toContainText('rtm.unsubscribe');
  await expect(page.getByRole('complementary', { name: '时间线' })).toContainText('storage.removeChannelMetadata');
  await ensureTimelineCollapsed(page);
  await page.getByRole('button', { name: '创建并进入' }).click();
  await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
  await expect(page.getByLabel('房主语聊房')).toBeVisible();
  expect(page.url()).not.toBe(oldUrl);
  await page.getByRole('button', { name: '解散房间', exact: true }).click();
  await expect(page.getByTestId('voice-room-entry')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('voice-room-entry')).toBeVisible();
  await expect(page.getByTestId('voice-room-ended')).toHaveCount(0);
});


test('类型筛选直接展示 API 和事件颜色，取消独立图例', async ({ page }) => {
  await withAppId(page);
  await page.goto('/social/voice-room');
  await expect(page.getByTestId('voice-room-entry')).toBeVisible();
  await ensureTimelineExpanded(page);
  await expect(page.getByTestId('timeline-legend')).toHaveCount(0);
  const filter = page.getByTestId('filter-kind');
  for (const kind of ['api', 'event']) {
    const button = filter.locator(`button[data-kind="${kind}"]`);
    const dot = button.locator('.lab-trace__dot');
    const row = page.locator(`.lab-trace[data-kind="${kind}"]`).first();
    const kindColor = await dot.evaluate(el => getComputedStyle(el).backgroundColor);
    // 等待新行呼吸结束后比较静态边框；pill 中的圆点仍是类型图例。
    await expect(row).toHaveCSS('box-shadow', 'none', { timeout: 6_000 });
    await expect(row).toHaveCSS('border-left-color', kindColor);
    await expect(row.locator('.lab-trace__kind')).toHaveCSS('color', kindColor);
    await expect(row.locator('.lab-trace__dot')).toHaveCount(0);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await button.click();
  }
});

test('数据流最新在前：乱序时间、筛选、旧记录滚动和折叠期间追加', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'desktop-chromium') await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await withAppId(page);
  const unexpected = collectErrors(page);
  const baseTime = 1_700_000_000_000;
  const nameFor = (offset: number) => `${offset % 2 === 0 ? 'api' : 'event'}.operation-${String(offset).padStart(2, '0')}`;
  // Arrival sequence intentionally differs from timestamp order in both directions.
  const offsets = [12, 2, 19, 5, 0, 22, 8, 15, 3, 20, 10, 17, 6, 23, 1, 18, 9, 14, 4, 21, 7, 16, 11, 13];
  const initialEntries: TraceEntry[] = offsets.map((offset, index) => ({
    at: baseTime + offset * 1_000,
    seq: index + 1,
    kind: offset % 2 === 0 ? 'api' : 'event',
    name: nameFor(offset),
    summary: `时间顺序 ${offset}；到达顺序 ${index + 1}`,
    uid: 'timeline-order-fixture',
    role: 'host',
  }));
  const append = await withUpdatingTraceFixtures(page, initialEntries);
  await page.goto('/social/voice-room');
  await expect(page.getByTestId('voice-room-entry')).toBeVisible();
  await ensureTimelineExpanded(page);
  const rows = page.getByTestId('trace-row');
  const names = rows.locator('.lab-trace__name');
  const body = page.getByTestId('timeline-body');
  const expectedOffsets = Array.from({ length: 24 }, (_, index) => 23 - index);
  const expectedNames = expectedOffsets.map(nameFor);
  await expect(names).toHaveText(expectedNames);
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0);
  await expect(rows.first()).toBeInViewport();

  for (const kind of ['api', 'event'] as const) {
    const filter = page.getByTestId('filter-kind').locator(`button[data-kind="${kind}"]`);
    await filter.click();
    await expect(names).toHaveText(expectedOffsets.filter(offset => (offset % 2 === 0 ? 'api' : 'event') === kind).map(nameFor));
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0);
    await filter.click();
    await expect(names).toHaveText(expectedNames);
  }

  await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(rows.last()).toBeInViewport();
  await expect(rows.last().locator('.lab-trace__name')).toHaveText('api.operation-00');
  await expect(rows.first()).not.toBeInViewport();

  // The most recently delivered entry is older; it must not displace the newest timestamp.
  const newest: TraceEntry = { ...initialEntries[0], seq: 25, at: baseTime + 30_000, name: 'api.newest-visible', summary: '查看旧记录时到达的新调用' };
  const delayed: TraceEntry = { ...initialEntries[1], seq: 26, at: baseTime + 4_500, kind: 'event', name: 'event.delayed', summary: '晚到的旧时间戳事件' };
  await append([newest, delayed]);
  const afterAppend = ['api.newest-visible', ...expectedNames];
  afterAppend.splice(afterAppend.indexOf('api.operation-04'), 0, 'event.delayed');
  await expect(names).toHaveText(afterAppend);
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0);
  await expect(rows.first()).toBeInViewport();

  await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(rows.last()).toBeInViewport();
  await page.getByTestId('timeline-toggle').click();
  await expect(page.getByTestId('timeline-toggle')).toHaveAttribute('aria-expanded', 'false');
  await append([{ ...newest, seq: 27, at: baseTime + 31_000, name: 'api.newest-while-collapsed', summary: '折叠期间的新调用' }]);
  await expect(page.getByTestId('timeline-count')).toHaveText('27');
  await ensureTimelineExpanded(page);
  await expect(names).toHaveText(['api.newest-while-collapsed', ...afterAppend]);
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0);
  await expect(rows.first()).toBeInViewport();
  await expect(rows.last()).not.toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('timeline-newest-first.png') });
  expect(unexpected()).toEqual([]);
});

test.describe('v1.2 数据流视觉增量', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}：方格、卡片投影、标题图标与长记录布局`, async ({ page }, testInfo) => {
      if (testInfo.project.name === 'desktop-chromium') await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await withAppId(page);
      await withVisualTraceFixtures(page);
      await page.goto('/social/voice-room');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const main = page.locator('.lab-body');
      await expect(main).toHaveCSS('background-size', '72px 72px, 72px 72px');
      await expect(main).toHaveCSS('background-position', '-1px -1px, -1px -1px');
      const grid = await main.evaluate(el => getComputedStyle(el).backgroundImage);
      expect(grid.match(/linear-gradient/g)).toHaveLength(2);
      expect(grid).toContain(theme === 'light' ? 'rgb(236, 236, 238)' : 'rgb(26, 27, 30)');

      const path = page.getByRole('complementary', { name: '体验路径' });
      const pathToggle = path.getByRole('button', { name: '体验路径', exact: true });
      if (await pathToggle.getAttribute('aria-expanded') === 'false') await pathToggle.click();
      const pathIcon = path.locator('.experience-path__title > svg');
      await expect(pathIcon).toHaveAttribute('aria-hidden', 'true');
      await expect(pathIcon).toHaveCSS('width', '16px');
      await expect(pathIcon).toHaveCSS('height', '16px');
      await expect(pathIcon).toHaveAttribute('stroke-width', '1.8');
      await expect(path).toHaveCSS('background-image', 'none');
      if ((page.viewportSize()?.width ?? 1440) <= 760) {
        await page.getByRole('button', { name: '收起体验路径', exact: true }).click({
          position: { x: (page.viewportSize()?.width ?? 412) - 24, y: 100 },
        });
      }

      await page.getByLabel('房间标题').fill(`视觉验收-${theme}`);
      await page.getByRole('button', { name: '创建并进入' }).click();
      const room = page.getByLabel('房主语聊房');
      await expect(room).toBeVisible();
      await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);
      await expect(room).toHaveCSS('box-shadow', theme === 'light'
        ? 'rgba(17, 18, 20, 0.04) 0px 1px 2px 0px, rgba(17, 18, 20, 0.12) 0px 12px 32px -8px'
        : 'rgba(0, 0, 0, 0.4) 0px 1px 2px 0px, rgba(0, 0, 0, 0.6) 0px 12px 32px -8px');

      await ensureTimelineExpanded(page);
      const timeline = page.getByRole('complementary', { name: '时间线' });
      await expect(page.getByTestId('timeline-toggle')).toHaveAttribute('aria-expanded', 'true');
      const actionsBounds = await timeline.locator('.lab-timeline__actions').boundingBox();
      for (const selector of ['.lab-timeline__heading', '.lab-timeline__title']) {
        const bounds = await timeline.locator(selector).boundingBox();
        expect(bounds!.x + bounds!.width, `${theme} ${testInfo.project.name} 下 ${selector} 不遮挡操作区`)
          .toBeLessThanOrEqual(actionsBounds!.x);
      }
      await expect(timeline.locator('.lab-timeline__heading')).toHaveText('RTM 数据流');
      await expect(timeline.locator('.lab-timeline__entry-count')).toHaveCount(0);
      for (const kind of ['api', 'event']) {
        const filter = timeline.getByTestId('filter-kind').locator(`button[data-kind="${kind}"]`);
        await expect(filter.locator('.lab-timeline__filter-count')).toHaveText('2');
        await expect(filter.locator('.lab-trace__dot')).toBeVisible();
      }
      const timelineIcon = timeline.locator('.lab-timeline__title svg');
      await expect(timelineIcon).toHaveAttribute('aria-hidden', 'true');
      await expect(timelineIcon).toHaveCSS('width', '16px');
      await expect(timelineIcon).toHaveCSS('height', '16px');
      await expect(timelineIcon).toHaveAttribute('stroke-width', '1.8');
      await expect(timeline).toHaveCSS('background-image', 'none');
      await expect(page.locator('.lab-timeline__list')).toHaveCSS('row-gap', '10px');

      const rows = page.getByTestId('trace-row');
      await expect(rows).toHaveCount(4);
      const dimensions = await rows.evaluateAll(elements => elements.map(element => ({
        height: element.getBoundingClientRect().height,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      })));
      for (const row of dimensions) {
        expect(row.height).toBeGreaterThanOrEqual(70);
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      }
      await expect(rows.first()).toHaveCSS('background-color', theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(20, 21, 23)');
      await expect(rows.first()).toHaveCSS('border-top-width', '1px');
      await expect(rows.first()).toHaveCSS('border-left-width', '3px');
      const longApi = rows.filter({ has: page.locator('.lab-trace__name', { hasText: LONG_API_NAME }) });
      await expect(longApi).toHaveAttribute('title', new RegExp(LONG_TRACE_SUMMARY));
      await expect(rows.filter({ has: page.locator('.lab-trace__name', { hasText: /^presence$/ }) }).locator('.lab-trace__kind')).toHaveText('EVENT');
      await expect(longApi.locator('.lab-trace__name')).toHaveCSS('white-space', 'nowrap');
      await expect(longApi.locator('.lab-trace__name')).toHaveCSS('text-overflow', 'ellipsis');
      const longSummary = longApi.locator('.lab-trace__summary-text');
      await expect(longSummary).toHaveCSS('white-space', 'normal');
      await expect(longSummary).toHaveCSS('overflow-wrap', 'anywhere');
      expect(await longSummary.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
      expect((await longApi.boundingBox())!.height).toBeGreaterThan(70);
      const failed = rows.filter({ has: page.getByTestId('trace-error') });
      await expect(failed).toHaveAttribute('title', new RegExp(LONG_TRACE_ERROR));
      await expect(failed).toHaveAttribute('title', /-11001/);
      await expect(failed.getByTestId('trace-error').locator('code')).toBeVisible();
      await expect(failed.getByTestId('trace-error')).toContainText(LONG_TRACE_ERROR);
      const failedSummary = failed.locator('.lab-trace__summary');
      const failedSummaryText = failed.locator('.lab-trace__summary-text');
      const [failedSummaryBounds, failedSummaryTextBounds, failedErrorBounds] = await Promise.all([
        failedSummary.boundingBox(),
        failedSummaryText.boundingBox(),
        failed.getByTestId('trace-error').boundingBox(),
      ]);
      expect(Math.abs(failedSummaryTextBounds!.x - failedErrorBounds!.x)).toBeLessThanOrEqual(1);
      expect(failedSummaryTextBounds!.width).toBeGreaterThanOrEqual(failedSummaryBounds!.width * 0.9);
      expect(failedErrorBounds!.width).toBeGreaterThanOrEqual(failedSummaryBounds!.width * 0.9);
      const errorMessage = failed.locator('.lab-trace__error-message');
      await expect(errorMessage).toHaveCSS('overflow-wrap', 'anywhere');
      expect(await errorMessage.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
      await expect(rows.filter({ has: page.locator('.lab-trace__name', { hasText: /^linkState$/ }) }).locator('.lab-trace__summary')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`trace-v1-2-${theme}.png`) });
    });
  }

  test('边框呼吸保持行底，结束恢复静态，减少动态效果时不播放', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await withAppId(page);
    await withVisualTraceFixtures(page);
    await page.goto('/social/voice-room');
    await ensureTimelineExpanded(page);
    const row = page.getByTestId('trace-row').filter({ has: page.locator('.lab-trace__name', { hasText: LONG_API_NAME }) });
    await expect(row).toHaveCSS('animation-duration', '0.35s, 1.8s');
    await expect(row).toHaveCSS('animation-iteration-count', '1, 2');
    await expect(row).toHaveCSS('animation-delay', '0s, 0.3s');
    await expect.poll(() => row.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
    await expect(row).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(row).toHaveCSS('box-shadow', 'none', { timeout: 6_000 });
    await expect(row).toHaveCSS('border-top-color', 'rgb(230, 231, 234)');
    await expect(row).toHaveCSS('border-left-color', 'rgb(47, 169, 138)');
    await expect(row).toHaveCSS('background-color', 'rgb(255, 255, 255)');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await ensureTimelineExpanded(page);
    await expect(row).toHaveCSS('animation-name', 'none');
    expect(await row.evaluate(element => element.getAnimations().length)).toBe(0);
    await expect(row).toHaveCSS('border-left-color', 'rgb(47, 169, 138)');
  });
});

test.describe('公屏五行窗口与房主皇冠', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}：保留全部消息、可滚动五行窗口与图标标识`, async ({ page }, testInfo) => {
      if (testInfo.project.name === 'desktop-chromium') await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await withAppId(page);
      await withE2eChatEcho(page);
      await page.goto('/social/voice-room');
      await page.getByLabel('房间标题').fill(`公屏验收-${theme}`);
      await page.getByRole('button', { name: '创建并进入' }).click();
      const room = page.getByLabel('房主语聊房');
      await expect(room).toBeVisible();
      await expect(page.getByTestId('voice-room-loading-overlay')).toHaveCount(0);

      const hostSeat = room.locator('.vr-single__seat').first();
      const crown = hostSeat.getByRole('img', { name: '房主', exact: true });
      await crown.scrollIntoViewIfNeeded();
      await expect(crown).toHaveAttribute('title', '房主');
      await expect(crown).toHaveText('');
      await expect(crown.locator('svg')).toHaveCSS('width', '22px');
      await expect(crown.locator('svg')).toHaveCSS('height', '22px');
      const unclipped = await crown.locator('svg').evaluate(element => {
        const icon = element.getBoundingClientRect();
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          const bounds = ancestor.getBoundingClientRect();
          if (/(hidden|clip|auto|scroll)/.test(style.overflowX) && (icon.left < bounds.left || icon.right > bounds.right)) return false;
          if (/(hidden|clip|auto|scroll)/.test(style.overflowY) && (icon.top < bounds.top || icon.bottom > bounds.bottom)) return false;
        }
        return true;
      });
      expect(unclipped, '皇冠不被祖先容器裁切').toBe(true);
      const overlap = await hostSeat.evaluate(element => {
        const icon = element.querySelector('.vr-single__seat-host svg')!.getBoundingClientRect();
        const avatar = element.querySelector('.vr-single__seat-avatar')!.getBoundingClientRect();
        return Math.max(0, Math.min(icon.right, avatar.right) - Math.max(icon.left, avatar.left))
          * Math.max(0, Math.min(icon.bottom, avatar.bottom) - Math.max(icon.top, avatar.top));
      });
      expect(overlap, '皇冠不能遮挡头像').toBe(0);

      const feed = room.getByTestId('voice-room-chat-feed');
      const messages = feed.locator('p[data-interaction-type="chat"]');
      const input = room.getByLabel('聊天内容');
      for (let index = 1; index <= 7; index += 1) {
        await input.fill(`短${index}`);
        await room.getByRole('button', { name: '发送聊天', exact: true }).click();
        await expect(messages).toHaveCount(index);
      }
      const text = await messages.locator('span').allTextContents();
      expect(text.map(value => value.trim())).toEqual(['短1', '短2', '短3', '短4', '短5', '短6', '短7']);
      await expect(feed).toHaveAttribute('tabindex', '0');
      await expect(feed).toHaveAttribute('aria-label', '公屏消息，可上下滚动');
      await expect(feed).toHaveCSS('overflow-y', 'auto');
      const dimensions = await feed.evaluate(element => {
        const style = getComputedStyle(element);
        const rows = [...element.querySelectorAll('p[data-interaction-type="chat"]')];
        return {
          height: element.getBoundingClientRect().height,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          lineHeight: parseFloat(getComputedStyle(rows[0]).lineHeight),
          gap: parseFloat(style.rowGap),
          rowHeights: rows.map(row => row.getBoundingClientRect().height),
        };
      });
      expect(dimensions.height).toBeCloseTo(dimensions.lineHeight * 5 + dimensions.gap * 4, 1);
      expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
      for (const height of dimensions.rowHeights) expect(height).toBeCloseTo(dimensions.lineHeight, 1);
      await expect.poll(() => feed.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
      const fullyVisible = await feed.evaluate(element => {
        const viewport = element.getBoundingClientRect();
        return [...element.querySelectorAll('p[data-interaction-type="chat"]')].filter(row => {
          const bounds = row.getBoundingClientRect();
          return bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1;
        }).length;
      });
      expect(fullyVisible).toBe(5);

      await feed.evaluate(element => element.scrollTo({ top: 0 }));
      await expect.poll(() => feed.evaluate(element => element.scrollTop)).toBe(0);
      const firstIsInside = await messages.first().evaluate(element => {
        const row = element.getBoundingClientRect();
        const viewport = element.parentElement!.getBoundingClientRect();
        return row.top >= viewport.top - 1 && row.bottom <= viewport.bottom + 1;
      });
      expect(firstIsInside).toBe(true);
      await feed.evaluate(element => element.scrollTo({ top: element.scrollHeight }));
      await expect.poll(() => feed.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`chat-five-rows-${theme}.png`), fullPage: true });

      // New messages still bring the actual scroll container to the latest entry.
      await feed.evaluate(element => element.scrollTo({ top: 0 }));
      const longMessage = '这是一条较长的公屏消息，换行后仍可完整阅读。'.repeat(20);
      await input.fill(longMessage);
      await room.getByRole('button', { name: '发送聊天', exact: true }).click();
      await expect(messages).toHaveCount(8);
      await expect(messages.last()).toContainText(longMessage);
      await expect(messages.last()).toHaveCSS('white-space', 'normal');
      const longBounds = await messages.last().evaluate(element => ({
        height: element.getBoundingClientRect().height,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(longBounds.height).toBeGreaterThan(dimensions.lineHeight * 2);
      expect(longBounds.scrollWidth).toBeLessThanOrEqual(longBounds.clientWidth);
      await expect.poll(() => feed.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
      await expect(messages.first()).toContainText('短1');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
});
