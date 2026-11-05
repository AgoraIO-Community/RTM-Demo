import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { LabRoutes, sceneComponents } from './App';
import { experienceScenarios } from './experienceScenarios';
import { CAPABILITY_APIS } from './ScenePlaceholder';
import { capabilitiesOf } from '../scenes/capabilities';
import { allScenes } from '../scenes/registry';
import { createVoiceRoomFakes } from '../scenes/voice-room/test/testing';
import { createOneToOneCallFakes } from '../scenes/one-to-one-call/test/scene.test-helpers';

/** 已配置的 env，供大多数用例复用。 */
const CONFIGURED = { configured: true, appId: 'test-app-id', source: 'window.__ENV__' } as const;

/**
 * 测起始路径用 `MemoryRouter` 包 `LabRoutes`。
 * `App` 自带 `BrowserRouter`，路由表单独导出正是为了让测试能换 router。
 *
 * **必须注入语聊房替身。** 语聊房场景一挂载就自动连接（零表单进房），不注入的话
 * 这里每个用例都会去连真实 RTM。外壳测试关心的是路由与四层布局，不是连接结果。
 */
function renderApp(
  options: { env?: typeof CONFIGURED | { configured: false }; path?: string } = {},
) {
  const { env = CONFIGURED, path = '/' } = options;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LabRoutes env={env} voiceRoomOverrides={createVoiceRoomFakes().overrides}
        oneToOneCallOverrides={createOneToOneCallFakes().overrides} />
    </MemoryRouter>,
  );
}

