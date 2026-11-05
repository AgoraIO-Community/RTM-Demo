import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { LabRoutes } from './App';
import { createAnalyticsTracker, type AnalyticsEvent } from '../shared/analytics/tracker';
import { createVoiceRoomFakes } from '../scenes/voice-room/test/testing';
import { bindAnalyticsToPage } from '../shared/analytics/browser';
import { experienceForPath } from './experienceScenarios';

afterEach(() => { window.dispatchEvent(new Event('pagehide')); });

function Location() {
  const location = useLocation();
  return <output aria-label="测试路由">{location.pathname}{location.search}{location.hash}</output>;
}

function setup(path = '/?utm_source=website&utm_medium=rtm_hero#keep') {
  window.history.replaceState({}, '', path);
  const events: AnalyticsEvent[] = [];
  const analytics = createAnalyticsTracker({ site: 'cn', environment: 'local', capture: event => events.push(event),
    href: () => `https://rtm-demo.shengwang.cn${path}` });
  bindAnalyticsToPage(analytics, pathname => experienceForPath(pathname === '/' ? '/social/voice-room' : pathname));
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}>
    <Location />
    <LabRoutes env={{ configured: true, appId: 'test-app-id', source: 'window.__ENV__' }}
      analytics={analytics} voiceRoomOverrides={createVoiceRoomFakes().overrides} />
  </MemoryRouter></StrictMode>);
  return { events, view };
}

function clickLink(name: string, modifiers = {}) {
  // Observe React callbacks without letting jsdom attempt a real navigation.
  document.addEventListener('click', event => event.preventDefault(), { once: true });
  fireEvent.click(screen.getByRole('link', { name }), modifiers);
}

describe('页面外壳埋点', () => {
  it('根地址跳转保留来源和 hash，Strict Mode 仅记录一次进入', async () => {
    const { events } = setup();
    await waitFor(() => expect(screen.getByLabelText('测试路由'))
      .toHaveTextContent('/social/voice-room?utm_source=website&utm_medium=rtm_hero#keep'));
    expect(events.map(event => event.event)).toEqual(['lab_enter']);
  });

  it('Console 与四类文档链接产生正确事件，不改变链接行为', async () => {
    const { events } = setup('/social/voice-room');
    await screen.findByRole('link', { name: '新开听众页' });
    clickLink('前往 Console 创建项目');
    for (const label of ['产品简介', '最佳实践', 'API参考', 'Demo 源码']) clickLink(label);
    expect(events.filter(event => event.event === 'console_click')).toEqual([
      expect.objectContaining({ properties: expect.objectContaining({ tasks_done: 0, task_total: 5 }) }),
    ]);
    expect(events.filter(event => event.event === 'doc_click').map(event => event.properties.link_type))
      .toEqual(['overview', 'practice', 'api', 'source']);
    expect(screen.getByRole('link', { name: '前往 Console 创建项目' })).toHaveAttribute('target', '_blank');
  });

  it('正常导航保存切换意图；当前场景、修饰键和待开放入口不保存', async () => {
    setup('/social/voice-room');
    await screen.findByRole('link', { name: '新开听众页' });
    const saved = () => JSON.parse(sessionStorage.getItem('rtm_lab_switch_v2:local') ?? '{}');
    clickLink('语聊房');
    clickLink('1V1呼叫邀请', { ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: '电商直播' }));
    expect(saved().from).toBeUndefined();
    clickLink('1V1呼叫邀请');
    expect(saved()).toMatchObject({ from: 'voice-room', to: 'one-to-one-call' });
  });
});
