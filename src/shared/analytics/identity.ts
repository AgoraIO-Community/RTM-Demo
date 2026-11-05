export interface AnalyticsIdentity {
  id: string;
}

export function validIdentityEndpoint(value: unknown): value is string {
  return typeof value === 'string' && /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(value);
}

export async function readAnalyticsIdentity(endpoint: string): Promise<AnalyticsIdentity | undefined> {
  if (!validIdentityEndpoint(endpoint)) return;
  try {
    const response = await fetch(endpoint, {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) { await response.body?.cancel(); return; }
    const session: unknown = await response.json();
    if (!session || typeof session !== 'object' || !('authenticated' in session) || session.authenticated !== true
      || !('identity' in session) || !session.identity || typeof session.identity !== 'object') return;
    const identity = session.identity;
    if (!('id' in identity) || typeof identity.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(identity.id)) return;
    return { id: identity.id };
  } catch { return; }
}