describe('实验室外壳', () => {
  it('顶栏不展示 App ID 或其 env 来源', () => {
    renderApp();

    expect(screen.queryByTestId('env-hint')).not.toBeInTheDocument();
    expect(screen.queryByText(/App ID 来自/)).not.toBeInTheDocument();
  });

  it('顶部只有指定的七个一级场景，直接指向对应内容', () => {
    renderApp();
    const nav = screen.getByRole('navigation', { name: '一级场景分类' });
    // 导航项带等宽序号 01–07，序号对读屏隐藏，可访问名仍是场景名。
    expect(Array.from(nav.children).map((item) => item.textContent)).toEqual([
      '01语聊房', '021V1呼叫邀请', '03电商直播', '04在线课堂', '05虚拟世界', '06游戏互动', '07文档协同',
    ]);
    for (const scenario of experienceScenarios) {
      if (scenario.status === 'ready') {
        expect(within(nav).getByRole('link', { name: scenario.label })).toHaveAttribute('href', scenario.path);
      } else {
        expect(within(nav).getByRole('button', { name: scenario.label })).toHaveAttribute('aria-disabled', 'true');
        expect(within(nav).queryByRole('link', { name: scenario.label })).not.toBeInTheDocument();
      }
    }
    expect(screen.queryByRole('navigation', { name: '二级场景' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: '语聊房' })).toHaveAttribute('aria-current', 'page');
  });

  it('所有未建场景的独立 URL 均显示对应标题和体验路径', () => {
    for (const scenario of experienceScenarios.filter((item) => item.status === 'planned')) {
      const view = renderApp({ path: scenario.path });
      const link = within(screen.getByRole('navigation')).getByRole('button', { name: scenario.label });
      expect(link).toHaveAttribute('aria-current', 'page');
      expect(within(screen.getByTestId('scene-placeholder')).getByRole('heading', { name: scenario.label })).toBeInTheDocument();
      const path = screen.getByRole('complementary', { name: '体验路径' });
      expect(within(path).getByText(`${scenario.label}的体验任务正在准备中。`)).toBeInTheDocument();
      expect(within(path).queryByRole('progressbar')).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('未开放导航提示即将上线，点击后仍停留在当前场景', async () => {
    const user = userEvent.setup();
    renderApp();
    for (const scenario of experienceScenarios.filter(item => item.status === 'planned')) {
      await user.click(screen.getByRole('button', { name: scenario.label }));
      expect(screen.getByRole('status')).toHaveTextContent('即将上线，敬请期待');
      expect(screen.getByTestId('scene-voice-room')).toBeInTheDocument();
    }
  });

  it.each([
    ['/social/voice-room', '新开听众页'],
    ['/social/one-to-one-call', '新开体验页'],
  ])('场景 %s 的新标签页入口使用独立身份和干净 URL', async (path, label) => {
    renderApp({ path });
    const link = await screen.findByRole('link', { name: label });
    expect(link).toHaveAttribute('href', path);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('体验路径有五步任务、Console 和三项文档入口，悬浮说明不会手动完成任务', async () => {
    const user = userEvent.setup();
    renderApp();
    const path = screen.getByRole('complementary', { name: '体验路径' });
    expect(within(path).getByRole('heading', { name: /场景任务/ })).toBeInTheDocument();
    expect(within(path).getByRole('heading', { name: /开始构建/ })).toBeInTheDocument();
    expect(within(path).getByRole('heading', { name: /开发文档/ })).toBeInTheDocument();
    expect(within(path).getByRole('progressbar')).toHaveAttribute('aria-valuemax', '5');
    for (const step of experienceScenarios[0].steps) {
      const button = within(path).getByRole('button', { name: new RegExp(step.title) });
      await user.hover(button);
      expect(screen.getByRole('tooltip')).toHaveTextContent(step.instruction);
      expect(within(path).queryByText(step.milestones[0].label)).not.toBeInTheDocument();
      await user.unhover(button);
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    }
    expect(within(path).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    for (const label of ['前往 Console 创建项目', '产品简介', '最佳实践', 'API参考']) {
      const link = within(path).getByRole('link', { name: label });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('href')).toMatch(/^https:\/\//);
    }
  });

  it('时间线面板占位存在于主体内', () => {
    renderApp();

    expect(screen.getByRole('complementary', { name: '时间线' })).toBeInTheDocument();
  });

  it('左右栏都由外壳持有折叠态，折叠后工作区栅格收为窄栏', async () => {
    const user = userEvent.setup();
    const { container } = renderApp({ path: '/social/voice-room' });
    const workspace = container.querySelector<HTMLElement>('.lab-workspace')!;
    expect(workspace).toHaveAttribute('data-left', 'expanded');
    expect(workspace).toHaveAttribute('data-timeline', 'expanded');
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '折叠数据流' }));
    expect(workspace).toHaveAttribute('data-timeline', 'collapsed');
    expect(screen.getByTestId('timeline-count')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '体验路径' }));
    expect(workspace).toHaveAttribute('data-left', 'collapsed');
    expect(screen.getByRole('complementary', { name: '体验路径' })).toHaveAttribute('data-collapsed', 'true');

    await user.click(screen.getByRole('button', { name: '展开数据流' }));
    expect(workspace).toHaveAttribute('data-timeline', 'expanded');
  });

  it('顶栏提供主题切换，切换后 <html data-theme> 与按钮标签同步', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/social/voice-room' });
    const toggle = screen.getByTestId('theme-toggle');
    expect(toggle).toHaveTextContent('LIGHT');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await user.click(toggle);
    expect(toggle).toHaveTextContent('DARK');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    await user.click(toggle);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    window.localStorage.removeItem('rtm-lab.theme');
  });

  it('顶栏显示页面级 RTM 连接状态；未配置 App ID 时显示 NO APP ID', async () => {
    renderApp({ path: '/social/voice-room' });
    await waitFor(() => expect(screen.getByTestId('connection-state')).toHaveTextContent('CONNECTED'));

    renderApp({ env: { configured: false }, path: '/social/voice-room' });
    const states = screen.getAllByTestId('connection-state');
    expect(states[states.length - 1]).toHaveTextContent('NO APP ID');
  });

  it('场景链接交给浏览器整页导航，不被 SPA 路由拦截', () => {
    renderApp({ path: '/social/voice-room' });
    let preventedByRouter: boolean | undefined;
    // React's delegated handler runs first; prevent jsdom navigation only after observing it.
    document.addEventListener('click', (event) => {
      preventedByRouter = event.defaultPrevented;
      event.preventDefault();
    }, { once: true });
    fireEvent.click(screen.getByRole('link', { name: '1V1呼叫邀请' }));
    expect(preventedByRouter).toBe(false);
  });

  it('重新加载当前场景保留 URL 身份参数，其他场景使用独立入口', () => {
    renderApp({ path: '/social/voice-room?data=room-identity' });
    const nav = screen.getByRole('navigation', { name: '一级场景分类' });
    expect(within(nav).getByRole('link', { name: '语聊房' })).toHaveAttribute('href', '/social/voice-room?data=room-identity');
    expect(within(nav).getByRole('link', { name: '1V1呼叫邀请' })).toHaveAttribute('href', '/social/one-to-one-call');
  });

  it('房间准入通过 replaceState 更新 URL 后，当前场景导航仍保留最新身份', () => {
    const originalUrl = window.location.href;
    renderApp({ path: '/social/voice-room' });
    const link = within(screen.getByRole('navigation')).getByRole('link', { name: '语聊房' });
    try {
      window.history.replaceState(null, '', '/social/voice-room?data=latest-room-identity');
      document.addEventListener('click', event => event.preventDefault(), { once: true });
      fireEvent.click(link);
      expect(new URL(link.getAttribute('href')!, window.location.origin).search).toBe('?data=latest-room-identity');
    } finally {
      window.history.replaceState(null, '', originalUrl);
    }
  });
});

