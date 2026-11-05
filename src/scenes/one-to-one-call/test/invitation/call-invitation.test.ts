import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALPHA, deferred, flush, message, setup } from './invitation.test-helpers';

describe('独立纯信令邀请', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('不注入 RTC、appId、昵称或 Demo UID 规则也能创建和发送', async () => {
    const { controller, sent } = setup();
    let invitation: ReturnType<typeof controller.createOutgoingInvitation> | undefined;
    expect(() => { invitation = controller.createOutgoingInvitation('bob', 'opaque'); }).not.toThrow();
    await invitation!.start();
    expect(invitation!.getSnapshot()).toMatchObject({ role: 'CALLER', state: 2, ended: false, extra: 'opaque' });
    expect(sent).toEqual([{ target: 'bob', customType: 'CALL_KIT_INVITE', payload: { callId: ALPHA, extra: 'opaque' } }]);
  });

  it('主叫从 publish resolve 起拥有完整配置等待窗口', async () => {
    const c = setup();
    const gate = deferred();
    c.publishWith(() => gate.promise);
    const call = c.controller.createOutgoingInvitation('bob');
    const start = Date.now();
    const pending = call.start();
    expect(call.getSnapshot().state).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    gate.resolve();
    await pending;
    expect(call.getSnapshot()).toMatchObject({ state: 2, startTs: start + 3_000, endTs: start + 33_000 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(call.getSnapshot().state).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.getSnapshot()).toMatchObject({ state: 6, ended: true, reason: 'PEER_NO_RESPONSE' });
  });

  it('INVITE 默认失败后间隔重试两次，数据一致，耗尽即失败', async () => {
    const c = setup();
    const offline = Object.assign(new Error('target user is offline'), { errorCode: -12345 });
    c.publishWith(async () => { throw offline; });
    const call = c.controller.createOutgoingInvitation('bob', 'payload');
    const pending = call.start();
    await flush();
    expect(c.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(c.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(c.sent).toHaveLength(3);
    expect(c.sent.every(item => item.payload.callId === ALPHA && item.payload.extra === 'payload')).toBe(true);
    expect(call.getSnapshot()).toMatchObject({
      state: 6, reason: 'PEER_OFFLINE', trigger: 'RETRY_EXHAUSTED',
      sdkError: { code: -12345, message: 'target user is offline' }, linkStateAtFailure: 'connected',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.sent).toHaveLength(3);
  });

  it('自定义重试次数为零，CONNECTED 加普通错误不冒充对方离线', async () => {
    const c = setup({ invitationOptions: { maxRetries: 0 } });
    c.publishWith(async () => { throw new Error('unexpected transport failure'); });
    const call = c.controller.createOutgoingInvitation('bob');
    await call.start();
    expect(c.sent).toHaveLength(1);
    expect(call.getSnapshot()).toMatchObject({ state: 6, reason: 'PUBLISH_FAILED', trigger: 'RETRY_EXHAUSTED' });
  });

  it('发送截止发生在重试间隔时，旧SDK证据保留发生时间和尝试编号', async () => {
    const c = setup({ invitationOptions: { sendTimeoutMs: 1_000, retryIntervalMs: 2_000 } });
    const failureAt = Date.now();
    c.publishWith(async () => { throw Object.assign(new Error('SDK publish failure'), { errorCode: -11033 }); });
    const call = c.controller.createOutgoingInvitation('bob');
    const pending = call.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(call.getSnapshot()).toMatchObject({
      state: 6, reason: 'PEER_OFFLINE', trigger: 'SEND_TIMEOUT', failureAt, failureAttempt: 1,
    });
  });

  it('当前重试在截止时仍pending，迟到结果不能把上一轮错误当成当前失败', async () => {
    const c = setup({ invitationOptions: { sendTimeoutMs: 5_000 } });
    const gate = deferred();
    let calls = 0;
    c.publishWith(async () => {
      if (++calls === 1) throw Object.assign(new Error('first SDK failure'), { errorCode: -11033 });
      await gate.promise;
    });
    const call = c.controller.createOutgoingInvitation('bob');
    const pending = call.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(c.sent).toHaveLength(2);
    vi.setSystemTime(Date.now() + 10_000);
    gate.resolve();
    await pending;
    expect(call.getSnapshot()).toMatchObject({ state: 6, reason: 'SEND_TIMEOUT', trigger: 'SEND_TIMEOUT' });
    expect(call.getSnapshot().sdkError).toBeUndefined();
  });

  it('本地断网导致发送失败保留失败时连接状态，恢复不重写原因', async () => {
    const c = setup({ invitationOptions: { maxRetries: 0 } });
    c.publishWith(async () => { c.setLinkState('reconnecting'); throw new Error('transport failure'); });
    const call = c.controller.createOutgoingInvitation('bob');
    await call.start();
    c.setLinkState('connected');
    c.controller.handleLinkStateChange();
    expect(call.getSnapshot()).toMatchObject({ state: 6, reason: 'LOCAL_NETWORK_ERROR', linkStateAtFailure: 'reconnecting' });
  });

  it('发送 pending 时总截止仍终结，迟到成功不重开等待窗口', async () => {
    const c = setup({ invitationOptions: { sendTimeoutMs: 1_000 } });
    const gate = deferred();
    c.publishWith(() => gate.promise);
    const call = c.controller.createOutgoingInvitation('bob');
    const pending = call.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(call.getSnapshot()).toMatchObject({ state: 6, reason: 'SEND_TIMEOUT', trigger: 'SEND_TIMEOUT' });
    gate.resolve();
    await flush();
    expect(call.getSnapshot().state).toBe(6);
  });

  it('API 返回时先检查绝对截止，即使发送 timer 尚未执行', async () => {
    const c = setup();
    const gate = deferred();
    c.publishWith(() => gate.promise);
    const call = c.controller.createOutgoingInvitation('bob');
    const pending = call.start();
    vi.setSystemTime(Date.now() + 45_000);
    gate.resolve();
    await pending;
    expect(call.getSnapshot()).toMatchObject({ state: 6, reason: 'SEND_TIMEOUT' });
  });

  it.each(['CALL_KIT_ACCEPT', 'CALL_KIT_REFUSE'] as const)('非等待响应阶段的 %s 不参与后续状态流转', async (customType) => {
    const c = setup();
    const gate = deferred();
    c.publishWith(async (_target, type) => { if (type === 'CALL_KIT_INVITE') await gate.promise; });
    const call = c.controller.createOutgoingInvitation('bob');
    const states: number[] = [];
    call.on('stateChanged', event => states.push(event.state));
    const pending = call.start();
    const response = message(customType, ALPHA, customType === 'CALL_KIT_ACCEPT' ? 'accepted' : undefined);
    const ignored = await c.controller.handleMessage(response);
    expect(ignored.consumed).toBe(false);
    expect(call.getSnapshot().state).toBe(1);
    expect(c.sent).toHaveLength(1);
    gate.resolve();
    await pending;
    await flush();
    expect(states).toEqual([1, 2]);
    expect(c.sent).toHaveLength(1);
    await c.controller.handleMessage(response);
    expect(states).toEqual([1, 2, customType === 'CALL_KIT_ACCEPT' ? 3 : 4]);
    if (customType === 'CALL_KIT_ACCEPT') expect(c.sent.at(-1)?.payload.type).toBe('ack');
  });

  it('被叫发布接听期间保持11，成功为12，ACK后才13', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE', ALPHA, undefined, 'bob', 'caller-data'));
    const call = c.controller.getInvitation(ALPHA)!;
    const gate = deferred();
    c.publishWith(() => gate.promise);
    const pending = call.accept('callee-data');
    expect(call.getSnapshot()).toMatchObject({ state: 11, publishing: true, remoteExtra: 'caller-data' });
    expect(c.sent.at(-1)?.payload).toEqual({ callId: ALPHA, extra: 'callee-data', type: 'accepted' });
    gate.resolve();
    await pending;
    expect(call.getSnapshot()).toMatchObject({ state: 12, publishing: false, ended: false });
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'ack'));
    expect(call.getSnapshot()).toMatchObject({ state: 13, ended: true });
  });

  it('被叫接听失败保持11并返回原错，在同一窗口可再次接听', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    const call = c.controller.getInvitation(ALPHA)!;
    const deadline = call.getSnapshot().endTs;
    const error = new Error('publish timeout');
    c.publishWith(async () => { throw error; });
    await expect(call.accept()).rejects.toBe(error);
    expect(call.getSnapshot()).toMatchObject({ state: 11, ended: false, publishing: false, endTs: deadline });
    c.publishWith(async () => undefined);
    await call.accept();
    expect(call.getSnapshot()).toMatchObject({ state: 12, endTs: deadline });
  });

  it('接听失败无人再操作时原窗口到期失败，不自动重发接听', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    const call = c.controller.getInvitation(ALPHA)!;
    c.publishWith(async () => { throw new Error('timeout'); });
    await call.accept().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(call.getSnapshot()).toMatchObject({ state: 16, reason: 'INVITATION_EXPIRE' });
    expect(c.sent).toHaveLength(1);
  });

  it('等待ACK沿用原被叫截止，不再增加30秒', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    const call = c.controller.getInvitation(ALPHA)!;
    const endTs = call.getSnapshot().endTs;
    await vi.advanceTimersByTimeAsync(29_000);
    await call.accept();
    expect(call.getSnapshot()).toMatchObject({ state: 12, endTs });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(call.getSnapshot()).toMatchObject({ state: 16, reason: 'ACCEPT_ACK_TIMEOUT' });
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'ack'));
    expect(call.getSnapshot().state).toBe(16);
  });

  it('接听发布 pending 时收到CANCEL立即终结，迟到成功或ACK不能覆盖', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    const call = c.controller.getInvitation(ALPHA)!;
    const gate = deferred();
    c.publishWith(() => gate.promise);
    const pending = call.accept();
    await c.controller.handleMessage(message('CALL_KIT_CANCEL'));
    await pending;
    expect(call.getSnapshot()).toMatchObject({ state: 15, ended: true });
    gate.resolve();
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'ack'));
    await flush();
    expect(call.getSnapshot().state).toBe(15);
  });

  it('主叫先取消再收到accepted，保留5且不回ACK', async () => {
    const c = setup();
    const call = c.controller.createOutgoingInvitation('bob');
    await call.start();
    await call.cancel();
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'accepted'));
    expect(call.getSnapshot()).toMatchObject({ state: 5, ended: true });
    expect(c.sent.map(item => item.customType)).toEqual(['CALL_KIT_INVITE', 'CALL_KIT_CANCEL']);
  });

  it('取消或拒绝通知pending时本端先终态，通知等待有界', async () => {
    const c = setup({ invitationOptions: { sendTimeoutMs: 1_000 } });
    const call = c.controller.createOutgoingInvitation('bob');
    await call.start();
    const gate = deferred();
    c.publishWith(() => gate.promise);
    const pending = call.cancel().catch(() => undefined);
    expect(call.getSnapshot().state).toBe(5);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(call.getSnapshot().state).toBe(5);
    gate.resolve();
    await flush();
  });

  it.each(['resolve', 'reject'] as const)('通知%s回调恢复执行时先检查绝对截止，不冒充窗口内SDK结果', async (mode) => {
    const c = setup({ invitationOptions: { sendTimeoutMs: 1_000 } });
    const call = c.controller.createOutgoingInvitation('bob');
    await call.start();
    const gate = deferred();
    c.publishWith(() => gate.promise);
    const errors: Array<{ operation: string; reason: string; sdkError?: unknown }> = [];
    call.on('operationError', event => errors.push(event));
    const pending = call.cancel().then(() => undefined, error => error);
    vi.setSystemTime(Date.now() + 5_000);
    if (mode === 'resolve') gate.resolve();
    else gate.reject(Object.assign(new Error('late SDK failure'), { errorCode: -11033 }));
    expect(await pending).toBeInstanceOf(Error);
    expect(call.getSnapshot().state).toBe(5);
    expect(errors).toEqual([expect.objectContaining({ operation: 'CANCEL', reason: 'PUBLISH_TIMEOUT' })]);
    expect(errors[0]?.sdkError).toBeUndefined();
  });

  it('非等待确认阶段的 ACK 不参与后续接听结果', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    const call = c.controller.getInvitation(ALPHA)!;
    const states: number[] = [];
    call.on('stateChanged', event => states.push(event.state));
    const gate = deferred();
    c.publishWith(() => gate.promise);
    const pending = call.accept();
    const ignored = await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'ack'));
    expect(ignored.consumed).toBe(false);
    expect(call.getSnapshot().state).toBe(11);
    gate.resolve();
    await pending;
    expect(states).toEqual([12]);
    expect(call.getSnapshot()).toMatchObject({ state: 12, ended: false });
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'ack'));
    expect(states).toEqual([12, 13]);
  });

  it('未点击接听的来电忽略ACK，不能凭空变为接受', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'ack'));
    expect(c.controller.getInvitation(ALPHA)!.getSnapshot().state).toBe(11);
  });

  it('只有本次 callId 和预期主叫的协议 ACK 能完成接听', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    const call = c.controller.getInvitation(ALPHA)!;
    await call.accept();
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'ack'));
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'ack', 'carol'));
    await c.controller.handleMessage(message('APP_MESSAGE', ALPHA, undefined));
    expect(call.getSnapshot()).toMatchObject({ state: 12, ended: false });
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'ack'));
    expect(call.getSnapshot()).toMatchObject({ state: 13, ended: true, publishing: false });
  });

  it('接听发送完成时原子提交12并解锁，监听不能趁间隙再拒绝', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    const call = c.controller.getInvitation(ALPHA)!;
    let sawPublishing = false;
    call.subscribe(() => {
      const view = call.getSnapshot();
      if (view.publishing) sawPublishing = true;
      if (sawPublishing && !view.publishing && view.state === 11) void call.refuse();
    });
    await call.accept();
    expect(call.getSnapshot()).toMatchObject({ state: 12, publishing: false });
    expect(c.sent.map(item => item.customType)).toEqual(['CALL_KIT_ACCEPT']);
  });

  it('ACK发布失败不回滚主叫3，状态只通知一次', async () => {
    const c = setup();
    const call = c.controller.createOutgoingInvitation('bob');
    const states: number[] = [];
    call.on('stateChanged', event => states.push(event.state));
    await call.start();
    c.publishWith(async () => { throw new Error('ack failed'); });
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'accepted'));
    await flush();
    expect(call.getSnapshot()).toMatchObject({ state: 3, ended: true });
    expect(states).toEqual([1, 2, 3]);
  });

  it('睡眠恢复不依赖timer先执行，重检立即结束并丢弃迟到ACK', async () => {
    const c = setup();
    await c.controller.handleMessage(message('CALL_KIT_INVITE'));
    const call = c.controller.getInvitation(ALPHA)!;
    await call.accept();
    vi.setSystemTime(Date.now() + 45_000);
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'ack'));
    expect(call.getSnapshot()).toMatchObject({ state: 16, reason: 'ACCEPT_ACK_TIMEOUT' });
  });

  it('监听抛异常或重入取消，不打断顺序也不让INVITE继续发送', async () => {
    const c = setup();
    const call = c.controller.createOutgoingInvitation('bob');
    const states: number[] = [];
    call.on('stateChanged', event => { if (event.state === 1) void call.cancel(); });
    call.on('stateChanged', () => { throw new Error('view failure'); });
    call.on('stateChanged', event => states.push(event.state));
    await call.start();
    expect(states).toEqual([1, 5]);
    expect(c.sent.some(item => item.customType === 'CALL_KIT_INVITE')).toBe(false);
  });

  it('临时断网不重置等待截止，恢复后过期仍结束', async () => {
    const c = setup();
    const call = c.controller.createOutgoingInvitation('bob');
    await call.start();
    const endTs = call.getSnapshot().endTs;
    c.setLinkState('reconnecting');
    c.controller.handleLinkStateChange();
    expect(call.getSnapshot()).toMatchObject({ state: 2, endTs });
    vi.setSystemTime(Date.now() + 45_000);
    c.setLinkState('connected');
    c.controller.handleLinkStateChange();
    expect(call.getSnapshot()).toMatchObject({ state: 6, reason: 'PEER_NO_RESPONSE' });
  });

  it('停止会结束未完成操作并抑制之后的重试和消息', async () => {
    const c = setup();
    const gate = deferred();
    c.publishWith(() => gate.promise);
    const call = c.controller.createOutgoingInvitation('bob');
    const pending = call.start();
    const seen: number[] = [];
    call.on('stateChanged', event => seen.push(event.state));
    await c.controller.dispose();
    await pending;
    const count = seen.length;
    gate.reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(90_000);
    await c.controller.handleMessage(message('CALL_KIT_ACCEPT', ALPHA, 'accepted'));
    expect(call.getSnapshot().ended).toBe(true);
    expect(seen).toHaveLength(count);
    expect(c.sent).toHaveLength(1);
  });
});
