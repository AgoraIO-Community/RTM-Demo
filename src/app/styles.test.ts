/**
 * 样式表契约测试。
 *
 * ## 为什么要用读文本的方式测 CSS
 *
 * 「墨 · Ink」设计系统的关键数值（token、三列网格、麦位行高、折叠栏宽）来自设计交接包
 * `design/rtm-experience-hall/README.md`，是约束而不是审美偏好。jsdom 不做布局也不算
 * 层叠样式，`getComputedStyle` 拿不到这些值，所以只能直接断言样式表文本。
 *
 * 这样测确实脆 —— 改写选择器就会红。但**红在这里正是目的**：它逼改的人回来对照设计稿，
 * 确认自己是有意改这些数值，而不是顺手调格式时把它们带偏了。
 */

// 取源码文本用 Vite 的 `?raw`，不用 node:fs —— `tsconfig.app.json` 的 `types` 里
// 没有 `node`（app 代码是浏览器包，不该看见 `process`），用 node API 会让 `tsc -b` 红。
import { describe, expect, it } from 'vitest';

import stylesSource from './styles.css?raw';

// Compare reference dimensions at the browser's default 16px root size.
// Viewport-dependent scaling is exercised in the browser tests.
const css = stylesSource.replace(/(-?[\d.]+)rem\b/g, (_, value: string) => `${Number(value) * 16}px`);

/** 取某个选择器的规则体。选择器在文件里唯一时才有意义。 */
function ruleBody(selector: string): string {
  // 只匹配行首的选择器，避免命中 `.a .b {` 这类嵌套后代选择器。
  const index = css.indexOf(`\n${selector} {`);
  expect(index, `样式表里找不到选择器 ${selector}`).toBeGreaterThan(-1);
  return css.slice(index + 1, css.indexOf('}', index));
}

function block(selector: string): string {
  return ruleBody(selector).replace(/\s+/g, ' ');
}

