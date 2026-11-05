import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
});

describe('官网子路径外壳', () => {
  it('短入口保留 UTM 和 hash，导航仍处于 /rtm-demo/ 内', async () => {
    vi.stubEnv('BASE_URL', '/rtm-demo/');
    window.history.replaceState(null, '', '/rtm-demo/?utm_source=website&utm_medium=rtm_hero#keep');
    render(<App env={{ configured: false }} />);
    await waitFor(() => expect(window.location.pathname).toBe('/rtm-demo/social/voice-room'));
    expect(window.location.search).toBe('?utm_source=website&utm_medium=rtm_hero');
    expect(window.location.hash).toBe('#keep');
    const nav = screen.getByRole('navigation', { name: '一级场景分类' });
    expect(within(nav).getByRole('link', { name: '1V1呼叫邀请' }))
      .toHaveAttribute('href', '/rtm-demo/social/one-to-one-call');
  });

  it('同一产物通过旧根入口也能访问已有场景', async () => {
    vi.stubEnv('BASE_URL', '/rtm-demo/');
    window.history.replaceState(null, '', '/social/voice-room');
    render(<App env={{ configured: false }} />);
    expect(screen.getByRole('link', { name: '1V1呼叫邀请' })).toHaveAttribute('href', '/social/one-to-one-call');
  });

  it('房间 replaceState 后，重新加载当前场景保留最新身份 URL', async () => {
    vi.stubEnv('BASE_URL', '/rtm-demo/');
    window.history.replaceState(null, '', '/rtm-demo/social/voice-room');
    render(<App env={{ configured: false }} />);
    act(() => window.history.replaceState(null, '', '/rtm-demo/social/voice-room?data=latest-identity'));
    document.addEventListener('click', event => event.preventDefault(), { once: true });
    const link = screen.getByRole('link', { name: '语聊房' });
    fireEvent.click(link);
    expect(link.getAttribute('href')).toBe(window.location.href);
  });
});
