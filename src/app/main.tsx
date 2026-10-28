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
import './styles.css';

applyTheme(resolveInitialTheme());

// History may restore an old document with a disposed session from the back/forward cache.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App env={readEnvSnapshot()} />
  </StrictMode>,
);
