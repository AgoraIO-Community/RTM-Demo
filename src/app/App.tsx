/** 三栏外壳：顶栏（品牌、编号导航、连接状态、主题）、左栏建议体验流程、中区场景、右栏 RTM 数据流。 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';

import { EnvGuide } from './EnvGuide';
import { experienceForPath, experienceScenarios } from './experienceScenarios';
import { ExperiencePath } from '../shared/experience/ExperiencePath';
import type { ExperienceProgress } from '../shared/experience/types';
import { ScenePlaceholder } from './ScenePlaceholder';
import type { ResolvedEnv } from './env';
import { SceneContextProvider, useSceneContext, type OneToOneCallOverrides, type VoiceRoomOverrides } from './sceneContext';
import { useTheme } from './theme';
import { findCategory, findScene } from '../scenes/registry';
import type { AppRtmLinkState } from '../scenes/voice-room/app-rtm';
import { TimelinePanel } from '../shared/timeline/TimelinePanel';
import type { TraceSource } from '../shared/timeline/useMergedTraces';
import { VoiceRoomScene } from '../scenes/voice-room/VoiceRoomScene';
import { OneToOneCallScene } from '../scenes/one-to-one-call/OneToOneCallScene';

/** Default scene for the single application entry. */
const DEFAULT_PATH = '/social/voice-room';

/** 响应式断点：设计基准 1440，<1280 右栏优先收起，<1024 左栏也收起。 */
const RIGHT_RAIL_QUERY = '(max-width: 1279px)';
const LEFT_RAIL_QUERY = '(max-width: 1023px)';

function mediaMatches(query: string): boolean {
  return window.matchMedia?.(query).matches ?? false;
}

/** 监听媒体查询翻转；跨过断点时收起或展开对应栏。 */
function useMediaFlip(query: string, onFlip: (matches: boolean) => void): void {
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media?.addEventListener) return;
    const listener = (event: MediaQueryListEvent) => onFlip(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [query, onFlip]);
}

/** One public entry per scenario; preserve existing URLs for invitation compatibility. */
function PrimaryTabs({ activePath }: { activePath: string }) {
  const { search, hash } = useLocation();
  const [plannedHint, setPlannedHint] = useState<{ id: string; x: number; y: number }>();
  const showPlannedHint = (element: HTMLElement, id: string) => {
    const rect = element.getBoundingClientRect();
    setPlannedHint({ id, x: Math.max(96, Math.min(rect.left + rect.width / 2, window.innerWidth - 96)), y: rect.bottom + 8 });
  };
  const preserveCurrentUrl = (element: HTMLAnchorElement, path: string) => {
    // Room admission updates history directly, so the router snapshot can lag behind.
    if (path === activePath && window.location.pathname === path) element.href = window.location.href;
  };
  return (
    <>
    <nav className="lab-tabs lab-tabs--primary" aria-label="一级场景分类"
      onWheel={() => setPlannedHint(undefined)} onTouchMove={() => setPlannedHint(undefined)}>
      {experienceScenarios.map((scenario, index) => scenario.status === 'planned' ? (
        <button key={scenario.id} type="button" className="lab-tab lab-tab--primary lab-tab--planned"
          aria-disabled="true" aria-describedby={plannedHint?.id === scenario.id ? 'planned-scene-hint' : undefined}
          data-active={scenario.path === activePath} aria-current={scenario.path === activePath ? 'page' : undefined}
          onMouseEnter={event => showPlannedHint(event.currentTarget, scenario.id)} onMouseLeave={() => setPlannedHint(undefined)}
          onFocus={event => showPlannedHint(event.currentTarget, scenario.id)} onBlur={() => setPlannedHint(undefined)}
          onClick={event => showPlannedHint(event.currentTarget, scenario.id)}>
          <span className="lab-tab__num" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          {scenario.label}
        </button>
      ) : (
        <Link key={scenario.id} to={scenario.path === activePath ? `${scenario.path}${search}${hash}` : scenario.path}
          reloadDocument className="lab-tab lab-tab--primary"
          onClick={event => preserveCurrentUrl(event.currentTarget, scenario.path)}
          onContextMenu={event => preserveCurrentUrl(event.currentTarget, scenario.path)}
          data-active={scenario.path === activePath} aria-current={scenario.path === activePath ? 'page' : undefined}>
          <span className="lab-tab__num" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          {scenario.label}
        </Link>
      ))}
    </nav>
    {plannedHint && <span id="planned-scene-hint" className="lab-tabs__notice" role="status"
      style={{ left: plannedHint.x, top: plannedHint.y }}>即将上线，敬请期待</span>}
    </>
  );
}

