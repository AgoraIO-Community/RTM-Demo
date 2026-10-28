import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAgoraToken } from './token';

const request = { service: 'rtm' as const, appId: 'app-id', userId: 'user-1' };
const auth = { mode: 'token' as const };

function grant(overrides: Record<string, unknown> = {}) {
  return { ...request, token: 'short-lived-token', expiresAt: Date.now() + 60_000, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAgoraToken', () => {
  it('无鉴权模式不发请求，也不读取凭证', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(getAgoraToken(request)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('同源 POST 申请绑定用户的 RTM Token', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(grant())));
    vi.stubGlobal('fetch', fetch);
    await expect(getAgoraToken(request, auth)).resolves.toBe('short-lived-token');
    expect(fetch).toHaveBeenCalledWith('/api/token', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    }));
  });

  it.each([
    { appId: 'other-app' }, { userId: 'other-user' }, { service: 'rtc' },
    { expiresAt: 0 }, { expiresAt: 'invalid' }, { token: '' }, { token: null },
  ])('拒绝身份或有效期不匹配的响应 %j', async mismatch => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(grant(mismatch)))));
    await expect(getAgoraToken(request, auth)).rejects.toThrow('Token 响应无效');
  });

  it('RTC Token 必须绑定实际频道与字符串 UID', async () => {
    const rtcRequest = { ...request, service: 'rtc' as const, channelName: 'room-1' };
    const fetch = vi.fn(async () => new Response(JSON.stringify(grant(rtcRequest))));
    vi.stubGlobal('fetch', fetch);
    await expect(getAgoraToken(rtcRequest, auth)).resolves.toBe('short-lived-token');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(grant({ ...rtcRequest, channelName: 'other-room' }))));
    await expect(getAgoraToken(rtcRequest, auth)).rejects.toThrow('Token 响应无效');
  });

  it('HTTP 失败不降级，也不把响应里的敏感内容带入错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private-server-value', { status: 429 })));
    const error = await getAgoraToken(request, auth).catch(value => value);
    expect(error.message).toBe('Token 申请失败（HTTP 429）');
    expect(error.message).not.toContain('private-server-value');
  });

});
