import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { IAgoraRTM } from 'agora-rtm';

import { Invitation as CallController, type InvitationRtmClient } from '../../invitation/index';
import { ALPHA, message } from './invitation.test-helpers';

class MemoryRtmClient {
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly login = vi.fn(async () => undefined);
  readonly logout = vi.fn(async () => undefined);
  deliver?: (target: string, event: ReturnType<typeof message>) => void;
  readonly publish = vi.fn(async (target: string, payload: string, options: { channelType: string; customType: string; storeInHistory: boolean }) => {
    this.deliver?.(target, { channelType: options.channelType, publisher: this.userId, customType: options.customType, message: payload });
  });

  constructor(readonly userId: string) {}
  addEventListener(name: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
  emit(name: string, event: unknown) { for (const listener of [...this.listeners.get(name) ?? []]) listener(event); }
}

describe('直接接入 RTM Client 的邀请插件', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('公开接入类型兼容实际Agora RTM Client', () => {
    expectTypeOf<InstanceType<IAgoraRTM['RTM']>>().toExtend<InvitationRtmClient>();
  });

  it('只传RTM Client与本端UID即可发起邀请，无需App编写port或分发事件', async () => {
    const client = new MemoryRtmClient('alice');
    let plugin: CallController | undefined;
    expect(() => { plugin = new CallController(client, { userId: 'alice', createCallId: () => ALPHA }); }).not.toThrow();
    const call = plugin!.createOutgoingInvitation('bob', 'opaque-extra');
    await call.start();
    expect(client.publish).toHaveBeenCalledWith('bob', JSON.stringify({ callId: ALPHA, extra: 'opaque-extra' }), {
      channelType: 'USER', customType: 'CALL_KIT_INVITE', storeInHistory: false,
    });
    expect(call.getSnapshot().state).toBe(2);
    expect(client.login).not.toHaveBeenCalled();
  });

  it('自动接收SDK message事件，并向App暴露来电和extra', async () => {
    const client = new MemoryRtmClient('alice');
    const incoming: string[] = [];
    const plugin = new CallController(client, {
      userId: 'alice', onIncomingInvitationsChanged: items => incoming.push(...items.map(item => item.getSnapshot().remoteExtra)),
    });
    client.emit('message', message('CALL_KIT_INVITE', ALPHA, undefined, 'bob', 'app-data'));
    expect(plugin.getInvitation(ALPHA)!.getSnapshot()).toMatchObject({ state: 11, remoteExtra: 'app-data' });
    expect(incoming).toEqual(['app-data']);
    await plugin.dispose();
  });

  it('自动跟随linkState，暂停期间截止不延长，恢复时立即重检', async () => {
    const client = new MemoryRtmClient('alice');
    const plugin = new CallController(client, { userId: 'alice', createCallId: () => ALPHA });
    const call = plugin.createOutgoingInvitation('bob');
    await call.start();
    const endTs = call.getSnapshot().endTs;
    client.emit('linkState', { currentState: 'DISCONNECTED' });
    expect(call.getSnapshot()).toMatchObject({ state: 2, endTs });
    vi.setSystemTime(Date.now() + 45_000);
    client.emit('linkState', { currentState: 'CONNECTED' });
    expect(call.getSnapshot()).toMatchObject({ state: 6, reason: 'PEER_NO_RESPONSE' });
    await plugin.dispose();
  });

  it('登录前安装时可指定初始断连，随后由真实连接事件启用呼叫', async () => {
    const client = new MemoryRtmClient('alice');
    const plugin = new CallController(client, { userId: 'alice', initialLinkState: 'disconnected', createCallId: () => ALPHA });
    client.emit('linkState', { currentState: 'CONNECTED' });
    await plugin.createOutgoingInvitation('bob').start();
    expect(plugin.getInvitation(ALPHA)!.getSnapshot().state).toBe(2);
    await plugin.dispose();
  });

  it('STREAM服务断连或失败不改变USER邀请，MESSAGE失败才结束邀请', async () => {
    const client = new MemoryRtmClient('alice');
    const plugin = new CallController(client, { userId: 'alice', createCallId: () => ALPHA });
    const call = plugin.createOutgoingInvitation('bob');
    await call.start();
    for (const currentState of ['DISCONNECTED', 'FAILED', 'CONNECTING']) {
      client.emit('linkState', { currentState, serviceType: 'STREAM' });
      expect(call.getSnapshot()).toMatchObject({ state: 2, ended: false });
    }
    client.emit('linkState', { currentState: 'FAILED', serviceType: 'MESSAGE' });
    expect(call.getSnapshot()).toMatchObject({ state: 6, reason: 'LOCAL_NETWORK_ERROR', trigger: 'LINK_FAILED' });
    await plugin.dispose();
  });

  it('STREAM连接成功不能冒充MESSAGE就绪而启用USER发送', async () => {
    const client = new MemoryRtmClient('alice');
    const plugin = new CallController(client, { userId: 'alice', initialLinkState: 'disconnected', createCallId: () => ALPHA });
    client.emit('linkState', { currentState: 'CONNECTED', serviceType: 'STREAM' });
    const call = plugin.createOutgoingInvitation('bob');
    await call.start();
    expect(call.getSnapshot()).toMatchObject({ state: 6, reason: 'LOCAL_NETWORK_ERROR' });
    expect(client.publish).not.toHaveBeenCalled();
    await plugin.dispose();
  });

  it('App自己的customType消息与邀请消息都仍可由原SDK listener接收', async () => {
    const client = new MemoryRtmClient('alice');
    const received: string[] = [];
    client.addEventListener('message', event => received.push(event.customType));
    const plugin = new CallController(client, { userId: 'alice' });
    client.emit('message', message('APP_ORDER_UPDATE', ALPHA, undefined, 'bob', 'order-data'));
    client.emit('message', message('CALL_KIT_INVITE'));
    expect(received).toEqual(['APP_ORDER_UPDATE', 'CALL_KIT_INVITE']);
    expect(plugin.getSnapshot().incomingInvitations).toHaveLength(1);
    await plugin.dispose();
    client.emit('message', message('APP_ORDER_UPDATE'));
    expect(received).toEqual(['APP_ORDER_UPDATE', 'CALL_KIT_INVITE', 'APP_ORDER_UPDATE']);
  });

  it('dispose仅移除自己的SDK回调，不注销client，且不会继续消费旧事件', async () => {
    const client = new MemoryRtmClient('alice');
    const business = vi.fn();
    client.addEventListener('message', business);
    const plugin = new CallController(client, { userId: 'alice' });
    await plugin.dispose();
    await plugin.dispose();
    client.emit('message', message('CALL_KIT_INVITE'));
    expect(business).toHaveBeenCalledOnce();
    expect(plugin.getSnapshot().incomingInvitations).toEqual([]);
    expect(client.listeners.get('message')?.size).toBe(1);
    expect(client.listeners.get('linkState')?.size).toBe(0);
    expect(client.logout).not.toHaveBeenCalled();
  });

  it('同一client禁止重复安装，卸载后允许重新安装', async () => {
    const client = new MemoryRtmClient('alice');
    const first = new CallController(client, { userId: 'alice' });
    expect(() => new CallController(client, { userId: 'alice' })).toThrow('已绑定邀请插件');
    await first.dispose();
    const second = new CallController(client, { userId: 'alice' });
    client.emit('message', message('CALL_KIT_INVITE'));
    expect(second.getSnapshot().incomingInvitations).toHaveLength(1);
    await second.dispose();
  });

  it('两个插件只接SDK Client即可完成USER握手，不需要手工handleMessage', async () => {
    const alice = new MemoryRtmClient('alice');
    const bob = new MemoryRtmClient('bob');
    const clients = new Map([['alice', alice], ['bob', bob]]);
    const messages: Array<() => void> = [];
    for (const client of clients.values()) client.deliver = (target, event) => {
      messages.push(() => clients.get(target)!.emit('message', event));
    };
    const caller = new CallController(alice, { userId: 'alice', createCallId: () => ALPHA });
    const callee = new CallController(bob, { userId: 'bob' });
    const outgoing = caller.createOutgoingInvitation('bob', 'caller-data');
    await outgoing.start();
    messages.shift()!();
    const incoming = callee.getInvitation(ALPHA)!;
    await incoming.accept('callee-data');
    messages.shift()!();
    messages.shift()!();
    expect(outgoing.getSnapshot()).toMatchObject({ state: 3, remoteExtra: 'callee-data' });
    expect(incoming.getSnapshot()).toMatchObject({ state: 13, remoteExtra: 'caller-data' });
    await Promise.all([caller.dispose(), callee.dispose()]);
  });
});