type ConnectionState = AppRtmLinkState | 'idle' | 'missing';

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  missing: 'NO APP ID',
  idle: 'IDLE',
  disconnected: 'IDLE',
  connecting: 'CONNECTING',
  connected: 'CONNECTED',
  reconnecting: 'RECONNECTING',
  failed: 'FAILED',
};

function ConnectionStatus({ state }: { state: ConnectionState }) {
  return (
    <div className="lab-connection" data-state={state} data-testid="connection-state" aria-label={`RTM 连接状态：${CONNECTION_LABELS[state]}`}>
      <span className="lab-connection__label" aria-hidden="true">RTM</span>
      <span className="lab-connection__dot" aria-hidden="true" />
      <span>{CONNECTION_LABELS[state]}</span>
    </div>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: 'light' | 'dark'; onToggle: () => void }) {
  const dark = theme === 'dark';
  return (
    <button type="button" className="lab-theme-toggle" onClick={onToggle}
      title={dark ? '切换到浅色主题' : '切换到深色主题'} aria-label={dark ? '切换到浅色主题' : '切换到深色主题'} aria-pressed={dark}
      data-testid="theme-toggle">
      <span className="lab-theme-toggle__swatch" aria-hidden="true" />
      {dark ? 'DARK' : 'LIGHT'}
    </button>
  );
}

/**
 * 场景还没交上来 trace 来源时的空数组。
 *
 * **必须是模块常量** —— 每次渲染新建数组会让 `useSyncExternalStore` 的 subscribe
 * 依赖变化而反复重订阅。
 */
const NO_TRACE_SOURCES: readonly TraceSource[] = [];

/** Mount the real scene only when configured; the shell and resource links remain available. */
function VoiceRoomContainer() {
  const { env, publishTraceSources, publishExperienceProgress, publishConnectionState, voiceRoomOverrides } = useSceneContext();
  if (!env.configured) return <EnvGuide />;
  return (
    <div className="lab-scene" data-testid="scene-voice-room">
      <VoiceRoomScene
        env={env}
        search={window.location.search}
        overrides={voiceRoomOverrides}
        onTraceSources={publishTraceSources}
        onExperienceProgress={publishExperienceProgress}
        onConnectionState={publishConnectionState}
      />
    </div>
  );
}

function OneToOneCallContainer() {
  const { env, publishTraceSources, publishExperienceProgress, publishConnectionState, oneToOneCallOverrides } = useSceneContext();
  if (!env.configured) return <EnvGuide />;
  return (
    <div className="lab-scene" data-testid="scene-one-to-one-call">
      <OneToOneCallScene env={env} overrides={oneToOneCallOverrides}
        onTraceSources={publishTraceSources} onExperienceProgress={publishExperienceProgress}
        onConnectionState={publishConnectionState} />
    </div>
  );
}

/**
 * 已实现场景的主区容器映射：场景 id → 组件。
 *
 * 刻意**不用**「非 planned 就渲染语聊房」的隐式分支 —— 那样将来加第二个已实现
 * 场景时，忘了登记映射会静默渲染出语聊房，而不是暴露问题。测试两个方向都断言：
 * 登记的必须是 ready，ready 的必须登记。
 */
export const sceneComponents = new Map<string, () => React.ReactElement>([
  ['voice-room', VoiceRoomContainer],
  ['one-to-one-call', OneToOneCallContainer],
]);

function SceneNotFound() {
  return (
    <div className="lab-scene-stub">
      <h1 className="lab-scene-stub__title">未找到这个场景</h1>
      <p>
        链接可能已失效。<Link to={DEFAULT_PATH} reloadDocument>前往语聊房</Link>
      </p>
    </div>
  );
}

/** 主区：已实现场景渲染自己的容器，已规划场景渲染统一占位页。 */
function SceneRoute() {
  const { categoryId = '', sceneId = '' } = useParams();
  const scene = findScene(sceneId);

  if (!scene) return <SceneNotFound />;

  // Validate legacy category/scene URLs even though navigation exposes a single level.
  const belongsToCategory = findCategory(categoryId)?.scenes.some((item) => item.id === sceneId);
  if (!belongsToCategory) return <SceneNotFound />;

  const experience = experienceForPath(`/${categoryId}/${sceneId}`);
  if (scene.status === 'planned') return <ScenePlaceholder scene={experience ? { ...scene, title: experience.label, summary: experience.description } : scene} />;

  const SceneContainer = sceneComponents.get(scene.id);
  if (!SceneContainer) return <SceneNotFound />;
  return <SceneContainer />;
}

interface LabShellProps {
  env: ResolvedEnv;
  voiceRoomOverrides?: VoiceRoomOverrides;
  oneToOneCallOverrides?: OneToOneCallOverrides;
}

