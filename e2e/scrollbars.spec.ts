import { expect, test, type Locator } from '@playwright/test';

async function thumbAlpha(target: Locator) {
  return target.evaluate(element => {
    const color = getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor;
    return color.startsWith('rgba(') ? Number(color.split(',').at(-1)!.replace(')', '')) : 1;
  });
}

async function fadesWhileIdle(target: Locator) {
  const samples = await target.evaluate(element => new Promise<number[]>((resolve, reject) => {
    const values: number[] = [];
    let frame: number;
    const timeout = window.setTimeout(() => {
      cancelAnimationFrame(frame);
      reject(new Error('滚动条没有在空闲后淡出'));
    }, 2500);
    const sample = () => {
      const color = getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor;
      const alpha = color.startsWith('rgba(') ? Number(color.split(',').at(-1)!.replace(')', '')) : 1;
      values.push(alpha);
      if (alpha === 0) { clearTimeout(timeout); resolve(values); }
      else frame = requestAnimationFrame(sample);
    };
    sample();
  }));
  expect(samples.some(alpha => alpha > 0 && alpha < 1), '隐藏过程应当包含淡出过渡').toBe(true);
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}：滚动条在移入或滚动后淡出，鼠标和焦点停留不持续显示`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: testInfo.project.name === 'mobile-chromium' ? 412 : 1280, height: 640 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
    await page.addInitScript(() => { window.__ENV__ = { appId: '00000000000000000000000000000000' }; });
    await page.goto('/social/voice-room');
    const toggle = page.getByRole('button', { name: '体验路径', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    const tasks = page.getByRole('region', { name: '场景任务列表，可上下滚动' });
    await expect(tasks).toBeVisible();
    expect(await tasks.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await thumbAlpha(tasks)).toBe(0);
    const bounds = (await tasks.boundingBox())!;

    if (testInfo.project.name === 'desktop-chromium') {
      await tasks.hover({ position: { x: bounds.width - 2, y: bounds.height / 2 } });
      await expect.poll(() => thumbAlpha(tasks)).toBeGreaterThan(0.9);
      await fadesWhileIdle(tasks);
      expect(await tasks.evaluate(el => el.matches(':hover'))).toBe(true);
    } else {
      await tasks.focus();
      await expect.poll(() => thumbAlpha(tasks)).toBeGreaterThan(0.9);
      await fadesWhileIdle(tasks);
      await expect(tasks).toBeFocused();
    }

    await tasks.evaluate(el => { el.scrollTop = 50; });
    await expect.poll(() => thumbAlpha(tasks)).toBeGreaterThan(0.9);
    await fadesWhileIdle(tasks);
    expect(await tasks.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    const after = (await tasks.boundingBox())!;
    expect(after.width).toBe(bounds.width);
    expect(after.height).toBe(bounds.height);
    expect(await page.locator('.experience-path__sections').evaluate(el => el.scrollTop)).toBe(0);
    await expect(page.getByRole('link', { name: '了解产品详情', exact: true })).toBeInViewport({ ratio: 1 });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await tasks.dispatchEvent('wheel', { deltaY: 10 });
    await expect(tasks).toHaveAttribute('data-scrollbar-active', '');
    expect(await tasks.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
    await expect.poll(() => thumbAlpha(tasks)).toBe(0);
  });
}
