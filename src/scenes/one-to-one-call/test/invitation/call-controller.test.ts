import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CallController } from '../../invitation/call-controller';
import { ALPHA, BETA, deferred, message, setup } from './invitation.test-helpers';

describe('纯信令管理器与多邀请路由', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('多个呼入独立保存、计时和移除，不自动忙线', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE', ALPHA));
    const alpha = c.controller.getInvitation(ALPHA)!;
    const alphaEnd = alpha.getSnapshot().endTs;
    await vi.advanceTimersByTimeAsync(1_000);
    await c.controller.handleMessage(message('CALL_KIT_INVITE', BETA, undefined, 'carol'));
    const beta = c.controller.getInvitation(BETA)!;
    expect(c.controller.getSnapshot().incomingInvitations.map(item => item.callId)).toEqual([BETA, ALPHA]);
    await alpha.refuse();
    expect(alpha.getSnapshot().state).toBe(14);
    expect(beta.getSnapshot()).toMatchObject({ state: 11, endTs: alphaEnd + 1_000 });
    expect(c.controller.getSnapshot().incomingInvitations).toEqual([beta]);
    expect(c.sent.map(item => item.customType)).toEqual(['CALL_KIT_REFUSE']);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(beta.getSnapshot().state).toBe(11);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(beta.getSnapshot().state).toBe(16);
  });

  it('重复INVITE不刷新原截止或排序，终态记录不复活', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    const alpha = c.controller.getInvitation(ALPHA)!;
    const endTs = alpha.getSnapshot().endTs;
    await vi.advanceTimersByTimeAsync(10_000);
    await c.controller.handleMessage(message('CALL_KIT_INVITE', ALPHA, undefined, 'bob', 'changed'));
    expect(c.controller.getInvitation(ALPHA)).toBe(alpha);
    expect(alpha.getSnapshot()).toMatchObject({ endTs, remoteExtra: '' });
    await vi.advanceTimersByTimeAsync(20_000);
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    expect(alpha.getSnapshot().state).toBe(16);
    expect(c.controller.getSnapshot().incomingInvitations).toEqual([]);
  });

  it('先收到CANCEL再收到INVITE不会出现幽灵来电，也不误伤其他对端', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_CANCEL'));
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    expect(c.controller.getInvitation(ALPHA)).toBeUndefined();
    await c.controller.handleMessage(message('CALL_KIT_INVITE', ALPHA, undefined, 'carol'));
    expect(c.controller.getInvitation(ALPHA)!.getSnapshot()).toMatchObject({ remoteUid: 'carol', state: 11 });
  });

  it('相同callId但publisher不同不能改写邀请或回ACK', async () => {
    const c = setup();
    const call = c.controller.createOutgoingInvitation('bob');
    await call.start();
    const ignored = await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'accepted', 'mallory'));
    expect(ignored.consumed).toBe(false);
    expect(call.getSnapshot().state).toBe(2);
    expect(c.sent).toHaveLength(1);
  });

  it('三类回调与实例状态来自同一提交，接听待确认仍保留来电', async () => {
    const local: number[] = [], remote: number[] = [], incoming: number[] = [];
    const c = setup({
      onCallerStateChanged: (event: { state: number }) => local.push(event.state),
      onCalleeStateChanged: (event: { state: number }) => remote.push(event.state),
      onIncomingInvitationsChanged: (items: readonly unknown[]) => incoming.push(items.length),
    });
    const outgoing = c.controller.createOutgoingInvitation('carol');
    await outgoing.start();
    await c.controller.handleMessage(message('CALL_KIT_INVITE', BETA));
    const call = c.controller.getInvitation(BETA)!;
    const instance: number[] = [];
    call.on('stateChanged', event => instance.push(event.state));
    await call.accept();
    expect(c.controller.getSnapshot().incomingInvitations).toEqual([call]);
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', BETA, 'ack'));
    expect(local).toEqual([1, 2]);
    expect(remote).toEqual([11, 12, 13]);
    expect(instance).toEqual([12, 13]);
    expect(incoming).toEqual([1, 0]);
  });

  it('incomingInvitation回调可以直接接听，仍完整通知11、12、13', async () => {
    const c = setup();
    const states: number[] = [];
    let accepted: Promise<void> | undefined;
    c.controller.on('incomingInvitation', invitation => {
      invitation.on('stateChanged', event => states.push(event.state));
      accepted = invitation.accept();
    });
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    await accepted;
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'ack'));
    expect(states).toEqual([11, 12, 13]);
  });

  it('incomingInvitation回调可以直接拒绝，不漏报初次收到状态', async () => {
    const c = setup();
    const states: number[] = [];
    c.controller.on('incomingInvitation', invitation => {
      invitation.on('stateChanged', event => states.push(event.state));
      void invitation.refuse();
    });
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    expect(states).toEqual([11, 14]);
    expect(c.controller.getSnapshot().incomingInvitations).toEqual([]);
  });

  it('旧取消通知pending不妨碍创建和完成另一条主叫实例', async () => {
    const c = setup();
    const alpha = c.controller.createOutgoingInvitation('bob');
    await alpha.start();
    const notification = deferred();
    c.publishWith(async (_target, type) => { if (type === 'CALL_KIT_CANCEL') await notification.promise; });
    const pending = alpha.cancel();
    const beta = c.controller.createOutgoingInvitation('carol');
    await beta.start();
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', BETA, 'accepted', 'carol'));
    notification.resolve();
    await pending;
    expect(alpha.getSnapshot().state).toBe(5);
    expect(beta.getSnapshot().state).toBe(3);
  });

  it('已接受的重复accepted仅补ACK，不重复终态通知；ACK也不递归回应', async () => {
    const c = setup();
    const call = c.controller.createOutgoingInvitation('bob');
    const states: number[] = [];
    call.on('stateChanged', event => states.push(event.state));
    await call.start();
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'accepted'));
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'accepted'));
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'ack'));
    expect(states).toEqual([1, 2, 3]);
    expect(c.sent.filter(item => item.payload.type === 'ack')).toHaveLength(2);
  });

  it('不可恢复FAILED结束全部待处理实例，不影响已接受实例结果', async () => {
    const c = setup();
    const alpha = c.controller.createOutgoingInvitation('bob');
    await alpha.start();
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'accepted'));
    await c.controller.handleMessage(message('CALL_KIT_INVITE', BETA, undefined, 'carol'));
    c.setLinkState('failed');
    c.controller.handleLinkStateChange();
    expect(alpha.getSnapshot().state).toBe(3);
    expect(c.controller.getInvitation(BETA)!.getSnapshot()).toMatchObject({ state: 16, reason: 'LOCAL_NETWORK_ERROR', trigger: 'LINK_FAILED' });
  });

  it('拒绝通知失败保留14，通知错误独立于状态事件', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    const call = c.controller.getInvitation(ALPHA)!;
    const states: number[] = [], errors: string[] = [];
    call.on('stateChanged', event => states.push(event.state));
    c.controller.on('operationError', event => errors.push(event.operation));
    c.publishWith(async () => { throw new Error('publish timeout'); });
    await call.refuse().catch(() => undefined);
    expect(states).toEqual([14]);
    expect(errors).toEqual(['REFUSE']);
    expect(call.getSnapshot().state).toBe(14);
  });

  it('同一管理器可同时创建多条独立外呼，不以媒体名额限制模块', async () => {
    const c = setup();
    const alpha = c.controller.createOutgoingInvitation('bob');
    const beta = c.controller.createOutgoingInvitation('carol');
    await Promise.all([alpha.start(), beta.start()]);
    await c.controller.handleMessage(message('CALL_KIT_REFUSE', ALPHA));
    expect(alpha.getSnapshot().state).toBe(4);
    expect(beta.getSnapshot().state).toBe(2);
  });

  it('两端独立实例以相同 callId 按发布完成顺序完成握手，无 RTC 依赖', async () => {
    const managers = new Map<string, CallController>();
    const order: string[] = [];
    const messages: Array<() => Promise<unknown>> = [];
    for (const uid of ['alice', 'bob']) managers.set(uid, new CallController({
      localUid: uid, getLinkState: () => 'connected', createCallId: () => ALPHA,
      port: { async publishToUser(target, customType, payload) {
        order.push(uid + ':' + customType + ':' + String(JSON.parse(payload).type ?? 'invite'));
        messages.push(() => managers.get(target)!.handleMessage({ channelType: 'USER', publisher: uid, customType, message: payload }));
      } },
    }));
    const caller = managers.get('alice')!.createOutgoingInvitation('bob', 'caller-extra');
    await caller.start();
    expect(managers.get('bob')!.getInvitation(ALPHA)).toBeUndefined();
    await messages.shift()!();
    const callee = managers.get('bob')!.getInvitation(ALPHA)!;
    expect(callee).not.toBe(caller);
    expect(caller.getSnapshot()).toMatchObject({ callId: ALPHA, role: 'CALLER', localUid: 'alice', remoteUid: 'bob', state: 2 });
    expect(callee.getSnapshot()).toMatchObject({ callId: ALPHA, role: 'CALLEE', localUid: 'bob', remoteUid: 'alice', state: 11 });
    await callee.accept('callee-extra');
    await messages.shift()!();
    await messages.shift()!();
    expect(caller.getSnapshot()).toMatchObject({ state: 3, remoteExtra: 'callee-extra' });
    expect(callee.getSnapshot()).toMatchObject({ state: 13, remoteExtra: 'caller-extra' });
    expect(order).toEqual(['alice:CALL_KIT_INVITE:invite', 'bob:CALL_KIT_ACCEPT:accepted', 'alice:CALL_KIT_ACCEPT:ack']);
  });

  it('主叫已过期时不回复成功ACK，被叫按自己的原截止失败', async () => {
    const c = setup({ invitationOptions: { callerInvitationExpireMs: 1_000 } });
    const caller = c.controller.createOutgoingInvitation('bob');
    await caller.start();
    await vi.advanceTimersByTimeAsync(1_001);
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'accepted'));
    expect(caller.getSnapshot()).toMatchObject({ state: 6, reason: 'PEER_NO_RESPONSE' });
    expect(c.sent).toHaveLength(1);
  });
});
