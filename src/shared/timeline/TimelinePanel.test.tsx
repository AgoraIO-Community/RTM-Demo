import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TimelinePanel } from './TimelinePanel';
import { roleColor } from './roleColors';
import { createTraceStore, type TraceInput, type TraceStore } from './traceStore';
import { toTraceSource, type TraceSource } from './useMergedTraces';

// 源码文本断言用 Vite 的 `?raw`，不用 node:fs —— `tsconfig.app.json` 的 types
// 里没有 node，用 node API 会让 `tsc -b` 报 TS2591 而测试却是绿的。
import panelSource from './TimelinePanel.tsx?raw';
import stylesSource from '../../app/styles.css?raw';

/** 固定基准时间戳：北京时间 `17:12:34.567`。 */
const BASE = Date.UTC(2026, 0, 1, 9, 12, 34, 567);

interface Endpoint {
  store: TraceStore;
  source: TraceSource;
  /** 往这一端记一条，返回记完之后的条目数。 */
  record(input: Partial<TraceInput> & { name: string }): void;
}

function endpoint(uid: string, role: string, limit?: number): Endpoint {
  const store = createTraceStore({ uid, role, limit });
  return {
    store,
    source: {
      getEntries: () => store.getEntries(),
      subscribe: (listener) => store.subscribe(listener),
      clear: () => store.clear(),
    },
    record(input) {
      // 包在 act 里：record 会同步触发订阅者，React 需要知道这是一次状态更新。
      act(() => {
        store.record({ at: BASE, kind: 'api', ...input });
      });
    },
  };
}

/**
 * 造两端并渲染面板。
 *
 * sources 数组在 render 之外建一次并复用 —— 每次渲染新建数组会让
 * `useSyncExternalStore` 的 subscribe 依赖变化而反复重订阅。
 */
function setup(options: { limit?: number; collapsed?: boolean } = {}) {
  const host = endpoint('host-aaa', 'host', options.limit);
  const audience = endpoint('audience-bbb', 'audience', options.limit);
  const sources = [host.source, audience.source];
  const onToggleCollapsed = vi.fn();

  const view = render(
    <TimelinePanel
      sources={sources}
      collapsed={options.collapsed}
      onToggleCollapsed={onToggleCollapsed}
    />,
  );

  return { host, audience, sources, onToggleCollapsed, view };
}

function rows() {
  return screen.queryAllByTestId('trace-row');
}

function rowTexts(): string[] {
  return rows().map((row) => row.textContent ?? '');
}

