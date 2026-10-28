import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LabRoutes } from './App';

const sdk = vi.hoisted(() => ({
  identities: new Set<string>(),
  created: 0,
  logins: 0,
  logouts: 0,
}));

// The SDK registers appId + UID at construction and does not release it on logout.
vi.mock('agora-rtm', () => ({
  default: {
    RTM: class {
      private listeners = new Map<string, Set<(event: unknown) => void>>();

      constructor(appId: string, uid: string) {
        const identity = `${appId}-${uid}`;
        if (sdk.identities.has(identity)) {
          throw Object.assign(new Error('duplicate RTM instance'), { errorCode: -10027 });
        }
        sdk.identities.add(identity);
        sdk.created++;
      }

      addEventListener(name: string, listener: (event: unknown) => void) {
        const listeners = this.listeners.get(name) ?? new Set();
        listeners.add(listener);
        this.listeners.set(name, listeners);
      }

      removeEventListener(name: string, listener: (event: unknown) => void) {
        this.listeners.get(name)?.delete(listener);
      }

      async login() {
        sdk.logins++;
        await Promise.resolve();
        for (const listener of this.listeners.get('linkState') ?? []) {
          listener({
            timestamp: Date.now(), previousState: 'CONNECTING', currentState: 'CONNECTED',
            operation: 'LOGIN', reasonCode: 'LOGIN_SUCCESS', reason: '',
            affectedChannels: [], unrestoredChannels: [], isResumed: false, serviceType: 'RTM',
          });
        }
      }

      async logout() { sdk.logouts++; }
    },
  },
}));

const env = { configured: true, appId: 'test-app-id', source: 'window.__ENV__' } as const;

function renderScene(path: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <LabRoutes env={env} />
      </MemoryRouter>
    </StrictMode>,
  );
}

beforeEach(() => {
  sdk.identities.clear();
  sdk.created = 0;
  sdk.logins = 0;
  sdk.logouts = 0;
});

describe('完整外壳的场景 Session 生命周期', () => {
  it.each(['/social/voice-room', '/social/one-to-one-call'])(
    'StrictMode 加载 %s 只创建并登录一个 Client，真正卸载才注销',
    async path => {
      const view = renderScene(path);
      await waitFor(() => expect(screen.getByTestId('connection-state')).toHaveTextContent('CONNECTED'));
      expect(screen.queryByRole('button', { name: '重新登录' })).not.toBeInTheDocument();
      expect(sdk.created).toBe(1);
      expect(sdk.logins).toBe(1);
      expect(sdk.logouts).toBe(0);

      view.unmount();
      await waitFor(() => expect(sdk.logouts).toBe(1));
    },
  );

  it('pagehide 结束当前页面的唯一 Session，随后卸载不会重复注销', async () => {
    const view = renderScene('/social/voice-room');
    await waitFor(() => expect(screen.getByTestId('connection-state')).toHaveTextContent('CONNECTED'));
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(sdk.logouts).toBe(1));
    view.unmount();
    await Promise.resolve();
    expect(sdk.created).toBe(1);
    expect(sdk.logouts).toBe(1);
  });
});
