import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRtcHelper } from '../../../../shared/rtc';
import { CallAudioSession } from '../../rtc/call-audio';
import { AppCallController } from '../../app/call-controller';
import { CallRtm, type CallSignalType } from '../../rtm';

const ALPHA = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BETA = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const LOCAL = 'call-local01';
const PEER = 'call-remote02';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function createSdk() {
  const handlers = new Map<string, (...args: never[]) => void>();
  const microphone = { close: vi.fn(), setMuted: vi.fn(async () => undefined) };
  const client = {
    on: (name: string, listener: (...args: never[]) => void) => handlers.set(name, listener),
    join: vi.fn(async () => LOCAL), leave: vi.fn(async (): Promise<void> => undefined),
    publish: vi.fn(async () => undefined), unpublish: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => ({ play: vi.fn() })), enableAudioVolumeIndicator: vi.fn(),
  };
  return {
    client, microphone,
    emit(name: string, uid = PEER) { handlers.get(name)?.({ uid } as never); },
    deps: {
      createClient: () => client as never,
      createMicrophoneAudioTrack: vi.fn(async () => microphone as never),
      createCameraVideoTrack: vi.fn(async () => ({} as never)),
    },
  };
}

function setup() {
  const sdks: ReturnType<typeof createSdk>[] = [];
  let nextCall = 0;
  const publish = vi.fn(async (_target: string, _type: CallSignalType, _message: string): Promise<void> => undefined);
  const rtm = new CallRtm({
    userId: LOCAL,
    session: { getCallPort: () => ({ publishToUser: publish }), getCurrentLinkState: () => 'connected' },
    createCallId: () => [ALPHA, BETA][nextCall++]!,
  });
  const controller = new AppCallController({
    appId: 'app-id', localUid: LOCAL, nickname: 'Alice', rtm,
    createAudio: () => {
      const sdk = createSdk();
      sdks.push(sdk);
      return new CallAudioSession(createRtcHelper(sdk.deps));
    },
  });
  return { controller, rtm, sdks, publish };
}

function message(callId: string, customType: CallSignalType, publisher = PEER, extra = '', type?: 'accepted' | 'ack') {
  return { channelType: 'USER', publisher, customType, message: JSON.stringify({ callId, extra, ...(type ? { type } : {}) }) };
}

async function flush() { for (let n = 0; n < 16; n++) await Promise.resolve(); }

async function connect(context: ReturnType<typeof setup>, id = ALPHA, sdkIndex = 0) {
  await context.rtm.handleMessage(message(id, 'CALL_KIT_ACCEPT', PEER, '', 'accepted'));
  await flush();
  context.sdks[sdkIndex]!.emit('user-joined');
  expect(context.controller.getSnapshot().call.status).toBe('ACTIVE');
}