describe('两类条目与图例', () => {
  it('新条目以记录色柔和呼吸两个周期，之后静止', () => {
    expect(stylesSource).toMatch(
      /\.lab-trace \{[^}]*animation: lab-rowin 0\.35s ease-out, lab-rowbreathe 1\.8s ease-in-out 0\.3s 2/,
    );
    expect(stylesSource).toContain('@keyframes lab-rowbreathe');
  });

  it('有新条目时自动滚到顶部，最新记录排在第一条', () => {
    const { host } = setup();
    host.record({ name: 'rtm.login', at: BASE });
    const body = screen.getByTestId('timeline-body');
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 480 });
    body.scrollTop = 240;
    host.record({ name: 'rtm.subscribe', at: BASE + 1 });
    expect(body.scrollTop).toBe(0);
    expect(rows()[0]).toHaveTextContent('rtm.subscribe');
  });

  it('api 与 event 在首行显示类型标签，行内不再占用色点列', () => {
    const { host } = setup();
    host.record({ name: 'rtm.login', kind: 'api' });
    host.record({ name: 'message', kind: 'event' });

    const kinds = rows().map((row) => row.getAttribute('data-kind'));
    expect(kinds).toEqual(['event', 'api']);
    for (const row of rows()) {
      expect(row.querySelector('.lab-trace__kind')?.textContent).toBe(row.getAttribute('data-kind')?.toUpperCase());
      expect(row.querySelector('.lab-trace__dot')).toBeNull();
    }
  });

  it('事件按“事件名、type tag、详情”展示，摘要不重复 type', () => {
    const { host } = setup();
    host.record({
      name: 'presence',
      kind: 'event',
      eventTag: 'REMOTE_STATE_CHANGED',
      summary: 'Emma_301 muted=false',
    });

    const row = rows()[0];
    expect(row.querySelector('[data-kind="event-type"]')?.textContent).toBe('REMOTE_STATE_CHANGED');
    // 类型标签与 SDK 事件子类型分开呈现。
    expect(row.querySelector('.lab-trace__kind')?.textContent).toBe('EVENT');
    expect(row.querySelector('.lab-trace__tag[data-kind="event"]')).toBeNull();
    expect(row.querySelector('.lab-trace__name')?.textContent).toBe('presence');
    expect(row.querySelector('.lab-trace__summary')?.textContent).toBe('Emma_301 muted=false');
  });

  it('publish API 在首行展示 USER 或 MESSAGE，第二行不重复类型', () => {
    const { host } = setup();
    host.record({
      name: 'rtm.publish',
      kind: 'api',
      eventTag: 'USER',
      summary: 'to 小周 seat.request 2号麦',
    });

    const row = rows()[0];
    expect(row.querySelector('.lab-trace__head')?.textContent).toContain('APIrtm.publishUSER');
    expect(row.querySelector('.lab-trace__summary')?.textContent).toBe('to 小周 seat.request 2号麦');
  });

  it('类型筛选保留色点与计数，不再重复显示图例', () => {
    setup();

    expect(screen.queryByTestId('timeline-legend')).not.toBeInTheDocument();
    const legend = screen.getByTestId('filter-kind');
    // 可见文案是等宽的 API / EVENT + 计数；可访问名保留完整说明。
    expect(legend.textContent).toBe('API0EVENT0');
    expect(within(legend).getByRole('button', { name: '调用 RTM API' })).toBeInTheDocument();
    expect(within(legend).getByRole('button', { name: '收到 RTM 事件' })).toBeInTheDocument();
    // 类型筛选仍有各自的色点，不受记录行移除色点列影响。
    const dots = legend.querySelectorAll('.lab-trace__dot');
    expect([...dots].map((dot) => dot.getAttribute('data-kind'))).toEqual(['api', 'event']);
  });

  it('没有条目时也显示两类筛选及颜色', () => {
    setup();

    expect(rows()).toHaveLength(0);
    expect(within(screen.getByTestId('filter-kind')).getAllByRole('button')).toHaveLength(2);
  });

  it('只呈现 RTM 两类，条目类型没有第三种取值', () => {
    const { host } = setup();
    host.record({ name: 'rtm.login', kind: 'api' });
    host.record({ name: 'presence', kind: 'event' });

    // 类型筛选器的选项就是全部出现过的 kind，恒定只有这两个。
    const options = within(screen.getByTestId('filter-kind')).getAllByRole('button');
    expect(options.map((button) => button.getAttribute('aria-label'))).toEqual(['调用 RTM API', '收到 RTM 事件']);
    // pill 上的计数跟随各类条目数。
    expect(options.map((button) => button.textContent)).toEqual(['API1', 'EVENT1']);
  });

  it('默认展示 linkState 事件，可手动隐藏连接事件', async () => {
    const { host } = setup();
    host.record({ name: 'linkState', kind: 'event' });
    host.record({ name: 'storage', kind: 'event' });

    expect(rowTexts()).toEqual([
      expect.stringContaining('storage'),
      expect.stringContaining('linkState'),
    ]);
    await userEvent.setup().click(screen.getByRole('button', { name: '隐藏连接' }));
    expect(rowTexts()).toEqual([expect.stringContaining('storage')]);
  });
});

