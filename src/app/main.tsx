/**
 * 单页应用入口。
 *
 * 环境快照在这里读一次（`readEnvSnapshot`），结果注入 `App` —— 组件树里不再读全局，
 * 测试可以直接传入任意 env 状态。主题在首帧前写到 `<html data-theme>`，避免闪白。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { readEnvSnapshot } from './envSnapshot';
import { applyTheme, resolveInitialTheme } from './theme';
import { resolveAnalyticsConfig, startAnalytics } from '../shared/analytics/posthog';
import { bindAnalyticsToPage } from '../shared/analytics/browser';
import { experienceForPath } from './experienceScenarios';
import { getAppBasePath } from '../shared/paths';
import './styles.css';

applyTheme(resolveInitialTheme());

// Read analytics settings once, before redirects can consume entry parameters.
const analytics = startAnalytics(resolveAnalyticsConfig({
  injected: window.__ENV__?.analytics,
  hostname: window.location.hostname,
  buildTime: {
    VITE_POSTHOG_ENABLED: import.meta.env.VITE_POSTHOG_ENABLED as string | undefined,
    VITE_POSTHOG_PROJECT_TOKEN: import.meta.env.VITE_POSTHOG_PROJECT_TOKEN as string | undefined,
    VITE_POSTHOG_HOST: import.meta.env.VITE_POSTHOG_HOST as string | undefined,
    VITE_ANALYTICS_SITE: import.meta.env.VITE_ANALYTICS_SITE as string | undefined,
    VITE_ANALYTICS_ENVIRONMENT: import.meta.env.VITE_ANALYTICS_ENVIRONMENT as string | undefined,
    PROD: import.meta.env.PROD,
  },
}));
bindAnalyticsToPage(analytics, pathname => {
  const base = getAppBasePath(pathname);
  return experienceForPath(`/${pathname.slice(base.length)}`);
});

// History may restore an old document with a disposed session from the back/forward cache.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App env={readEnvSnapshot()} analytics={analytics} />
  </StrictMode>,
);
