import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyTheme, readStoredTheme, resolveInitialTheme, THEME_STORAGE_KEY, useTheme } from './theme';

describe('主题偏好', () => {
  beforeEach(() => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
  });

  it('本地没有偏好时默认浅色', () => {
    expect(readStoredTheme()).toBeUndefined();
    expect(resolveInitialTheme()).toBe('light');
  });

  it('本地偏好优先于系统偏好；非法值视为未设置', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(resolveInitialTheme()).toBe('dark');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readStoredTheme()).toBeUndefined();
  });

  it('applyTheme 把 data-theme 写到 <html>', () => {
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('useTheme 切换即同步 <html data-theme> 并持久化', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    act(() => result.current[1]());

    expect(result.current[0]).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