describe('uid badge 配色', () => {
  it('每条前置 uid badge，颜色取自角色，同角色同色', () => {
    const { host, audience } = setup();
    // 显式给递增时间戳：同毫秒时 `seq` 只在实例内单调，跨实例的先后本就无法定义
    // （见 mergeTraces）。这里要盯的是 badge 配色，不该顺带依赖那个未定义的次序。
    host.record({ name: 'rtm.login', at: BASE });
    host.record({ name: 'storage.set', at: BASE + 1 });
    audience.record({ name: 'rtm.login', at: BASE + 2 });

    const badges = screen.getAllByTestId('uid-badge');
    expect(badges.map((badge) => badge.textContent)).toEqual([
      'audience-bbb',
      'host-aaa',
      'host-aaa',
    ]);

    // 同角色两条的内联样式完全一致；跨角色必须不同。
    expect(badges[1].getAttribute('style')).toBe(badges[2].getAttribute('style'));
    expect(badges[1].getAttribute('style')).not.toBe(badges[0].getAttribute('style'));
  });

  it('颜色来自 roleColors 这一处来源，与主区身份条同源', () => {
    const { host, audience } = setup();
    host.record({ name: 'rtm.login' });
    audience.record({ name: 'rtm.login' });

    const badges = screen.getAllByTestId('uid-badge');
    for (const badge of badges) {
      const role = badge.getAttribute('data-role')!;
      const { accent, soft } = roleColor(role);
      const style = badge.getAttribute('style') ?? '';
      expect(style).toContain(accent);
      expect(style).toContain(soft);
    }

    // 护栏：面板自己不写颜色字面量，否则两处配色一定漂移。
    expect(panelSource).toContain("from './roleColors'");
    expect(panelSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('未登记的角色走兜底配色，不崩', () => {
    const stranger = endpoint('teacher-ccc', 'teacher');
    const sources = [stranger.source];
    render(<TimelinePanel sources={sources} />);
    stranger.record({ name: 'rtm.login' });

    const badge = screen.getByTestId('uid-badge');
    expect(badge.textContent).toBe('teacher-ccc');
    expect(badge.getAttribute('style')).toContain(roleColor('teacher').accent);
  });
});

describe('时间格式', () => {
  it('使用北京时间，显示时分秒毫秒', () => {
    const { host } = setup();
    host.record({ name: 'rtm.login' });

    const time = rows()[0].querySelector('.lab-trace__time');
    expect(time?.textContent).toBe('17:12:34.567');
  });

  it('毫秒补到三位，便于分辨紧邻调用', () => {
    const host = endpoint('host-aaa', 'host');
    const sources = [host.source];
    render(<TimelinePanel sources={sources} />);
    act(() => {
      host.store.record({ at: Date.UTC(2026, 0, 1, 9, 5, 6, 7), kind: 'api', name: 'a' });
    });

    expect(rows()[0].querySelector('.lab-trace__time')?.textContent).toBe('17:05:06.007');
  });
});

describe('类型筛选', () => {
  /** 两端各两类，共 4 条，覆盖 API 与事件。 */
  function seed() {
    const context = setup();
    context.host.record({ name: 'rtm.login', kind: 'api' });
    context.host.record({ name: 'message', kind: 'event' });
    context.audience.record({ name: 'rtm.login', kind: 'api' });
    context.audience.record({ name: 'presence', kind: 'event' });
    return context;
  }

  it('按条目类型筛选', async () => {
    const user = userEvent.setup();
    seed();
    expect(rows()).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: '收到 RTM 事件' }));

    expect(rows()).toHaveLength(2);
    expect(rows().every((row) => row.getAttribute('data-kind') === 'event')).toBe(true);
  });

  it('只提供类型筛选，不渲染角色或 UID 筛选', () => {
    seed();

    expect(screen.getByTestId('filter-kind')).toBeInTheDocument();
    expect(screen.queryByTestId('filter-role')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-uid')).not.toBeInTheDocument();
  });

});

describe('取消筛选后条目恢复', () => {
  function seed() {
    const context = setup();
    context.host.record({ name: 'rtm.login', kind: 'api' });
    context.host.record({ name: 'message', kind: 'event' });
    context.audience.record({ name: 'rtm.login', kind: 'api' });
    return context;
  }

  it('再次点击选中类型恢复全部条目，且被筛掉的条目一直在 store 里', async () => {
    const user = userEvent.setup();
    const { host, audience } = seed();
    const before = rowTexts();

    await user.click(screen.getByRole('button', { name: '收到 RTM 事件' }));
    expect(rows()).toHaveLength(1);

    // 关键断言：被筛掉的条目仍然在两端的 store 里 —— 证明筛选是纯 UI 过滤。
    expect(host.store.getEntries()).toHaveLength(2);
    expect(audience.store.getEntries()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '收到 RTM 事件' }));

    expect(rowTexts()).toEqual(before);
  });

  it('选中项再点一次即取消，同样恢复全部', async () => {
    const user = userEvent.setup();
    seed();
    const before = rowTexts();
    const button = screen.getByRole('button', { name: '调用 RTM API' });

    await user.click(button);
    expect(rows()).toHaveLength(2);

    await user.click(button);

    expect(rowTexts()).toEqual(before);
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('筛选期间新到的条目也会随取消筛选一起出现', async () => {
    const user = userEvent.setup();
    const { audience } = seed();

    await user.click(screen.getByRole('button', { name: '收到 RTM 事件' }));
    expect(rows()).toHaveLength(1);

    // 筛选态下听众端又记了一条 API：不该显示，但必须已经进 store。
    audience.record({ name: 'storage.get' });
    expect(rows()).toHaveLength(1);
    expect(audience.store.getEntries()).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: '收到 RTM 事件' }));

    expect(rows()).toHaveLength(4);
    expect(rowTexts().join('')).toContain('storage.get');
  });
});

