import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}：大窗口同步放大字体、控件、图标和三栏，框架保持无滚动`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', '在桌面项目中覆盖所有窗口尺寸');
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript(() => { window.__ENV__ = { appId: '00000000000000000000000000000000' }; });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/social/one-to-one-call');
    await expect(page.getByTestId('one-to-one-call-workbench')).toBeVisible();

    for (const viewport of [
      { width: 1440, height: 900, minFont: 12.9, maxFont: 13.1 },
      { width: 1920, height: 1080, minFont: 16, maxFont: 19 },
      { width: 2560, height: 1440, minFont: 21, maxFont: 25 },
      { width: 3840, height: 2160, minFont: 28, maxFont: 36 },
      { width: 5120, height: 2880, minFont: 45, maxFont: 48 },
      { width: 7680, height: 4320, minFont: 68, maxFont: 71 },
      { width: 2560, height: 900, minFont: 13, maxFont: 16 },
      { width: 412, height: 915, minFont: 12.9, maxFont: 13.1 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const dimensions = await page.evaluate(() => {
        const size = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const main = document.querySelector('.lab-body')!;
        return {
          font: parseFloat(getComputedStyle(document.body).fontSize),
          logo: size('.lab-brand__logo img').width,
          topbar: size('.lab-topbar').height,
          icon: size('.oc-icon-button svg').width,
          left: size('.experience-path').width,
          right: size('.lab-timeline').width,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          mainWidth: main.clientWidth, mainContentWidth: main.scrollWidth,
          mainHeight: main.clientHeight, mainContentHeight: main.scrollHeight,
        };
      });
      expect(dimensions.font, JSON.stringify({ viewport, dimensions })).toBeGreaterThan(viewport.minFont);
      expect(dimensions.font).toBeLessThan(viewport.maxFont);
      const scale = dimensions.font / 13;
      expect(dimensions.logo).toBeCloseTo(48 * scale, 0);
      expect(dimensions.topbar).toBeCloseTo(56 * scale, 0);
      expect(dimensions.icon).toBeCloseTo(16 * scale, 0);
      if (viewport.width >= 1280) {
        expect(dimensions.left).toBeCloseTo(252 * scale, 0);
        expect(dimensions.right).toBeCloseTo(420 * scale, 0);
      }
      expect(dimensions.documentWidth).toBeLessThanOrEqual(viewport.width);
      expect(dimensions.documentHeight).toBeLessThanOrEqual(viewport.height);
      expect(dimensions.mainContentWidth).toBeLessThanOrEqual(dimensions.mainWidth);
      expect(dimensions.mainContentHeight).toBeLessThanOrEqual(dimensions.mainHeight);
      await page.getByLabel('对方呼叫 ID').fill('call-remote001');
      const callButton = page.getByRole('button', { name: '发起呼叫', exact: true });
      await callButton.scrollIntoViewIfNeeded();
      await expect(callButton).toBeInViewport({ ratio: 1 });
      await expect(page.locator('.lab-topbar')).toBeInViewport({ ratio: 1 });
      expect(await page.locator('.lab-body').evaluate(el => el.scrollTop)).toBe(0);
      if (viewport.width === 2560 && viewport.height === 1440 || viewport.width === 3840) {
        await page.screenshot({ path: testInfo.outputPath(`call-${viewport.width}-${theme}.png`) });
      }
    }
  });
}

test('高窗口中资源紧跟任务列表，矮窗口中仅任务列表滚动', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', '在桌面项目中改变窗口高度');
  await page.addInitScript(() => { window.__ENV__ = { appId: '00000000000000000000000000000000' }; });
  for (const path of ['/social/voice-room', '/social/one-to-one-call']) {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.goto(path);
    const tasks = page.getByRole('region', { name: '场景任务列表，可上下滚动' });
    await expect(tasks).toBeVisible();
    const scale = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize) / 13);
    const lastTask = (await tasks.locator('li').last().boundingBox())!;
    const consoleSection = (await page.locator('[aria-labelledby="experience-console-title"]').boundingBox())!;
    expect(consoleSection.y - lastTask.y - lastTask.height).toBeLessThanOrEqual(32 * scale);
    expect(await tasks.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 577 });
    expect(await tasks.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    for (const name of ['前往 Console 创建项目', '产品简介', '最佳实践', 'API参考', 'Demo 源码', '了解产品详情']) {
      await expect(page.getByRole('link', { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
  }
});

test('矮窗口的任务与开发资源分别可滚动，产品入口始终可见', async ({ page }) => {
  await page.addInitScript(() => { window.__ENV__ = { appId: '00000000000000000000000000000000' }; });
  for (const path of ['/social/voice-room', '/social/one-to-one-call']) {
    for (const viewport of [
      { width: 1280, height: 576 },
      { width: 1280, height: 561 },
      { width: 1280, height: 500 },
      { width: 1280, height: 450 },
      { width: 844, height: 390 },
      { width: 412, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(path);
      const toggle = page.getByRole('button', { name: '体验路径', exact: true });
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
      const tasks = page.getByRole('region', { name: '场景任务列表，可上下滚动' });
      const first = tasks.getByRole('button').first();
      const last = tasks.getByRole('button').last();
      expect((await tasks.boundingBox())!.height, JSON.stringify({ path, viewport }))
        .toBeGreaterThanOrEqual((await first.boundingBox())!.height);
      for (const button of [first, last]) {
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport({ ratio: 1 });
      }
      const resources = page.getByRole('region', { name: '开发资源，可上下滚动' });
      expect(await resources.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      for (const name of ['前往 Console 创建项目', '产品简介', '最佳实践', 'API参考', 'Demo 源码']) {
        const link = resources.getByRole('link', { name, exact: true });
        await link.focus();
        await link.scrollIntoViewIfNeeded();
        await expect(link).toBeInViewport({ ratio: 1 });
      }
      await expect(page.getByRole('link', { name: '了解产品详情', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await page.locator('.experience-path__sections').evaluate(el => el.scrollTop)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    }
  }
});