describe('AppCallController 邀请与媒体分离', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('接听发布成功后等待 ACK，只有最终接受才建立音频', async () => {
    const context = setup();
    await context.rtm.handleMessage(message(ALPHA, 'CALL_KIT_INVITE', PEER, '{"nickname":"小明"}'));
    await context.controller.accept(ALPHA);
    expect(context.controller.getSnapshot().call.status).toBe('ACCEPT_WAITING_ACK');
    expect(context.sdks).toHaveLength(0);
    expect(context.controller.getSnapshot().incomingInvitations).toHaveLength(1);
    await context.rtm.handleMessage(message(ALPHA, 'CALL_KIT_ACCEPT', PEER, '', 'ack'));
    await flush();
    expect(context.sdks).toHaveLength(1);
    expect(context.controller.getSnapshot().call).toMatchObject({ status: 'MEDIA_CONNECTING', call: { remoteNickname: '小明' } });
    await context.controller.end();
    expect(context.controller.getInvitation(ALPHA)!.getSnapshot()).toMatchObject({ state: 13, ended: true });
    await context.controller.dispose();
  });

  it('多条呼入按条拒绝，其他来电保留截止和操作', async () => {
    const context = setup();
    await context.rtm.handleMessage(message(ALPHA, 'CALL_KIT_INVITE'));
    const firstEnd = context.controller.getInvitation(ALPHA)!.getSnapshot().endTs;
    vi.advanceTimersByTime(1_000);
    await context.rtm.handleMessage(message(BETA, 'CALL_KIT_INVITE', 'call-other003'));
    expect(context.controller.getSnapshot().incomingInvitations.map(({ callId }) => callId)).toEqual([BETA, ALPHA]);
    await context.controller.refuse(BETA);
    expect(context.controller.getInvitation(BETA)!.getSnapshot()).toMatchObject({ state: 14, ended: true });
    expect(context.controller.getSnapshot().incomingInvitations.map(({ callId }) => callId)).toEqual([ALPHA]);
    expect(context.controller.getInvitation(ALPHA)!.getSnapshot().endTs).toBe(firstEnd);
    expect(context.sdks).toHaveLength(0);
    await context.controller.dispose();
  });

  it('音频挂断只退出 RTC，邀请保持接受终态且不发送 END 或 BUSY', async () => {
    const context = setup();
    await context.controller.startCall(PEER);
    expect(JSON.parse(context.publish.mock.calls[0]![2])).toEqual({ callId: ALPHA, extra: '{"nickname":"Alice"}' });
    await connect(context);
    await context.controller.end();
    expect(context.controller.getSnapshot().call).toMatchObject({ status: 'IDLE', result: { reason: 'ENDED' } });
    expect(context.controller.getInvitation(ALPHA)!.getSnapshot()).toMatchObject({ state: 3, ended: true });
    expect(context.publish.mock.calls.map(([, type]) => type)).toEqual(['CALL_KIT_INVITE', 'CALL_KIT_ACCEPT']);
    await context.controller.dispose();
  });

  it('媒体有限等待在恢复时按绝对截止结束，不改写邀请', async () => {
    const context = setup();
    await context.controller.startCall(PEER);
    await context.rtm.handleMessage(message(ALPHA, 'CALL_KIT_ACCEPT', PEER, '', 'accepted'));
    await flush();
    vi.setSystemTime(Date.now() + 31_000);
    context.controller.checkDeadlines();
    expect(context.controller.getSnapshot().call).toMatchObject({ status: 'IDLE', result: { reason: 'MEDIA_TIMEOUT' } });
    expect(context.controller.getInvitation(ALPHA)!.getSnapshot().state).toBe(3);
    await context.controller.dispose();
  });

  it('已连接后对端 RTC 离开结束 App 通话', async () => {
    const context = setup();
    await context.controller.startCall(PEER);
    await connect(context);
    context.sdks[0]!.emit('user-left');
    expect(context.controller.getSnapshot().call).toMatchObject({ status: 'IDLE', result: { reason: 'ENDED' } });
    expect(context.controller.getInvitation(ALPHA)!.getSnapshot().state).toBe(3);
    await context.controller.dispose();
  });

  it('音频占用时保留其他呼入，禁止并发接听但允许逐条拒绝', async () => {
    const context = setup();
    await context.controller.startCall(PEER);
    await connect(context);
    await context.rtm.handleMessage(message(BETA, 'CALL_KIT_INVITE', 'call-other003'));
    await context.controller.accept(BETA);
    expect(context.controller.getInvitation(BETA)!.getSnapshot().state).toBe(11);
    expect(context.sdks).toHaveLength(1);
    expect(context.controller.getSnapshot().canAcceptIncoming).toBe(false);
    await context.controller.refuse(BETA);
    expect(context.controller.getSnapshot().call.status).toBe('ACTIVE');
    expect(context.publish.mock.calls.map(([, type]) => type)).not.toContain('CALL_KIT_BUSY');
    await context.controller.dispose();
  });

  it('同时互拨在 App 取消较大的本端邀请并保留较小来电', async () => {
    const context = setup();
    await context.controller.startCall(PEER);
    const incomingId = '00000000000000000000000000000000';
    await context.rtm.handleMessage(message(incomingId, 'CALL_KIT_INVITE'));
    expect(context.controller.getInvitation(ALPHA)!.getSnapshot()).toMatchObject({ state: 5, ended: true });
    expect(context.controller.getSnapshot().incomingInvitations.map(({ callId }) => callId)).toEqual([incomingId]);
    expect(context.publish.mock.calls.map(([, type]) => type)).toEqual(['CALL_KIT_INVITE', 'CALL_KIT_CANCEL']);
    await context.controller.dispose();
  });

  it('互拨保留较小外呼时，较大来电拒绝通知失败不影响当前外呼', async () => {
    const context = setup();
    await context.controller.startCall(PEER);
    context.publish.mockRejectedValueOnce(new Error('refusal failed'));
    await context.rtm.handleMessage(message(BETA, 'CALL_KIT_INVITE'));
    await flush();
    expect(context.controller.getSnapshot().call).toMatchObject({ status: 'OUTGOING_RINGING', call: { callId: ALPHA } });
    expect(context.controller.getInvitation(BETA)!.getSnapshot()).toMatchObject({ state: 14, ended: true });
    expect(context.controller.getSnapshot().notice).toBeUndefined();
    await context.controller.dispose();
  });

  it('旧 leave 挂起时新通话可建立媒体，迟到旧事件只关闭旧轨道', async () => {
    const context = setup();
    await context.controller.startCall(PEER);
    await connect(context);
    const leaving = deferred();
    context.sdks[0]!.client.leave.mockImplementationOnce(() => leaving.promise);
    await context.controller.end();
    await context.controller.startCall(PEER);
    await connect(context, BETA, 1);
    context.sdks[0]!.emit('user-left');
    leaving.resolve();
    await flush();
    expect(context.sdks[0]!.microphone.close).toHaveBeenCalledOnce();
    expect(context.sdks[1]!.microphone.close).not.toHaveBeenCalled();
    expect(context.controller.getSnapshot().call).toMatchObject({ status: 'ACTIVE', call: { callId: BETA } });
    await context.controller.dispose();
  });

  it('旧 join 迟到返回不得采集或覆盖新通话', async () => {
    const context = setup();
    const joining = deferred();
    await context.controller.startCall(PEER);
    // Creation happens only after acceptance; configure the SDK synchronously at its first snapshot.
    context.controller.subscribe(() => {
      const sdk = context.sdks[0];
      if (sdk && sdk.client.join.mock.calls.length === 0) {
        sdk.client.join.mockImplementationOnce(async () => { await joining.promise; return LOCAL; });
      }
    });
    await context.rtm.handleMessage(message(ALPHA, 'CALL_KIT_ACCEPT', PEER, '', 'accepted'));
    await flush();
    await context.controller.end();
    await context.controller.startCall(PEER);
    await connect(context, BETA, 1);
    joining.resolve();
    await flush();
    expect(context.sdks[0]!.deps.createMicrophoneAudioTrack).not.toHaveBeenCalled();
    expect(context.sdks[1]!.microphone.close).not.toHaveBeenCalled();
    expect(context.controller.getSnapshot().call.status).toBe('ACTIVE');
    await context.controller.dispose();
  });

  it('旧麦克风采集在结束后返回时关闭旧轨道，不向旧频道发布', async () => {
    const context = setup();
    const capture = deferred();
    context.controller.subscribe(() => {
      const sdk = context.sdks[0];
      if (sdk && sdk.client.join.mock.calls.length === 0) {
        sdk.deps.createMicrophoneAudioTrack.mockImplementationOnce(async () => {
          await capture.promise;
          return sdk.microphone as never;
        });
      }
    });
    await context.controller.startCall(PEER);
    await context.rtm.handleMessage(message(ALPHA, 'CALL_KIT_ACCEPT', PEER, '', 'accepted'));
    await flush();
    expect(context.sdks[0]!.deps.createMicrophoneAudioTrack).toHaveBeenCalledOnce();
    await context.controller.end();
    await context.controller.startCall(PEER);
    await connect(context, BETA, 1);
    capture.resolve();
    await flush();
    expect(context.sdks[0]!.microphone.close).toHaveBeenCalledOnce();
    expect(context.sdks[0]!.client.publish).not.toHaveBeenCalled();
    expect(context.sdks[1]!.microphone.close).not.toHaveBeenCalled();
    expect(context.controller.getSnapshot().call).toMatchObject({ status: 'ACTIVE', call: { callId: BETA } });
    await context.controller.dispose();
  });

  it('RTC 加入失败结束 App 媒体，主叫仍保留接受结果', async () => {
    const context = setup();
    context.controller.subscribe(() => {
      const sdk = context.sdks[0];
      if (sdk && sdk.client.join.mock.calls.length === 0) sdk.client.join.mockRejectedValueOnce(new Error('NETWORK_ERROR'));
    });
    await context.controller.startCall(PEER);
    await context.rtm.handleMessage(message(ALPHA, 'CALL_KIT_ACCEPT', PEER, '', 'accepted'));
    await flush();
    expect(context.controller.getSnapshot().call).toMatchObject({ status: 'IDLE', result: { reason: 'MEDIA_FAILED' } });
    expect(context.controller.getInvitation(ALPHA)!.getSnapshot().state).toBe(3);
    expect(context.publish.mock.calls.map(([, type]) => type)).toEqual(['CALL_KIT_INVITE', 'CALL_KIT_ACCEPT']);
    await context.controller.dispose();
  });

  it('接听发布失败释放 App 占用，原邀请可在原截止内重试', async () => {
    const context = setup();
    await context.rtm.handleMessage(message(ALPHA, 'CALL_KIT_INVITE'));
    const originalEnd = context.controller.getInvitation(ALPHA)!.getSnapshot().endTs;
    context.publish.mockRejectedValueOnce(new Error('publish failed'));
    await context.controller.accept(ALPHA);
    expect(context.controller.getSnapshot().canAcceptIncoming).toBe(true);
    expect(context.controller.getInvitation(ALPHA)!.getSnapshot()).toMatchObject({ state: 11, endTs: originalEnd });
    await context.controller.accept(ALPHA);
    expect(context.controller.getSnapshot().call.status).toBe('ACCEPT_WAITING_ACK');
    expect(context.sdks).toHaveLength(0);
    await context.controller.dispose();
  });

  it('connecting 通知中同步挂断后，不再启动旧 SDK join', async () => {
    const context = setup();
    await context.controller.startCall(PEER);
    context.controller.subscribe(() => {
      if (context.controller.getSnapshot().audio.status === 'connecting') void context.controller.end();
    });
    await context.rtm.handleMessage(message(ALPHA, 'CALL_KIT_ACCEPT', PEER, '', 'accepted'));
    await flush();
    expect(context.sdks[0]!.client.join).not.toHaveBeenCalled();
    expect(context.sdks[0]!.deps.createMicrophoneAudioTrack).not.toHaveBeenCalled();
    expect(context.controller.getInvitation(ALPHA)!.getSnapshot()).toMatchObject({ state: 3, ended: true });
    await context.controller.dispose();
  });

  it('旧清理失败不阻塞新通话，页面释放时再尽力清理旧资源', async () => {
    const context = setup();
    await context.controller.startCall(PEER);
    await connect(context);
    context.sdks[0]!.client.leave.mockRejectedValueOnce(new Error('NETWORK_ERROR'));
    await context.controller.end();
    await flush();
    await context.controller.startCall(PEER);
    await connect(context, BETA, 1);
    expect(context.sdks[1]!.microphone.close).not.toHaveBeenCalled();
    await context.controller.dispose();
    expect(context.sdks[0]!.client.leave).toHaveBeenCalledTimes(2);
    expect(context.sdks[0]!.microphone.close).toHaveBeenCalledOnce();
  });

  it('旧取消通知迟到失败不覆盖新通话提示', async () => {
    const context = setup();
    await context.controller.startCall(PEER);
    const oldCancel = deferred();
    context.publish.mockImplementationOnce(() => oldCancel.promise);
    const canceled = context.controller.cancel();
    await context.controller.startCall(PEER);
    await connect(context, BETA, 0);
    oldCancel.reject(new Error('old notification failed'));
    await canceled;
    expect(context.controller.getSnapshot().notice).toBeUndefined();
    expect(context.controller.getSnapshot().call).toMatchObject({ status: 'ACTIVE', call: { callId: BETA } });
    await context.controller.dispose();
  });

  it('离开页面时尽力取消未接受外呼，且不创建媒体', async () => {
    const context = setup();
    await context.controller.startCall(PEER);
    const invitation = context.controller.getInvitation(ALPHA)!;
    await context.controller.dispose();
    expect(invitation.getSnapshot()).toMatchObject({ state: 5, ended: true });
    expect(context.publish.mock.calls.map(([, type]) => type)).toEqual(['CALL_KIT_INVITE', 'CALL_KIT_CANCEL']);
    expect(context.sdks).toHaveLength(0);
  });
});