describe('筛选是面板局部状态', () => {
  it('筛选不影响 trace 采集：筛选态下 record 照样进 store', async () => {
    const user = userEvent.setup();
    const { host } = setup();
    host.record({ name: 'rtm.login', kind: 'api' });

    await user.click(screen.getByRole('button', { name: '调用 RTM API' }));
    host.record({ name: 'message', kind: 'event' });

    expect(host.store.getEntries().map((entry) => entry.name)).toEqual(['rtm.login', 'message']);
  });

  it('筛选不影响环形缓冲的丢弃逻辑：丢的仍是最旧的，与筛选无关', async () => {
    const user = userEvent.setup();
    const { host } = setup({ limit: 3 });

    host.record({ name: 'a-1', kind: 'event' });
    host.record({ name: 'a-2', kind: 'api' });

    // 先开一个把 event 全筛掉的筛选，再继续记。
    await user.click(screen.getByRole('button', { name: '调用 RTM API' }));

    host.record({ name: 'a-3', kind: 'event' });
    host.record({ name: 'a-4', kind: 'api' });
    host.record({ name: 'a-5', kind: 'event' });

    // 保留最后 3 条，被筛掉的 event 条目并没有因为不可见就被优先丢弃。
    expect(host.store.getEntries().map((entry) => entry.name)).toEqual(['a-3', 'a-4', 'a-5']);
  });

  it('筛选状态不写进 store，也不随另一个面板实例共享', async () => {
    const user = userEvent.setup();
    const host = endpoint('host-aaa', 'host');
    const sources = [host.source];
    render(
      <>
        <div data-testid="panel-a">
          <TimelinePanel sources={sources} />
        </div>
        <div data-testid="panel-b">
          <TimelinePanel sources={sources} />
        </div>
      </>,
    );
    host.record({ name: 'rtm.login', kind: 'api' });
    host.record({ name: 'message', kind: 'event' });

    const panelA = screen.getByTestId('panel-a');
    await user.click(within(panelA).getByRole('button', { name: '调用 RTM API' }));

    expect(within(panelA).getAllByTestId('trace-row')).toHaveLength(1);
    // 另一个实例不受影响 —— 筛选是局部状态。
    expect(within(screen.getByTestId('panel-b')).getAllByTestId('trace-row')).toHaveLength(2);
  });
});

