import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useSceneSessionLifecycle } from './sceneSessions';

describe('单场景 Session 清理', () => {
  it('Strict Mode 模拟卸载不清理，真正卸载先清理业务再注销', async () => {
    const operations: string[] = [];
    const session = { userId: 'uid', async logout() { operations.push('logout'); } };
    const view = renderHook(() => useSceneSessionLifecycle(session, async () => { operations.push('leave'); }), {
      wrapper: StrictMode,
    });
    await act(async () => { await Promise.resolve(); });
    expect(operations).toEqual([]);
    view.unmount();
    await waitFor(() => expect(operations).toEqual(['leave', 'logout']));
  });

  it('pagehide 和后续卸载只清理一次，业务清理失败仍注销', async () => {
    const logout = vi.fn(async () => undefined);
    const leave = vi.fn(async () => { throw new Error('leave failed'); });
    const view = renderHook(() => useSceneSessionLifecycle({ userId: 'uid', logout }, leave));
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(leave).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledOnce();
  });

  it('Session 替换时注销旧实例，不能因新实例挂载而取消旧实例清理', async () => {
    const first = { userId: 'first', logout: vi.fn(async () => undefined) };
    const second = { userId: 'second', logout: vi.fn(async () => undefined) };
    const view = renderHook(({ session }) => useSceneSessionLifecycle(session), { initialProps: { session: first } });
    view.rerender({ session: second });
    await waitFor(() => expect(first.logout).toHaveBeenCalledOnce());
    expect(second.logout).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(second.logout).toHaveBeenCalledOnce());
  });
});