describe('设计 token', () => {
  it('正文沿用系统字形渲染并使用 400 基准字重（v2.0 对齐 Agent UI）', () => {
    const body = ruleBody('body');
    expect(body).toContain('font-weight: 400');
    expect(body).not.toContain('-webkit-font-smoothing: antialiased');
  });

  it('浅色与深色两套语义色只在 token 块里各出现一次', () => {
    const light = ruleBody(':root');
    const dark = ruleBody('[data-theme="dark"]');
    for (const [name, lightValue, darkValue] of [
      ['--ink-canvas', '#fcf9f8', '#000000'],
      ['--ink-surface', '#ffffff', '#0a0a0a'],
      ['--ink-subtle', '#f1f0f0', '#1a1a1a'],
      ['--ink-hover', '#e7e5e5', '#242424'],
      ['--ink-line', '#d6d6d6', '#383838'],
      ['--ink-dash-strong', '#8a8a8a', '#626262'],
      ['--ink-fg2', '#626262', '#b3b3b3'],
      ['--ink-fg', '#0f0f0f', '#fcf9f8'],
      ['--ink-ink', '#0f0f0f', '#fcf9f8'],
      ['--ink-on-ink', '#fcf9f8', '#000000'],
      ['--ink-signal', '#075c9a', '#00c2ff'],
      ['--ink-focus', '#075c9a', '#a0faff'],
      ['--ink-link', '#075c9a', '#00c2ff'],
      ['--ink-success', '#1f8a5b', '#3fb27f'],
      ['--ink-danger', '#c8362f', '#e5534b'],
    ]) {
      expect(light).toContain(`${name}: ${lightValue}`);
      expect(dark).toContain(`${name}: ${darkValue}`);
    }
  });

  it('数据流增量保留两套类型色板：API 薄荷、EVENT 天蓝', () => {
    const light = ruleBody(':root');
    const dark = ruleBody('[data-theme="dark"]');
    expect(light).toContain('--ink-trace-api: #2fa98a');
    expect(light).toContain('--ink-trace-api-bg: #a7e5d3');
    expect(light).toContain('--ink-trace-event: #3d7fc2');
    expect(light).toContain('--ink-trace-event-bg: #a8c8e8');
    expect(dark).toContain('--ink-trace-api: #7fdcc3');
    expect(dark).toContain('--ink-trace-api-bg: #1e4a3f');
    expect(dark).toContain('--ink-trace-event: #8ab9e6');
    expect(dark).toContain('--ink-trace-event-bg: #1f3550');
  });

  it('尺寸只实现 comfortable 一档', () => {
    const root = ruleBody(':root');
    for (const [name, value] of [
      ['--ink-fs', '13px'], ['--ink-fs-sm', '12px'], ['--ink-h1', '22px'], ['--ink-h2', '16px'],
      ['--ink-pad', '24px'], ['--ink-gap', '12px'], ['--ink-row-p', '12px'], ['--ink-btn-h', '40px'],
      ['--ink-hdr-h', '76px'], ['--ink-avatar', '44px'], ['--ink-trace-p', '12px'],
      ['--ink-side-w', '252px'], ['--ink-tl-w', '420px'], ['--ink-panel-w', '300px'], ['--ink-rail-w', '48px'],
    ]) {
      expect(root).toContain(`${name}: ${value}`);
    }
    expect(css).not.toContain('data-density');
  });

  it('纯黑深色底不用投影，层级由 surface 与边线表达', () => {
    expect(ruleBody('[data-theme="dark"]')).toContain('--ink-stage-shadow: none');
  });

  it('字重只用 400 / 600，不再出现 500 / 700', () => {
    expect(css).not.toMatch(/font-weight: (500|700)/);
    expect(css).not.toMatch(/font: (500|700) /);
  });

  it('动效使用 Agent UI 的时长与缓动 token', () => {
    const root = ruleBody(':root');
    for (const [name, value] of [
      ['--ink-duration-fast', '0.2s'], ['--ink-duration-standard', '0.36s'], ['--ink-duration-slow', '0.6s'],
      ['--ink-duration-press', '0.14s'], ['--ink-ease-standard', 'cubic-bezier(.22, .61, .36, 1)'],
      ['--ink-ease-enter', 'cubic-bezier(.16, 1, .3, 1)'], ['--ink-ease-exit', 'cubic-bezier(.4, 0, 1, 1)'],
    ]) {
      expect(root).toContain(`${name}: ${value}`);
    }
  });

  it('焦点环 2px、偏移 3px，使用 focus 角色色', () => {
    const focus = ruleBody(':focus-visible');
    expect(focus).toContain('outline: 2px solid var(--ink-focus)');
    expect(focus).toContain('outline-offset: 3px');
  });

  it('主按钮悬浮转 signal，按压只加内凹，控件尺寸不变', () => {
    expect(ruleBody('.ink-button--primary:not(:disabled):hover')).toContain('background: var(--ink-signal)');
    expect(ruleBody('.ink-button:not(:disabled):active')).toContain('box-shadow: var(--ink-press-shadow)');
    expect(ruleBody('.ink-button')).not.toMatch(/transform/);
  });

  it('颜色字面量只出现在两个 token 块里，组件规则一律引用变量', () => {
    const tokensEnd = css.indexOf('/* ---------- 基础 ---------- */');
    const rest = css.slice(tokensEnd);
    expect(rest).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('字体栈：人类语言 MiSans 优先并回退系统 UI 字体，机器可读信息用等宽字体，不再引用 Inter', () => {
    const root = ruleBody(':root');
    expect(root).toContain('--ink-font-ui: "MiSans", -apple-system');
    expect(root).toContain('"PingFang SC", "Microsoft YaHei"');
    expect(root).toContain('ui-monospace, "SF Mono", Menlo, Consolas, monospace');
    expect(css).not.toContain('Inter');
  });

  it('MiSans 只声明 400 / 600 两个字重，原样引用 woff2 并允许回退', () => {
    const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map((match) => match[1]);
    expect(faces).toHaveLength(2);
    expect(faces[0]).toContain('url("./assets/fonts/MiSans-Regular.woff2") format("woff2")');
    expect(faces[0]).toContain('font-weight: 400');
    expect(faces[1]).toContain('url("./assets/fonts/MiSans-Demibold.woff2") format("woff2")');
    expect(faces[1]).toContain('font-weight: 600');
    for (const face of faces) expect(face).toContain('font-display: swap');
  });
});

describe('外壳', () => {
  it('根节点显式声明画布底色与前景色，不能只写在 body 上', () => {
    const shell = ruleBody('.lab-shell');
    expect(shell).toContain('background: var(--ink-canvas)');
    expect(shell).toContain('color: var(--ink-fg)');
    expect(shell).toContain('grid-template-rows: var(--ink-topbar-h) minmax(0, 1fr)');
  });

  it('一级 tab 选中项使用底部 2px 墨色指示线', () => {
    const tab = ruleBody('.lab-tab--primary');
    const active = ruleBody(".lab-tab--primary[data-active='true']");
    expect(tab).toContain('border-bottom: 2px solid transparent');
    expect(tab).toContain('margin-bottom: -1px');
    expect(active).toContain('border-bottom-color: var(--ink-ink)');
  });

  it('三栏栅格：左右栏取宽度 token，折叠后收为 48px 窄栏', () => {
    expect(block('.lab-workspace')).toContain('grid-template-columns: var(--ink-side-w) minmax(0, 1fr) var(--ink-tl-w)');
    expect(ruleBody('.lab-workspace[data-left="collapsed"]')).toContain('--ink-side-w: var(--ink-rail-w)');
    expect(ruleBody('.lab-workspace[data-timeline="collapsed"]')).toContain('--ink-tl-w: var(--ink-rail-w)');
  });

  it('主题切换按钮：浅色态实心圆，深色态透明', () => {
    expect(ruleBody('.lab-theme-toggle__swatch')).toContain('background: var(--ink-fg)');
    expect(ruleBody('[data-theme="dark"] .lab-theme-toggle__swatch')).toContain('background: transparent');
  });
});

describe('数据流', () => {
  it('行是两列网格：时间 86px、正文自适应，记录内采用类型标签', () => {
    expect(block('.lab-trace')).toContain('grid-template-columns: 86px minmax(0, 1fr)');
    expect(ruleBody('.lab-trace__time')).toContain('white-space: nowrap');
    expect(ruleBody('.lab-trace__kind')).toContain('letter-spacing: 0.1em');
  });

  it('行底使用 surface，类型由 3px 左边框与标签区分，筛选色点保留', () => {
    expect(ruleBody('.lab-trace')).toContain('background: var(--ink-surface)');
    expect(ruleBody('.lab-trace')).toContain('border: 1px solid var(--ink-line)');
    expect(ruleBody('.lab-trace')).toContain('border-left: 3px solid var(--lab-trace-color)');
    expect(ruleBody('.lab-trace[data-kind="event"]')).toContain('--lab-trace-color: var(--ink-trace-event)');
    expect(ruleBody('.lab-trace__kind')).toContain('color: var(--lab-trace-color)');
    expect(ruleBody('.lab-trace__dot')).toContain('background: var(--ink-trace-api)');
    expect(ruleBody('.lab-trace__dot[data-kind="event"]')).toContain('background: var(--ink-trace-event)');
  });

  it('新到行只用 1.8s 呼吸表达「刚发生」，两个周期后静止', () => {
    expect(ruleBody('.lab-trace')).toContain('animation: lab-rowin var(--ink-duration-standard) var(--ink-ease-enter), lab-rowbreathe 1.8s var(--ink-ease-standard) 0.3s 2');
    expect(css).toContain('@keyframes lab-rowbreathe');
    const breathe = css.slice(css.indexOf('@keyframes lab-rowbreathe'), css.indexOf('@keyframes lab-seatbreathe'));
    expect(breathe).toContain('border-left-color: var(--lab-trace-color)');
    expect(breathe).toContain('box-shadow: 0 0 10px 0 color-mix(in oklab, var(--lab-trace-color) 35%, transparent)');
    expect(breathe).not.toMatch(/background|filter:/);
  });

  it('筛选 pill 保留圆角 999 的胶囊和类型色点', () => {
    expect(ruleBody('.lab-timeline__filter')).toContain('border-radius: 999px');
    expect(ruleBody('.lab-timeline__filter .lab-trace__dot')).toContain('margin: 0');
  });
});

describe('语聊房', () => {
  it('房间卡片：列 1fr / panelW，行 hdrH / 1fr / auto，容器不滚动', () => {
    const single = block('.vr-single');
    expect(single).toContain('grid-template-columns: minmax(0, 1fr) var(--ink-panel-w)');
    expect(single).toContain('grid-template-rows: var(--ink-hdr-h) minmax(0, 1fr) auto');
    expect(single).toContain('overflow: hidden');
  });

  it('麦位网格 4 列、行高 132px；说话只让头像呼吸，选中态独占卡片 ring', () => {
    const seats = block('.vr-single__seats');
    expect(seats).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
    expect(seats).toContain('grid-auto-rows: 132px');
    expect(ruleBody('.vr-single__seat[data-state="empty"]')).toContain('border-style: dashed');
    expect(css).not.toMatch(/\.vr-single__seat\[data-speaking="true"\]\s*\{/u);
    expect(ruleBody('.vr-single__seat[data-speaking="true"] .vr-single__seat-avatar')).toContain('animation: lab-seatbreathe 1.8s var(--ink-ease-standard) infinite');
    expect(ruleBody('.vr-single__seat[data-selected="true"]')).toContain('box-shadow: 0 0 0 3px var(--ink-ring)');
  });

  it('公屏承接溢出滚动，治理面板自己滚动', () => {
    expect(ruleBody('.vr-single__chat-feed')).toContain('overflow: auto');
    expect(ruleBody('.vr-single__chat-feed')).toContain('min-height: 0');
    expect(ruleBody('.vr-single__panel')).toContain('overflow: auto');
    expect(ruleBody('.vr-single__panel')).toContain('background: var(--ink-subtle)');
  });

  it('真实场景与浮层只使用语义投影，保留 ring、断线光圈、呼吸发光与失败描边', () => {
    expect(ruleBody('.vr-single')).toContain('box-shadow: var(--ink-stage-shadow)');
    expect(ruleBody('.oc-workbench,\n.oc-status-card')).toContain('box-shadow: var(--ink-stage-shadow)');
    expect(css.match(/box-shadow: var\(--ink-stage-shadow\)/g)).toHaveLength(3);
    const shadows = [...css.matchAll(/box-shadow:\s*([^;]+);/g)].map((match) => match[1].trim());
    for (const shadow of shadows) {
      expect(shadow).toMatch(/^(0 0 0 0 transparent|0 0 0 3px var\(--ink-(ring|surface)\)|0 0 12px 1px var\(--ink-glow\)|0 0 10px 0 color-mix\(in oklab, var\(--lab-trace-color\) 35%, transparent\)|var\(--ink-stage-shadow\)|var\(--ink-press-shadow\)|inset 0 0 0 1px var\(--ink-danger\))$/);
    }
  });
});

describe('响应式', () => {
  it('断点只有 1279 与 760 两处，并在偏好减少动效时停用呼吸', () => {
    expect(css).toContain('@media (max-width: 1279px)');
    expect(css).toContain('@media (max-width: 760px)');
    expect(css).not.toContain('@media (max-width: 960px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