describe('清空与折叠', () => {
  it('「清空」把每个来源都清掉，条目消失', async () => {
    const user = userEvent.setup();
    const { host, audience } = setup();
    host.record({ name: 'rtm.login' });
    audience.record({ name: 'rtm.login' });
    expect(rows()).toHaveLength(2);

    await user.click(screen.getByTestId('timeline-clear'));

    expect(rows()).toHaveLength(0);
    expect(host.store.getEntries()).toHaveLength(0);
    expect(audience.store.getEntries()).toHaveLength(0);
  });

  it('来源不支持 clear 时点「清空」不抛错', async () => {
    const user = userEvent.setup();
    const store = createTraceStore({ uid: 'host-aaa', role: 'host' });
    // 刻意省掉 clear：静态快照类来源也应该能喂进面板。
    const readOnly: TraceSource = {
      getEntries: () => store.getEntries(),
      subscribe: (listener) => store.subscribe(listener),
    };
    const sources = [readOnly];
    render(<TimelinePanel sources={sources} />);
    act(() => store.record({ at: BASE, kind: 'api', name: 'rtm.login' }));

    await user.click(screen.getByTestId('timeline-clear'));

    expect(rows()).toHaveLength(1);
  });

  it('「折叠」按钮存在并回调外层 —— 折叠态由外层持有，它要改外壳栅格', async () => {
    const user = userEvent.setup();
    const { onToggleCollapsed } = setup();

    const toggle = screen.getByTestId('timeline-toggle');
    expect(toggle).toHaveAttribute('aria-label', '折叠数据流');
    await user.click(toggle);

    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('折叠态只留一条竖条与条目计数，可再展开', async () => {
    const user = userEvent.setup();
    const host = endpoint('host-aaa', 'host');
    const sources = [host.source];
    const onToggleCollapsed = vi.fn();
    render(
      <TimelinePanel sources={sources} collapsed onToggleCollapsed={onToggleCollapsed} />,
    );
    host.record({ name: 'rtm.login' });

    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId('timeline-count').textContent).toBe('1');
    expect(screen.queryByTestId('filter-kind')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('timeline-toggle'));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('折叠不清数据：展开后条目还在', () => {
    const host = endpoint('host-aaa', 'host');
    const sources = [host.source];
    const { rerender } = render(<TimelinePanel sources={sources} collapsed />);
    host.record({ name: 'rtm.login' });

    rerender(<TimelinePanel sources={sources} collapsed={false} />);

    expect(rows()).toHaveLength(1);
  });
});

describe('没有「已截断」提示', () => {
  it('超过环形上限后静默丢弃最旧的，面板不出现任何截断字样', () => {
    const { host, view } = setup({ limit: 3 });
    for (let i = 1; i <= 6; i += 1) host.record({ name: `call-${i}` });

    expect(rows()).toHaveLength(3);
    expect(rowTexts().join('')).toContain('call-6');
    expect(rowTexts().join('')).not.toContain('call-1');
    expect(view.container.textContent ?? '').not.toMatch(/截断|省略|truncat/i);
  });

  it('面板源码里没有截断相关的界面文案', () => {
    // 只看代码，不看注释 —— 头部注释里「没有『已截断』提示」这句话是**说明这条约束
    // 存在**的，把它一起断掉会逼人删掉解释，正好丢掉最该留的那段。
    const withoutComments = panelSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(withoutComments).not.toMatch(/截断|省略|truncat/i);
  });
});

describe('时间与正文两列，第二行完整换行展示', () => {
  it('.lab-trace 为完整 HH:MM:SS.mmm 时间保留 86px 轨道', () => {
    const block = stylesSource.match(/\.lab-trace \{([^}]*)\}/)?.[1] ?? '';

    expect(block).toContain('display: grid');
    expect(block.replace(/\s+/g, ' ')).toContain('grid-template-columns: 86px minmax(0, 1fr)');
    const time = stylesSource.match(/\.lab-trace__time \{([^}]*)\}/)?.[1] ?? '';
    expect(time).toContain('white-space: nowrap');
  });

  it('每行按序渲染时间与正文，类型标签与名称在首行', () => {
    const { host } = setup();
    host.record({ name: 'rtm.login', summary: 'uid=host-aaa', durationMs: 12 });

    const children = [...rows()[0].children];
    expect(children.map((child) => child.className)).toEqual([
      'lab-trace__time',
      'lab-trace__body',
    ]);
    // 正文首行是类型 + 名称 + uid badge（CSS 隐藏）+ 耗时，次行是摘要。
    const body = children[1];
    expect(body.querySelector('.lab-trace__head')?.textContent).toBe('APIrtm.loginhost-aaa12ms');
    expect(body.querySelector('.lab-trace__summary')?.textContent).toBe('uid=host-aaa');
  });

  it('高精度 API 耗时最多显示到微秒对应的三位小数', () => {
    const { host } = setup();
    host.record({ name: 'rtm.publish', durationMs: 12.34567 });

    expect(screen.getByText('12.346ms')).toBeTruthy();
  });

  it('失败条目带错误码与错误信息', () => {
    const { host } = setup();
    host.record({ name: 'lock.acquire', errorCode: -14008, errorMessage: 'LOCK_NOT_EXIST' });

    const error = screen.getByTestId('trace-error');
    expect(error.textContent).toContain('-14008');
    expect(error.textContent).toContain('LOCK_NOT_EXIST');
    expect(rows()[0]).toHaveAttribute('data-failed', 'true');
    expect(rows()[0]).toHaveAttribute('title', '-14008 LOCK_NOT_EXIST');
    expect(error.parentElement).toHaveClass('lab-trace__summary');
  });

  it('长摘要保留原文，并通过整行悬浮提示提供全文', () => {
    const { host } = setup();
    const summary = '这是一条需要完整保留的长摘要。'.repeat(20);
    host.record({ name: 'rtm.publish', summary });

    expect(rows()[0]).toHaveAttribute('title', summary);
    expect(rows()[0].querySelector('.lab-trace__summary-text')?.textContent).toBe(summary);
  });

  it('长摘要取消固定行高和单行省略，允许按内容撑高换行', () => {
    const row = stylesSource.match(/\.lab-trace \{([^}]*)\}/)?.[1] ?? '';
    const summary = stylesSource.match(/\.lab-trace__summary \{([^}]*)\}/)?.[1] ?? '';
    const summaryText = stylesSource.match(/\.lab-trace__summary-text \{([^}]*)\}/)?.[1] ?? '';

    expect(row).toContain('min-height: var(--ink-trace-row-h)');
    expect(row).not.toMatch(/(?:^|\s)height:\s*var\(--ink-trace-row-h\)/);
    expect(summary).toContain('white-space: normal');
    expect(summary).toContain('overflow: visible');
    expect(summaryText).toContain('overflow-wrap: anywhere');
    expect(summaryText).not.toContain('text-overflow: ellipsis');
  });

  it('失败摘要与错误保留在同一详情区，完整悬浮提示不会丢掉诊断信息', () => {
    const { host } = setup();
    const summary = '向房间发送消息。'.repeat(20);
    const errorMessage = '请求失败：连接已中断，请检查网络后重试。'.repeat(10);
    host.record({ name: 'rtm.publish', summary, errorCode: -10001, errorMessage });

    const row = rows()[0];
    expect(row).toHaveAttribute('title', `${summary}\n-10001 ${errorMessage}`);
    const detail = row.querySelector('.lab-trace__summary');
    const error = screen.getByTestId('trace-error');
    expect(detail?.querySelector('.lab-trace__summary-text')?.textContent).toBe(summary);
    expect(error.parentElement).toBe(detail);
    expect(error.querySelector('code')?.textContent).toBe('-10001');
    expect(error.querySelector('.lab-trace__error-message')?.textContent).toBe(errorMessage);
  });

  it.each([
    { errorCode: 0, errorMessage: undefined, title: '0' },
    { errorCode: undefined, errorMessage: 'REQUEST_FAILED', title: 'REQUEST_FAILED' },
  ])('只有错误码或信息时仍保留详情与悬浮提示：$title', ({ errorCode, errorMessage, title }) => {
    const { host } = setup();
    host.record({ name: 'rtm.publish', errorCode, errorMessage });

    expect(rows()[0]).toHaveAttribute('title', title);
    expect(screen.getByTestId('trace-error').textContent).toBe(title);
    expect(rows()[0]).toHaveAttribute('data-failed', 'true');
  });
});