/**
 * Shared shell for the current document. Scene navigation reloads the entire document.
 *
 * 左右栏的折叠态都由外壳持有：折叠会改变 `.lab-workspace` 的栅格列宽，那是外壳的样式。
 */
function LabShell({ env, voiceRoomOverrides, oneToOneCallOverrides }: LabShellProps) {
  const { categoryId = '', sceneId = '' } = useParams();
  const experience = experienceForPath(`/${categoryId}/${sceneId}`);
  const [theme, toggleTheme] = useTheme();
  const [experienceProgress, setExperienceProgress] = useState<ExperienceProgress>();
  const [leftOpen, setLeftOpen] = useState(() => !mediaMatches(LEFT_RAIL_QUERY));
  const [rightOpen, setRightOpen] = useState(() => !mediaMatches(RIGHT_RAIL_QUERY));
  const [connection, setConnection] = useState<AppRtmLinkState>();
  // Trace sources belong to the current document and reset on scene navigation.
  const [traceSources, setTraceSources] = useState<readonly TraceSource[]>(NO_TRACE_SOURCES);

  useMediaFlip(RIGHT_RAIL_QUERY, useCallback((matches: boolean) => setRightOpen(!matches), []));
  useMediaFlip(LEFT_RAIL_QUERY, useCallback((matches: boolean) => setLeftOpen(!matches), []));

  // **必须是稳定引用**：场景把它放进 effect 依赖（见 `sceneContext.ts`），
  // 每次渲染换新函数会让「交出 trace 来源」的 effect 反复重跑。
  const publishTraceSources = useCallback((sources: readonly TraceSource[]) => {
    // 空数组统一收敛到模块常量，避免场景卸载时交上来的新空数组触发下游重订阅。
    setTraceSources(sources.length > 0 ? sources : NO_TRACE_SOURCES);
  }, []);

  const sceneContext = useMemo(
    () => ({
      env,
      publishTraceSources,
      voiceRoomOverrides,
      oneToOneCallOverrides,
      publishExperienceProgress: setExperienceProgress,
      publishConnectionState: setConnection,
    }),
    [env, oneToOneCallOverrides, voiceRoomOverrides, publishTraceSources],
  );

  const connectionState: ConnectionState = !env.configured ? 'missing' : connection ?? 'idle';

  return (
    <div className="lab-shell">
      <header className="lab-topbar">
        <div className="lab-brand">RTM<span className="lab-brand__sub">在线体验馆</span></div>
        <PrimaryTabs activePath={`/${categoryId}/${sceneId}`} />
        <div className="lab-topbar__side">
          <ConnectionStatus state={connectionState} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>
      <div
        className="lab-workspace"
        data-left={leftOpen ? 'expanded' : 'collapsed'}
        data-timeline={rightOpen ? 'expanded' : 'collapsed'}
      >
        <ExperiencePath
          scenario={experience}
          progress={experienceProgress}
          collapsed={!leftOpen}
          onToggle={() => setLeftOpen((current) => !current)}
        />
        <main className="lab-body" data-timeline={rightOpen ? 'expanded' : 'collapsed'}>
          <SceneContextProvider value={sceneContext}>
            <Outlet />
          </SceneContextProvider>
        </main>
        <TimelinePanel
          sources={traceSources}
          collapsed={!rightOpen}
          onToggleCollapsed={() => setRightOpen((current) => !current)}
        />
      </div>
    </div>
  );
}

export interface LabRoutesProps {
  env: ResolvedEnv;
  /**
   * 外壳的依赖注入点，只有测试会传。
   *
   * 语聊房场景一挂载就自动连接，测试如果不注入假工厂就会去连真实 RTM。
   * 生产入口（`main.tsx`）不传这个 prop，所以它不改变线上行为。
   */
  voiceRoomOverrides?: VoiceRoomOverrides;
  oneToOneCallOverrides?: OneToOneCallOverrides;
}

/**
 * 路由表。不自带 router —— 由调用方提供 router 上下文，测试因此可以用
 * `MemoryRouter` 指定起始路径，生产代码用 `BrowserRouter`。
 */
export function LabRoutes({ env, voiceRoomOverrides, oneToOneCallOverrides }: LabRoutesProps) {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={DEFAULT_PATH} replace />} />
      <Route
        path="/:categoryId/:sceneId"
        element={<LabShell env={env} voiceRoomOverrides={voiceRoomOverrides} oneToOneCallOverrides={oneToOneCallOverrides} />}
      >
        <Route index element={<SceneRoute />} />
      </Route>
      <Route path="*" element={<Navigate to={DEFAULT_PATH} replace />} />
    </Routes>
  );
}

export function App({ env }: LabRoutesProps) {
  return (
    <BrowserRouter>
      <LabRoutes env={env} />
    </BrowserRouter>
  );
}
