/// <reference types="node" />
import { webcrypto } from 'node:crypto';
/**
 * 根 vitest 的全局 setup。
 *
 * 它服务**整个根测试套件**（`src/**` 与 `tests/**`），所以住在 `src/test/` 下，
 * 而不是任何某一个场景或子目录里 —— 放进子目录会让「这个模块可以被移走」这类
 * 改动意外带走整套测试基础设施。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle });

// Node 26 exposes configurable global storage getters that return undefined unless
// --localstorage-file is set. Install a standards-shaped in-memory store for tests.
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(String(key)) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(String(key)); },
    setItem: (key, value) => { values.set(String(key), String(value)); },
  };
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage() });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: memoryStorage() });

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});