describe('外部 store 订阅，不轮询', () => {
  it('订阅每一个来源，卸载时全部退订', () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const source: TraceSource = { getEntries: () => [], subscribe };
    const sources = [source, { getEntries: () => [], subscribe }];

    const { unmount } = render(<TimelinePanel sources={sources} />);
    expect(subscribe).toHaveBeenCalledTimes(2);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('record 的瞬间条目就出现，不需要推进任何定时器', () => {
    vi.useFakeTimers();
    try {
      const { host } = setup();
      host.record({ name: 'rtm.login' });

      // 一个定时器都没推进，节点已经在了 —— 说明走的是订阅而不是轮询。
      expect(rows()).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('面板不含轮询代码', () => {
    expect(panelSource).not.toContain('setInterval');
    expect(panelSource).not.toContain('setTimeout');
    // 走 React 官方的外部 store 钩子（在 useMergedTraces 里）。
    expect(panelSource).toContain('useMergedTraces');
  });

  it('未变化时不重渲染 —— getSnapshot 返回同一引用，否则会无限渲染', () => {
    let renders = 0;
    function Probe({ sources }: { sources: readonly TraceSource[] }) {
      renders += 1;
      return <TimelinePanel sources={sources} />;
    }
    const host = endpoint('host-aaa', 'host');
    const sources = [host.source];
    render(<Probe sources={sources} />);
    const baseline = renders;

    // 通知一次但没有新条目：快照引用不变，不该无限渲染。
    act(() => host.store.clear());

    expect(renders - baseline).toBeLessThanOrEqual(2);
    expect(rows()).toHaveLength(0);
  });

  it('多端乱序记录按时间从新到旧交错展示，不改来源快照', () => {
    const host = endpoint('host-aaa', 'host');
    const audience = endpoint('audience-bbb', 'audience');
    const sources = [host.source, audience.source];
    render(<TimelinePanel sources={sources} />);

    // 刻意乱序写入，且房主的两条夹住听众那条。
    act(() => {
      host.store.record({ at: BASE + 30, kind: 'api', name: 'host-late' });
      audience.store.record({ at: BASE + 20, kind: 'event', name: 'audience-mid' });
      host.store.record({ at: BASE + 10, kind: 'api', name: 'host-early' });
    });

    // 只有一个列表容器（不是每端一列），展示次序以时间为准，不以写入时刻为准。
    expect(screen.getAllByRole('list')).toHaveLength(1);
    expect(rowTexts().map((text) => text.replace(/^[\d:.]+/, '').trim())).toEqual([
      'APIhost-latehost-aaa',
      'EVENTaudience-midaudience-bbb',
      'APIhost-earlyhost-aaa',
    ]);
    expect(host.store.getEntries().map((entry) => entry.name)).toEqual(['host-late', 'host-early']);
    expect(audience.store.getEntries().map((entry) => entry.name)).toEqual(['audience-mid']);
  });

  it('同毫秒先展示后记录的条目，筛选与恢复仍保持倒序', async () => {
    const { host } = setup();
    host.record({ name: 'first-call', kind: 'api' });
    host.record({ name: 'middle-event', kind: 'event' });
    host.record({ name: 'last-call', kind: 'api' });
    const names = () => rows().map((row) => row.querySelector('.lab-trace__name')?.textContent);
    expect(names()).toEqual(['last-call', 'middle-event', 'first-call']);
    const body = screen.getByTestId('timeline-body');
    body.scrollTop = 100;

    const filter = screen.getByRole('button', { name: '调用 RTM API' });
    await userEvent.setup().click(filter);
    expect(names()).toEqual(['last-call', 'first-call']);
    expect(body.scrollTop).toBe(0);
    await userEvent.setup().click(filter);
    expect(names()).toEqual(['last-call', 'middle-event', 'first-call']);
    expect(host.store.getEntries().map((entry) => entry.name)).toEqual(['first-call', 'middle-event', 'last-call']);
  });

  it('页面 login 与角色 trace 共享 uid/seq 时仍使用不同 React key', () => {
    const page = endpoint('user-1', 'page');
    const host = endpoint('user-1', 'host');
    render(<TimelinePanel sources={[page.source, host.source]} />);

    page.record({ name: 'rtm.login', kind: 'api' });
    host.record({ name: 'rtm.subscribe', kind: 'api' });

    expect(rows()).toHaveLength(2);
    expect(rowTexts().join(' ')).toContain('rtm.login');
    expect(rowTexts().join(' ')).toContain('rtm.subscribe');
  });

  it('toTraceSource 把 RTM 单文件的方法名适配过来，不改单文件的命名', () => {
    const store = createTraceStore({ uid: 'host-aaa', role: 'host' });
    const client = {
      getTraces: () => store.getEntries(),
      subscribeTraces: (listener: () => void) => store.subscribe(listener),
      clearTraces: () => store.clear(),
    };
    const sources = [toTraceSource(client)];
    render(<TimelinePanel sources={sources} />);
    act(() => store.record({ at: BASE, kind: 'api', name: 'rtm.login' }));

    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId('uid-badge').textContent).toBe('host-aaa');
  });
});
