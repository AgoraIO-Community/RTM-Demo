export interface TokenAuthConfig {
  mode: 'token';
}

export type TokenRequest = {
  appId: string;
  userId: string;
} & ({ service: 'rtm'; channelName?: never } | { service: 'rtc'; channelName: string });

export type TokenProvider = (request: TokenRequest) => Promise<string | undefined>;

export async function getAgoraToken(request: TokenRequest, auth?: TokenAuthConfig): Promise<string | undefined> {
  if (!auth) return undefined;
  const response = await fetch('/api/token', {
    method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`Token 申请失败（HTTP ${response.status}）`);
  let grant: Record<string, unknown>;
  try {
    grant = await response.json();
  } catch {
    throw new Error('Token 响应无效');
  }
  if (!grant || grant.appId !== request.appId || grant.userId !== request.userId
      || grant.service !== request.service || (request.service === 'rtc' && grant.channelName !== request.channelName)
      || typeof grant.token !== 'string' || !grant.token.trim()
      || typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now()) {
    throw new Error('Token 响应无效');
  }
  return grant.token;
}
