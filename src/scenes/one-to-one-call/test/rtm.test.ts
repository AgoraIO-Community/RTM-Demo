import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CallRtm } from '../rtm';

const ALPHA = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BETA = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const incoming = (id = ALPHA, customType = 'CALL_KIT_INVITE', type?: string, publisher = 'bob', extra = '') => ({
  channelType: 'USER', customType, publisher, message: JSON.stringify({ callId: id, extra, ...(type ? { type } : {}) }),
});

function setup() {
  const sent: Array<{ target: string; customType: string; payload: Record<string, unknown> }> = [];
  let id = 0;
  let linkState: 'connected' | 'reconnecting' | 'failed' = 'connected';
  let publish: () => Promise<void> = async () => undefined;
  const rtm = new CallRtm({
    userId: 'alice', createCallId: () => [ALPHA, BETA][id++]!,
    session: {
      getCurrentLinkState: () => linkState,
      getCallPort: () => ({ async publishToUser(target, customType, message) {
        sent.push({ target, customType, payload: JSON.parse(message) });
        await publish();
      } }),
    },
  });
  return { rtm, sent, failPublish(error: Error) { publish = async () => { throw error; }; }, setLinkState(value: typeof linkState) { linkState = value; } };
}

describe('CallRtm 场景业务接口', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('App通过rtm发送邀请并处理accepted和ACK，不操作插件实例', async () => {
    const c = setup();
    const view = c.rtm.createOutgoingInvitation('bob', 'caller-data');
    expect(view.getSnapshot()).toMatchObject({ state: 0, callId: ALPHA });
    await c.rtm.sendCallInvitation(view.callId);
    await c.rtm.handleMessage(incoming(ALPHA, 'CALL_KIT_ACCEPT', 'accepted', 'bob', 'callee-data'));
    expect(view.getSnapshot()).toMatchObject({ state: 3, ended: true, remoteExtra: 'callee-data' });
    expect(c.sent.map(item => [item.customType, item.payload.type])).toEqual([
      ['CALL_KIT_INVITE', undefined], ['CALL_KIT_ACCEPT', 'ack'],
    ]);
    expect(c.rtm.getInvitation(ALPHA)).toBe(view);
  });

  it('来电只读句柄没有插件操作，接听须通过场景函数', async () => {
    const c = setup();
    await c.rtm.handleMessage(incoming(ALPHA, 'CALL_KIT_INVITE', undefined, 'bob', 'opaque-data'));
    const view = c.rtm.getInvitation(ALPHA)!;
    expect('accept' in view || 'start' in view || 'cancel' in view).toBe(false);
    expect(() => { Object.assign(view.getSnapshot(), { state: 13 }); }).toThrow();
    expect(view.getSnapshot()).toMatchObject({ state: 11, remoteExtra: 'opaque-data' });
    await c.rtm.acceptCallInvitation(ALPHA, 'local-extra');
    expect(view.getSnapshot().state).toBe(12);
    await c.rtm.handleMessage(incoming(ALPHA, 'CALL_KIT_ACCEPT', 'ack'));
    expect(view.getSnapshot()).toMatchObject({ state: 13, ended: true });
  });

  it('多来电集合和逐项拒绝经rtm通知，未操作项截止不变', async () => {
    const c = setup();
    await c.rtm.handleMessage(incoming());
    const first = c.rtm.getInvitation(ALPHA)!;
    const endTs = first.getSnapshot().endTs;
    await vi.advanceTimersByTimeAsync(1_000);
    await c.rtm.handleMessage(incoming(BETA, 'CALL_KIT_INVITE', undefined, 'carol'));
    await c.rtm.refuseCallInvitation(BETA);
    expect(c.rtm.getSnapshot().incomingInvitations).toEqual([first]);
    expect(first.getSnapshot()).toMatchObject({ state: 11, endTs });
    expect(c.rtm.getInvitation(BETA)!.getSnapshot().state).toBe(14);
  });

  it('先通知App注册只读监听，之后完整收到来电与等待确认状态', async () => {
    const c = setup();
    const states: number[] = [];
    c.rtm.on('incomingInvitation', view => view.subscribe(() => states.push(view.getSnapshot().state)));
    await c.rtm.handleMessage(incoming());
    await c.rtm.acceptCallInvitation(ALPHA);
    expect(states).toContain(11);
    expect(states.at(-1)).toBe(12);
  });

  it('取消通知失败保持邀请终态，通过rtm独立上报操作错误', async () => {
    const c = setup();
    const view = c.rtm.createOutgoingInvitation('bob');
    await c.rtm.sendCallInvitation(view.callId);
    const errors: string[] = [];
    c.rtm.on('operationError', event => errors.push(event.operation));
    c.failPublish(new Error('publish timeout'));
    await c.rtm.cancelCallInvitation(view.callId).catch(() => undefined);
    expect(view.getSnapshot().state).toBe(5);
    expect(errors).toEqual(['CANCEL']);
  });

  it('重连和恢复检查由rtm处理，不改变原截止或让迟到结果复活', async () => {
    const c = setup();
    const view = c.rtm.createOutgoingInvitation('bob');
    await c.rtm.sendCallInvitation(view.callId);
    const endTs = view.getSnapshot().endTs;
    c.setLinkState('reconnecting');
    c.rtm.handleLinkStateChange();
    expect(view.getSnapshot()).toMatchObject({ state: 2, endTs });
    vi.setSystemTime(Date.now() + 45_000);
    c.setLinkState('connected');
    c.rtm.checkDeadlines();
    expect(view.getSnapshot()).toMatchObject({ state: 6, reason: 'PEER_NO_RESPONSE' });
  });

  it('销毁rtm结束所属邀请并停止事件，不管理页面SDK登录生命周期', async () => {
    const c = setup();
    const view = c.rtm.createOutgoingInvitation('bob');
    await c.rtm.sendCallInvitation(view.callId);
    await c.rtm.dispose();
    expect(view.getSnapshot()).toMatchObject({ state: 6, reason: 'STOPPED' });
    expect((await c.rtm.handleMessage(incoming(BETA))).consumed).toBe(false);
    expect(c.rtm.getSnapshot().incomingInvitations).toEqual([]);
    expect(() => c.rtm.createOutgoingInvitation('carol')).toThrow();
  });
});
