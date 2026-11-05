import { useEffect, useRef } from 'react';

export interface SceneSessionLifecycle {
  readonly userId: string;
  logout(): Promise<unknown>;
}

/** Cleans up one scene-owned session; never creates or caches clients across scenes. */
export function useSceneSessionLifecycle(
  session: SceneSessionLifecycle,
  beforeLogout?: () => Promise<unknown>,
): void {
  const beforeLogoutRef = useRef(beforeLogout);
  beforeLogoutRef.current = beforeLogout;
  const pending = useRef<{ session: SceneSessionLifecycle; canceled: boolean } | undefined>(undefined);

  useEffect(() => {
    if (pending.current?.session === session) pending.current.canceled = true;
    let cleaned = false;
    const cleanup = (leave: typeof beforeLogout) => {
      if (cleaned) return;
      cleaned = true;
      let leaving: Promise<unknown>;
      try { leaving = Promise.resolve(leave?.()); }
      catch (error) { leaving = Promise.reject(error); }
      void leaving.catch(() => undefined).then(() => session.logout()).catch(() => undefined);
    };
    const onPageHide = () => cleanup(beforeLogoutRef.current);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      const leave = beforeLogoutRef.current;
      const delayed = { session, canceled: false };
      pending.current = delayed;
      // Strict Mode synchronously re-mounts the same session before this microtask.
      queueMicrotask(() => {
        if (!delayed.canceled) cleanup(leave);
      });
    };
  }, [session]);
}
