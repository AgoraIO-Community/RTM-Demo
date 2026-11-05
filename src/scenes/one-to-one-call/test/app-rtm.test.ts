import { describe, expect, it, vi } from 'vitest';

import { AppCallRtmSession, type CallRtmClient } from '../app-rtm';

function setup() {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(event: never) => void>>();
  const publish = vi.fn(async () => undefined);
  const client: CallRtmClient = {
    addEventListener(name, listener) {
      calls.push(`on:${name}`);
      const set = listeners.get(name) ?? new Set();
      set.add(listener as (event: never) => void);
      listeners.set(name, set);
    },
    removeEventListener(name, listener) {
      calls.push(`off:${name}`);
      listeners.get(name)?.delete(listener as (event: never) => void);
    },
    async login() { calls.push('login'); },
    async logout() { calls.push('logout'); },
    publish,
  };
  const session = new AppCallRtmSession('app-id', 'call-local01', {
    createClient: () => client,
    now: () => 1_000,
    monotonicNow: (() => { let value = 10; return () => value += 5; })(),
  });
  return { session, client, calls, listeners, publish };
}

describe('AppCallRtmSession', () => {
  it('登录前通过共享工具获取当前 UID 的 Token', async () => {
    const { client } = setup();
    client.login = vi.fn(async () => undefined);
    const getToken = vi.fn(async () => 'rtm-token');
    const session = new AppCallRtmSession('app', 'call-local01', { createClient: () => client, getToken });
    await session.login();
    expect(getToken).toHaveBeenCalledWith({ service: 'rtm', appId: 'app', userId: 'call-local01' });
    expect(client.login).toHaveBeenCalledWith({ token: 'rtm-token' });
  });

  it('场景rtm只能在登录完成后取得同一SDK的已登录端口，退出后不可再取', async () => {
    const { session, publish } = setup();
    expect(() => session.getCallPort?.()).toThrow('RTM 尚未登录');
    await session.login();
    await session.getCallPort?.().publishToUser('call-remote02', 'CALL_KIT_INVITE', '{"callId":"opaque"}');
    expect(publish).toHaveBeenCalledWith('call-remote02', '{"callId":"opaque"}', {
      channelType: 'USER', customType: 'CALL_KIT_INVITE', storeInHistory: false,
    });
    await session.logout();
    expect(() => session.getCallPort?.()).toThrow('RTM 尚未登录');
  });

  it('在 login 前注册 message、linkState 和 token 监听', async () => {
    const { session, calls } = setup();
    await session.login();
    expect(calls).toEqual(['on:linkState', 'on:message', 'on:token', 'login']);
  });

  it('页面MESSAGE连接状态不被同一Client的STREAM事件覆盖', async () => {
    const { session, listeners } = setup();
    await session.login();
    for (const listener of listeners.get('linkState') ?? []) listener({
      serviceType: 'MESSAGE', currentState: 'CONNECTED', previousState: 'CONNECTING', timestamp: 100,
    } as never);
    for (const listener of listeners.get('linkState') ?? []) listener({
      serviceType: 'STREAM', currentState: 'FAILED', previousState: 'CONNECTING', timestamp: 101,
    } as never);
    expect(session.getCurrentLinkState()).toBe('connected');
    expect(session.getTraces().filter(entry => entry.name === 'linkState')).toHaveLength(2);
  });

  it('所有呼叫消息固定通过 USER 点对点发送且不保存历史', async () => {
    const { session, publish } = setup();
    const port = await session.login();
    const message = '{"callId":"0123456789ABCDEF0123456789ABCDEF"}';
    await port.publishToUser('call-remote02', 'CALL_KIT_INVITE', message);
    expect(publish).toHaveBeenCalledWith('call-remote02', message, {
      channelType: 'USER',
      customType: 'CALL_KIT_INVITE',
      storeInHistory: false,
    });
    expect(session.getTraces().at(-1)).toMatchObject({
      kind: 'api', name: 'rtm.publish', eventTag: 'USER',
      summary: 'to call-remote02 CALL_KIT_INVITE · callId=01234567…CDEF',
    });
  });

  it('先记录 USER message EVENT，再交给业务 listener', async () => {
    const { session, listeners } = setup();
    await session.login();
    const observed: string[] = [];
    session.bindEvents({
      message: () => {
        observed.push(session.getTraces().at(-1)?.name ?? '');
        return { consumed: true, reason: '测试消费' };
      },
    });
    const message = {
      channelType: 'USER', channelName: '', topicName: '', messageType: 'STRING',
      customType: 'CALL_KIT_REFUSE', publisher: 'call-remote02', message: '{}',
    };
    for (const listener of listeners.get('message') ?? []) listener(message as never);
    expect(observed).toEqual(['message']);
    expect(session.getTraces().at(-1)).toMatchObject({
      kind: 'event', name: 'message', eventTag: 'USER',
      summary: 'from call-remote02 CALL_KIT_REFUSE',
    });
  });

  it('数据流区分接听请求和主叫ACK，不展示extra正文', async () => {
    const { session, listeners } = setup();
    const port = await session.login();
    for (const type of ['accepted', 'ack'] as const) {
      const message = JSON.stringify({ callId: '0123456789ABCDEF0123456789ABCDEF', extra: 'private-data', type });
      await port.publishToUser('call-remote02', 'CALL_KIT_ACCEPT', message);
      expect(session.getTraces().at(-1)?.summary).toContain('type=' + type);
      expect(session.getTraces().at(-1)?.summary).not.toContain('private-data');
      for (const listener of listeners.get('message') ?? []) listener({
        channelType: 'USER', customType: 'CALL_KIT_ACCEPT', publisher: 'call-remote02', message,
      } as never);
      expect(session.getTraces().at(-1)?.summary).toContain('type=' + type);
    }
  });

  it('业务消费完成后在同一条 EVENT 上补充忽略原因', async () => {
    const { session, listeners } = setup();
    await session.login();
    session.bindEvents({
      message: async () => ({ consumed: false, reason: '信令已过期' }),
    });
    const message = {
      channelType: 'USER', channelName: '', topicName: '', messageType: 'STRING',
      customType: 'CALL_KIT_INVITE', publisher: 'call-remote02', message: '{}',
    };
    for (const listener of listeners.get('message') ?? []) listener(message as never);
    await Promise.resolve();

    const messageTraces = session.getTraces().filter(({ name }) => name === 'message');
    expect(messageTraces).toHaveLength(1);
    expect(messageTraces[0]?.summary).toBe('from call-remote02 CALL_KIT_INVITE · 已忽略：信令已过期');
  });

  it('publish 失败保留错误 trace 并向调用者抛出原错误', async () => {
    const { session, publish } = setup();
    const error = Object.assign(new Error('peer offline'), { errorCode: -10001 });
    publish.mockRejectedValueOnce(error);
    const port = await session.login();
    await expect(port.publishToUser('call-offline', 'CALL_KIT_INVITE', '{}')).rejects.toBe(error);
    expect(session.getTraces().at(-1)).toMatchObject({ errorCode: -10001, errorMessage: 'peer offline' });
  });

  it('logout 只移除本实例回调并记录 API', async () => {
    const { session, calls, listeners } = setup();
    await session.login();
    await session.logout();
    expect(calls.slice(-4)).toEqual(['off:linkState', 'off:message', 'off:token', 'logout']);
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
    expect(session.getTraces().at(-1)).toMatchObject({ kind: 'api', name: 'rtm.logout' });
  });

  it('再次登录会等注销完成并复用原 Client，不重复构造同 UID 实例', async () => {
    let finishLogout!: () => void;
    let logoutFinished = false;
    let created = 0;
    const calls: string[] = [];
    const logoutGate = new Promise<void>((resolve) => { finishLogout = resolve; });
    const makeClient = (index: number): CallRtmClient => ({
      addEventListener() {},
      removeEventListener() {},
      async login() { calls.push(`login:${index}`); },
      async logout() {
        calls.push(`logout:${index}:start`);
        await logoutGate;
        logoutFinished = true;
        calls.push(`logout:${index}:end`);
      },
      async publish() {},
    });
    const session = new AppCallRtmSession('app-id', 'call-local01', {
      createClient: () => {
        created += 1;
        calls.push(`create:${created}`);
        if (created > 1) {
          throw Object.assign(new Error('user ID already in use'), { errorCode: -10027 });
        }
        return makeClient(created);
      },
    });

    await session.login();
    const logout = session.logout();
    const relogin = session.login();
    await Promise.resolve();

    expect(calls).toEqual(['create:1', 'login:1', 'logout:1:start']);
    finishLogout();
    await Promise.all([logout, relogin]);
    expect(calls).toEqual([
      'create:1', 'login:1', 'logout:1:start', 'logout:1:end', 'login:1',
    ]);
    expect(logoutFinished).toBe(true);
  });

  it('client 创建异常通过 login Promise 拒绝而不是同步抛出', async () => {
    const error = Object.assign(new Error('user ID already in use'), { errorCode: -10027 });
    const session = new AppCallRtmSession('app-id', 'call-local01', {
      createClient: () => { throw error; },
    });

    let login: Promise<unknown> | undefined;
    expect(() => { login = session.login(); }).not.toThrow();
    await expect(login).rejects.toBe(error);
  });

  it('登录失败重试仍使用已构造的 Client，并恢复事件监听', async () => {
    const { client, calls } = setup();
    client.login = vi.fn().mockRejectedValueOnce(new Error('登录失败')).mockResolvedValue(undefined);
    const createClient = vi.fn(() => {
      if (createClient.mock.calls.length > 1) {
        throw Object.assign(new Error('duplicate RTM instance'), { errorCode: -10027 });
      }
      return client;
    });
    const session = new AppCallRtmSession('app-id', 'call-local01', { createClient });
    await expect(session.login()).rejects.toThrow('登录失败');
    await session.login();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.login).toHaveBeenCalledTimes(2);
    expect(calls.filter(call => call === 'on:linkState')).toHaveLength(2);
    expect(session.getTraces().at(-1)).toMatchObject({ name: 'rtm.login' });
    expect(session.getTraces().at(-1)?.errorMessage).toBeUndefined();
  });
});