describe('路由', () => {
  it('根路径重定向到语聊房 —— 唯一已实现的场景', () => {
    renderApp({ path: '/' });

    expect(screen.getByTestId('scene-voice-room')).toBeInTheDocument();
  });

  it('URL 形如「一级分类 / 二级场景」', () => {
    renderApp({ path: '/social/voice-room' });

    expect(screen.getByTestId('scene-voice-room')).toBeInTheDocument();
  });

  it('未知场景 id 渲染未找到提示，不白屏', () => {
    renderApp({ path: '/social/no-such-scene' });

    expect(screen.getByText(/未找到/)).toBeInTheDocument();
  });

  it('一级分类必须真的包含该二级场景 —— 错配的 URL 不渲染场景', () => {
    // voice-room 归社交，不归游戏。放行会让二级 tab 没有 active 项，
    // 「一级 / 二级」的从属关系形同虚设。
    renderApp({ path: '/gaming/voice-room' });

    expect(screen.queryByTestId('scene-voice-room')).not.toBeInTheDocument();
    expect(screen.getByText(/未找到/)).toBeInTheDocument();
  });
});

describe('已实现场景的主区容器', () => {
  it('1V1 呼叫邀请渲染真实工作台而不是占位页', async () => {
    renderApp({ path: '/social/one-to-one-call' });
    expect(await screen.findByTestId('one-to-one-call-workbench')).toBeInTheDocument();
    expect(screen.queryByTestId('scene-placeholder')).not.toBeInTheDocument();
    expect(sceneComponents.has('one-to-one-call')).toBe(true);
  });

  it('由注册表按 id 映射到组件，未登记映射的 ready 场景不静默渲染成语聊房', () => {
    // 护栏：将来加第二个 ready 场景时，忘了登记映射必须能被发现，
    // 而不是静默渲染出语聊房。
    renderApp({ path: '/social/voice-room' });

    expect(screen.getByTestId('scene-voice-room')).toBeInTheDocument();
    expect(sceneComponents.has('voice-room')).toBe(true);
    // 每个登记了映射的 id 都必须真的是 ready 状态
    for (const sceneId of sceneComponents.keys()) {
      expect(allScenes.find((scene) => scene.id === sceneId)?.status).toBe('ready');
    }
    // 反过来：每个 ready 场景都必须登记映射
    for (const scene of allScenes.filter((entry) => entry.status === 'ready')) {
      expect(sceneComponents.has(scene.id)).toBe(true);
    }
  });
});

describe('占位页', () => {
  it('计划中场景点进去是统一占位页', () => {
    renderApp({ path: '/social/live-pk' });

    expect(screen.getByTestId('scene-placeholder')).toBeInTheDocument();
  });

  it('占位页复用同一个组件，不给每个未实现场景单独写文案', () => {
    renderApp({ path: '/social/live-pk' });
    const first = screen.getByTestId('scene-placeholder').textContent ?? '';

    renderApp({ path: '/gaming/game-voice-chat' });
    const placeholders = screen.getAllByTestId('scene-placeholder');
    const second = placeholders[placeholders.length - 1].textContent ?? '';

    // 每个场景独有的部分只有标题、摘要与能力标签，全部来自注册表与能力登记表；
    // 抹掉它们之后剩下的引导文案必须完全相同 —— 那部分是共用的，不逐场景撰写。
    const strip = (text: string, sceneId: string) => {
      const scene = allScenes.find((entry) => entry.id === sceneId)!;
      const experience = experienceScenarios.find((item) => item.path.endsWith(`/${sceneId}`));
      let stripped = text.replace(experience?.label ?? scene.title, '').replace(experience?.description ?? scene.summary, '');
      for (const capability of capabilitiesOf(sceneId)) {
        stripped = stripped.replaceAll(CAPABILITY_APIS[capability], '').replaceAll(capability, '');
      }
      return stripped;
    };
    expect(strip(first, 'live-pk')).toBe(strip(second, 'game-voice-chat'));
  });

  it('占位页指向语聊房', () => {
    renderApp({ path: '/social/live-pk' });

    const placeholder = screen.getByTestId('scene-placeholder');
    expect(within(placeholder).getByRole('link', { name: /语聊房/ })).toBeInTheDocument();
  });

  it('占位页写明该场景计划演示哪些 RTM 能力', () => {
    renderApp({ path: '/social/live-pk' });

    const placeholder = screen.getByTestId('scene-placeholder');
    for (const capability of capabilitiesOf('live-pk')) {
      expect(within(placeholder).getByText(capability)).toBeInTheDocument();
    }
  });
});

describe('env 未配置', () => {
  it('渲染引导页，不进场景', () => {
    renderApp({ env: { configured: false }, path: '/social/voice-room' });

    expect(screen.getByTestId('env-guide')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '前往 Console 创建项目' })).toBeInTheDocument();
    expect(screen.queryByTestId('scene-voice-room')).not.toBeInTheDocument();
  });

  it('引导页给出本地与线上两种配置方式，措辞不用报错口吻', () => {
    renderApp({ env: { configured: false } });

    const guide = screen.getByTestId('env-guide');
    expect(guide.textContent).toContain('VITE_APP_ID');
    expect(guide.textContent).toContain('__ENV__');
    // 未配置不是异常，不该出现报错字样
    expect(guide.textContent).not.toMatch(/错误|失败|异常/);
  });
});
