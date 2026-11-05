/**
 * 主题偏好：light / dark。
 *
 * 初值优先本地偏好，其次系统 `prefers-color-scheme`，最后 light。切换即时把
 * `data-theme` 写到 `<html>` 上，整套 token 立即替换（设计要求无过渡动画）。
 */

import { useCallback, useLayoutEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'rtm-lab.theme';

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeStorage(): ThemeStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readStoredTheme(storage: ThemeStorage | undefined = safeStorage()): Theme | undefined {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function resolveInitialTheme(): Theme {
  const stored = readStoredTheme();
  if (stored) return stored;
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

export function applyTheme(theme: Theme, root: HTMLElement | undefined = typeof document === 'undefined' ? undefined : document.documentElement): void {
  root?.setAttribute('data-theme', theme);
}

/** 当前主题与切换函数。切换会持久化到本地并同步 `<html data-theme>`。 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try {
        safeStorage()?.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // 无法持久化时只影响下次刷新的初值，不阻断切换。
      }
      return next;
    });
  }, []);
  return [theme, toggle];
}
