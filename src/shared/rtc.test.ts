import { describe, expect, it, vi } from 'vitest';

import { createRtcHelper, type RtcHandlers } from './rtc';
import { RtcSdkError, RtcUsageError, type RtcError } from './rtcErrors';

/** 假 SDK：只实现被断言到的部分，不连真实网络。 */
function fakeSdk() {
  const listeners = new Map<string, (...args: never[]) => void>();
  const remoteAudioTrack = { play: vi.fn(), stop: vi.fn() };
  const remoteVideoTrack = { play: vi.fn(), stop: vi.fn() };
  const microphoneMediaTrack = { readyState: 'live' as MediaStreamTrackState, muted: false };
  const microphone = {
    setMuted: vi.fn(async () => undefined),
    close: vi.fn(),
    getMediaStreamTrack: vi.fn(() => microphoneMediaTrack),
  };
  const camera = { setMuted: vi.fn(async () => undefined), close: vi.fn(), play: vi.fn() };

  const client = {
    on: (name: string, listener: (...args: never[]) => void) => listeners.set(name, listener),
    join: vi.fn(async () => 'host-1'),
    leave: vi.fn(async (): Promise<void> => undefined),
    publish: vi.fn(async (): Promise<void> => undefined),
    unpublish: vi.fn(async () => undefined),
    subscribe: vi.fn(async (_user: unknown, mediaType: string) =>
      mediaType === 'audio' ? remoteAudioTrack : remoteVideoTrack,
    ),
    enableAudioVolumeIndicator: vi.fn(),
  };

  const createClient = vi.fn(() => client as never);

  return {
    listeners,
    client,
    createClient,
    microphone,
    microphoneMediaTrack,
    camera,
    remoteAudioTrack,
    remoteVideoTrack,
    deps: {
      createClient,
      createMicrophoneAudioTrack: vi.fn(async () => microphone as never),
      createCameraVideoTrack: vi.fn(async () => camera as never),
    },
  };
}

function noopHandlers(): RtcHandlers {
  return {
    connection: vi.fn(),
    remoteUserJoined: vi.fn(),
    remoteUserLeft: vi.fn(),
    remoteAudioPublished: vi.fn(),
    remoteAudioUnpublished: vi.fn(),
    remoteVideoTrack: vi.fn(),
    remoteVideoUnpublished: vi.fn(),
    volume: vi.fn(),
  };
}

const SETTINGS = { appId: 'app-id', roomId: 'room-1', userId: 'host-1' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('创建时机', () => {
  it('只有实际开音视频的用户才创建 RTC 实例 —— 纯听众不建', () => {
    const sdk = fakeSdk();

    createRtcHelper(sdk.deps);

    // 构造函数不碰 SDK：不 join 就没有客户端
    expect(sdk.createClient).not.toHaveBeenCalled();
  });

  it('join 之后才创建客户端', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);

    await rtc.join(SETTINGS);

    expect(sdk.createClient).toHaveBeenCalledTimes(1);
  });
});

describe('加入与离开', () => {
  it('入会前获取绑定实际频道和字符串 UID 的 RTC Token', async () => {
    const sdk = fakeSdk();
    const getToken = vi.fn(async () => 'rtc-token');
    const rtc = createRtcHelper(sdk.deps, getToken);
    await rtc.join(SETTINGS);
    expect(getToken).toHaveBeenCalledWith({ service: 'rtc', appId: 'app-id', userId: 'host-1', channelName: 'room-1' });
    expect(sdk.client.join).toHaveBeenCalledWith('app-id', 'room-1', 'rtc-token', 'host-1');
  });

  it('无鉴权模式保持原有 null Token 入会', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);

    await rtc.join(SETTINGS);

    expect(sdk.client.join).toHaveBeenCalledWith('app-id', 'room-1', null, 'host-1');
    expect(Object.keys(SETTINGS)).not.toContain('token');
  });

  it('leave 关掉本地轨道并且可重复调用', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);
    await rtc.publishMicrophone();
    await rtc.publishCamera();

    await rtc.leave();
    await rtc.leave();

    expect(sdk.client.leave).toHaveBeenCalledTimes(1);
    expect(sdk.microphone.close).toHaveBeenCalledTimes(1);
    expect(sdk.camera.close).toHaveBeenCalledTimes(1);
  });

  it('未 join 就发布抛归一化的用法错误 —— 业务层要能区分「用法错误」与「SDK 错误」', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);

    // 光断言 toThrow() 抓不住这点：裸 Error 也会通过。
    await expect(rtc.publishMicrophone()).rejects.toBeInstanceOf(RtcUsageError);
    await expect(rtc.publishCamera()).rejects.toBeInstanceOf(RtcUsageError);
    await expect(rtc.publishMicrophone()).rejects.toSatisfy(
      (error: RtcError) => error.kind === 'usage',
    );
  });

  it('SDK 失败抛归一化的 SDK 错误，原始错误挂在 cause 上', async () => {
    const sdk = fakeSdk();
    sdk.client.join = vi.fn(async () => {
      throw new Error('NETWORK_ERROR');
    }) as never;
    const rtc = createRtcHelper(sdk.deps);

    const failure = await rtc.join(SETTINGS).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RtcSdkError);
    expect((failure as RtcError).kind).toBe('sdk');
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  it('未发布就静音抛用法错误，不是裸错误', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);

    await expect(rtc.setMicrophoneMuted(true)).rejects.toBeInstanceOf(RtcUsageError);
    await expect(rtc.setCameraMuted(true)).rejects.toBeInstanceOf(RtcUsageError);
  });

  it('离开频道前先发停播通知 —— 顺序反了 UI 会播已销毁的 track', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    const handlers = noopHandlers();
    rtc.registerEvents(handlers);
    await rtc.join(SETTINGS);

    // 让两个远端各发布音频与视频，建立起 UI 侧的播放状态
    sdk.listeners.get('user-published')?.({ uid: 'audience-1' } as never, 'audio' as never);
    sdk.listeners.get('user-published')?.({ uid: 'audience-2' } as never, 'video' as never);
    await vi.waitFor(() => expect(handlers.remoteVideoTrack).toHaveBeenCalled());

    const order: string[] = [];
    (handlers.remoteAudioUnpublished as ReturnType<typeof vi.fn>).mockImplementation(() =>
      order.push('stop-audio'),
    );
    (handlers.remoteVideoUnpublished as ReturnType<typeof vi.fn>).mockImplementation(() =>
      order.push('stop-video'),
    );
    sdk.client.leave = vi.fn(async () => {
      order.push('leave');
    }) as never;

    await rtc.leave();

    // 停播通知必须都排在 leave 之前
    expect(order.indexOf('leave')).toBe(order.length - 1);
    expect(order).toContain('stop-audio');
    expect(order).toContain('stop-video');
  });
});

describe('麦克风', () => {
  it('本地 AudioTrack 为 live 时，即使 publish 失败也判定采集硬件正常', async () => {
    const sdk = fakeSdk();
    sdk.client.publish.mockRejectedValueOnce(new Error('NETWORK_PUBLISH_FAILED'));
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);

    await expect(rtc.publishMicrophone()).rejects.toBeInstanceOf(RtcSdkError);

    expect(rtc.isMicrophoneCaptureHealthy()).toBe(true);
  });

  it('创建本地 AudioTrack 失败时判定采集硬件异常', async () => {
    const sdk = fakeSdk();
    sdk.deps.createMicrophoneAudioTrack.mockRejectedValueOnce(new Error('NOT_READABLE'));
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);

    await expect(rtc.publishMicrophone()).rejects.toBeInstanceOf(RtcSdkError);

    expect(rtc.isMicrophoneCaptureHealthy()).toBe(false);
  });

  it('发布、静音、取消发布', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);

    await rtc.publishMicrophone();
    await rtc.setMicrophoneMuted(true);
    await rtc.unpublishMicrophone();

    expect(sdk.client.publish).toHaveBeenCalledWith(sdk.microphone);
    expect(sdk.microphone.setMuted).toHaveBeenCalledWith(true);
    expect(sdk.client.unpublish).toHaveBeenCalledWith(sdk.microphone);
  });

  it('重复发布只发一次', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);

    await rtc.publishMicrophone();
    await rtc.publishMicrophone();

    expect(sdk.client.publish).toHaveBeenCalledTimes(1);
  });
});

describe('摄像头', () => {
  it('发布、静音、取消发布', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);

    await rtc.publishCamera();
    await rtc.setCameraMuted(true);
    await rtc.unpublishCamera();

    expect(sdk.client.publish).toHaveBeenCalledWith(sdk.camera);
    expect(sdk.camera.setMuted).toHaveBeenCalledWith(true);
    expect(sdk.client.unpublish).toHaveBeenCalledWith(sdk.camera);
  });

  it('本地视频轨道交给 UI 自己播 —— 模块内部不 play', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);

    await rtc.publishCamera();

    // 交出轨道，但不代替 UI 播放：视频有挂载点问题，只有 UI 知道播到哪个 div
    expect(rtc.getLocalVideoTrack()).toBe(sdk.camera);
    expect(sdk.camera.play).not.toHaveBeenCalled();
  });

  it('未发布摄像头时取本地视频轨道返回空值', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);

    expect(rtc.getLocalVideoTrack()).toBeUndefined();
  });
});

describe('远端订阅', () => {
  it('未提供远端加入和离开回调时不报错，音频仍正常订阅播放', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    const handlers: Omit<RtcHandlers, 'remoteUserJoined' | 'remoteUserLeft'> = {
      connection: vi.fn(),
      remoteAudioPublished: vi.fn(),
      remoteAudioUnpublished: vi.fn(),
      remoteVideoTrack: vi.fn(),
      remoteVideoUnpublished: vi.fn(),
      volume: vi.fn(),
    };
    rtc.registerEvents(handlers);
    await rtc.join(SETTINGS);

    expect(() => sdk.listeners.get('user-joined')?.({ uid: 'audience-1' } as never)).not.toThrow();
    expect(() => sdk.listeners.get('user-left')?.({ uid: 'audience-1' } as never)).not.toThrow();
    sdk.listeners.get('user-published')?.({ uid: 'audience-2' } as never, 'audio' as never);
    await vi.waitFor(() => expect(sdk.remoteAudioTrack.play).toHaveBeenCalledOnce());
    expect(handlers.remoteAudioPublished).toHaveBeenCalledWith('audience-2');
  });

  it('远端加入和离开独立于是否发布麦克风', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    const handlers = noopHandlers();
    rtc.registerEvents(handlers);
    await rtc.join(SETTINGS);

    sdk.listeners.get('user-joined')?.({ uid: 'audience-1' } as never);
    sdk.listeners.get('user-left')?.({ uid: 'audience-1' } as never);

    expect(handlers.remoteUserJoined).toHaveBeenCalledWith('audience-1');
    expect(handlers.remoteUserLeft).toHaveBeenCalledWith('audience-1');
    expect(handlers.remoteAudioPublished).not.toHaveBeenCalled();
  });

  it('远端音频由模块内部直接 play —— 音频没有挂载点问题', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    const handlers = noopHandlers();
    rtc.registerEvents(handlers);
    await rtc.join(SETTINGS);

    sdk.listeners.get('user-published')?.({ uid: 'audience-1' } as never, 'audio' as never);
    await vi.waitFor(() => expect(sdk.remoteAudioTrack.play).toHaveBeenCalledOnce());

    expect(sdk.client.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'audience-1' }),
      'audio',
    );
    expect(handlers.remoteAudioPublished).toHaveBeenCalledWith('audience-1');
  });

  it('远端视频轨道交给 UI，模块内部不 play', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    const handlers = noopHandlers();
    rtc.registerEvents(handlers);
    await rtc.join(SETTINGS);

    sdk.listeners.get('user-published')?.({ uid: 'audience-1' } as never, 'video' as never);
    await vi.waitFor(() =>
      expect(handlers.remoteVideoTrack).toHaveBeenCalledWith('audience-1', sdk.remoteVideoTrack),
    );

    expect(sdk.remoteVideoTrack.play).not.toHaveBeenCalled();
  });

  it('远端取消发布分音频与视频两个回调', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    const handlers = noopHandlers();
    rtc.registerEvents(handlers);
    await rtc.join(SETTINGS);

    sdk.listeners.get('user-unpublished')?.({ uid: 'audience-1' } as never, 'audio' as never);
    sdk.listeners.get('user-unpublished')?.({ uid: 'audience-1' } as never, 'video' as never);

    expect(handlers.remoteAudioUnpublished).toHaveBeenCalledWith('audience-1');
    expect(handlers.remoteVideoUnpublished).toHaveBeenCalledWith('audience-1');
  });

  it('音量回调把 SDK 的数组归一成 uid 到音量的映射', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    const handlers = noopHandlers();
    rtc.registerEvents(handlers);
    await rtc.join(SETTINGS);

    sdk.listeners.get('volume-indicator')?.([
      { uid: 'host-1', level: 60 },
      { uid: 'audience-1', level: 12 },
    ] as never);

    expect(handlers.volume).toHaveBeenCalledWith({ 'host-1': 60, 'audience-1': 12 });
  });

  it('连接状态变化转成与 RTM 同一套状态词', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    const handlers = noopHandlers();
    rtc.registerEvents(handlers);
    await rtc.join(SETTINGS);

    sdk.listeners.get('connection-state-change')?.(
      'RECONNECTING' as never,
      'CONNECTED' as never,
      undefined as never,
    );

    expect(handlers.connection).toHaveBeenCalledWith('reconnecting', undefined);
  });
});

describe('不采集 trace', () => {
  it('模块不导出任何 trace 接口 —— 时间线只呈现 RTM', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);
    await rtc.publishMicrophone();

    // 混入 RTC 节点会稀释「RTM 数据流」这条主线（见 spec「归并与筛选」）
    for (const key of Object.keys(rtc)) {
      expect(key.toLowerCase()).not.toContain('trace');
    }
  });
});

describe('异步操作与退出交错', () => {
  it('join 失败时清理原实例，清理也失败仍保留原始 join 错误', async () => {
    const sdk = fakeSdk();
    const joinError = new Error('NETWORK_JOIN_FAILED');
    sdk.client.join.mockRejectedValueOnce(joinError);
    sdk.client.leave.mockRejectedValueOnce(new Error('NETWORK_CLEANUP_FAILED'));
    const rtc = createRtcHelper(sdk.deps);

    const failure = await rtc.join(SETTINGS).catch((error: unknown) => error);

    expect(sdk.client.leave).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(RtcSdkError);
    expect((failure as RtcSdkError).cause).toBe(joinError);
    await expect(rtc.publishMicrophone()).rejects.toBeInstanceOf(RtcUsageError);
  });

  it('旧 join 失败后的清理等待期间，新实例仍可发布且不会被清除', async () => {
    const oldSdk = fakeSdk();
    const newSdk = fakeSdk();
    const pendingJoin = deferred<string>();
    const pendingCleanup = deferred<void>();
    const joinError = new Error('NETWORK_JOIN_FAILED');
    oldSdk.client.join.mockReturnValueOnce(pendingJoin.promise);
    oldSdk.client.leave.mockReturnValueOnce(pendingCleanup.promise);
    oldSdk.createClient.mockReturnValueOnce(oldSdk.client as never).mockReturnValueOnce(newSdk.client as never);
    const rtc = createRtcHelper(oldSdk.deps);
    const oldJoining = rtc.join(SETTINGS).catch((error: unknown) => error);
    await rtc.leave();
    await rtc.join({ ...SETTINGS, roomId: 'room-2' });

    pendingJoin.reject(joinError);
    await vi.waitFor(() => expect(oldSdk.client.leave).toHaveBeenCalledOnce());
    await rtc.publishMicrophone();
    pendingCleanup.resolve();

    expect((await oldJoining as RtcSdkError).cause).toBe(joinError);
    expect(newSdk.client.publish).toHaveBeenCalledOnce();
    expect(newSdk.client.leave).not.toHaveBeenCalled();
    await rtc.leave();
  });

  it('join 等待期间退出，晚到成功关闭原实例并取消入房', async () => {
    const sdk = fakeSdk();
    const pending = deferred<string>();
    sdk.client.join.mockReturnValueOnce(pending.promise);
    const rtc = createRtcHelper(sdk.deps);
    const joining = rtc.join(SETTINGS).catch((error: unknown) => error);

    await rtc.leave();
    pending.resolve('host-1');

    expect(await joining).toBeInstanceOf(RtcUsageError);
    expect(sdk.client.leave).toHaveBeenCalledOnce();
    expect(sdk.client.enableAudioVolumeIndicator).not.toHaveBeenCalled();
    await expect(rtc.publishMicrophone()).rejects.toBeInstanceOf(RtcUsageError);
  });

  it.each(['成功', '失败'])('重新 join 后，旧 join 晚到%s不清理新实例', async (outcome) => {
    const oldSdk = fakeSdk();
    const newSdk = fakeSdk();
    const pending = deferred<string>();
    oldSdk.client.join.mockReturnValueOnce(pending.promise);
    oldSdk.createClient.mockReturnValueOnce(oldSdk.client as never).mockReturnValueOnce(newSdk.client as never);
    const rtc = createRtcHelper(oldSdk.deps);
    const oldJoining = rtc.join(SETTINGS).catch((error: unknown) => error);
    await rtc.leave();
    await rtc.join({ ...SETTINGS, roomId: 'room-2' });

    if (outcome === '成功') pending.resolve('host-1');
    else pending.reject(new Error('NETWORK_ERROR'));
    expect(await oldJoining).toBeInstanceOf(outcome === '成功' ? RtcUsageError : RtcSdkError);
    await rtc.publishMicrophone();

    expect(newSdk.client.publish).toHaveBeenCalledOnce();
    expect(newSdk.client.leave).not.toHaveBeenCalled();
    expect(oldSdk.client.enableAudioVolumeIndicator).not.toHaveBeenCalled();
    await rtc.leave();
  });

  it('等待上一实例清理时再次退出，不允许待启动的 join 复活', async () => {
    const sdk = fakeSdk();
    const pending = deferred<void>();
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);
    sdk.client.leave.mockReturnValueOnce(pending.promise);
    const joining = rtc.join({ ...SETTINGS, roomId: 'room-2' }).catch((error: unknown) => error);

    await rtc.leave();
    pending.resolve();

    expect(await joining).toBeInstanceOf(RtcUsageError);
    expect(sdk.createClient).toHaveBeenCalledOnce();
  });

  it('重新入房后忽略旧实例的连接、媒体和音量事件', async () => {
    const oldSdk = fakeSdk();
    const newSdk = fakeSdk();
    oldSdk.createClient.mockReturnValueOnce(oldSdk.client as never).mockReturnValueOnce(newSdk.client as never);
    const rtc = createRtcHelper(oldSdk.deps);
    const handlers = noopHandlers();
    rtc.registerEvents(handlers);
    await rtc.join(SETTINGS);
    await rtc.leave();
    await rtc.join({ ...SETTINGS, roomId: 'room-2' });

    oldSdk.listeners.get('connection-state-change')?.('DISCONNECTED' as never, 'CONNECTED' as never, 'NETWORK_ERROR' as never);
    oldSdk.listeners.get('user-published')?.({ uid: 'audience-1' } as never, 'audio' as never);
    oldSdk.listeners.get('user-unpublished')?.({ uid: 'audience-1' } as never, 'video' as never);
    oldSdk.listeners.get('volume-indicator')?.([{ uid: 'audience-1', level: 80 }] as never);

    expect(handlers.connection).not.toHaveBeenCalled();
    expect(oldSdk.client.subscribe).not.toHaveBeenCalled();
    expect(handlers.remoteVideoUnpublished).not.toHaveBeenCalled();
    expect(handlers.volume).not.toHaveBeenCalled();
    await rtc.leave();
  });

  it.each(['audio', 'video'] as const)('退出后旧 %s subscribe 完成不再播放或交给 UI', async (mediaType) => {
    const sdk = fakeSdk();
    const pending = deferred<typeof sdk.remoteAudioTrack>();
    sdk.client.subscribe.mockReturnValueOnce(pending.promise);
    const rtc = createRtcHelper(sdk.deps);
    const handlers = noopHandlers();
    rtc.registerEvents(handlers);
    await rtc.join(SETTINGS);
    sdk.listeners.get('user-published')?.({ uid: 'audience-1' } as never, mediaType as never);

    await rtc.leave();
    pending.resolve(sdk.remoteAudioTrack);
    await Promise.resolve();

    expect(sdk.remoteAudioTrack.play).not.toHaveBeenCalled();
    expect(handlers.remoteAudioPublished).not.toHaveBeenCalled();
    expect(handlers.remoteVideoTrack).not.toHaveBeenCalled();
  });

  it('退出后旧 subscribe 失败不污染当前连接状态', async () => {
    const sdk = fakeSdk();
    const pending = deferred<typeof sdk.remoteAudioTrack>();
    sdk.client.subscribe.mockReturnValueOnce(pending.promise);
    const rtc = createRtcHelper(sdk.deps);
    const handlers = noopHandlers();
    rtc.registerEvents(handlers);
    await rtc.join(SETTINGS);
    sdk.listeners.get('user-published')?.({ uid: 'audience-1' } as never, 'audio' as never);

    await rtc.leave();
    pending.reject(new Error('NETWORK_ERROR'));
    await Promise.resolve();

    expect(handlers.connection).not.toHaveBeenCalled();
  });

  it.each(['麦克风', '摄像头'])('%s轨道创建期间退出，晚到轨道立即关闭且不发布', async (kind) => {
    const sdk = fakeSdk();
    const pending = deferred<never>();
    const rtc = createRtcHelper(sdk.deps);
    const track = kind === '麦克风' ? sdk.microphone : sdk.camera;
    const create = kind === '麦克风' ? sdk.deps.createMicrophoneAudioTrack : sdk.deps.createCameraVideoTrack;
    create.mockReturnValueOnce(pending.promise);
    await rtc.join(SETTINGS);
    const publishing = (kind === '麦克风' ? rtc.publishMicrophone() : rtc.publishCamera()).catch((error: unknown) => error);

    await rtc.leave();
    pending.resolve(track as never);

    expect(await publishing).toBeInstanceOf(RtcUsageError);
    expect(track.close).toHaveBeenCalledOnce();
    expect(sdk.client.publish).not.toHaveBeenCalled();
    expect(rtc.isMicrophoneCaptureHealthy()).toBe(false);
    expect(rtc.getLocalVideoTrack()).toBeUndefined();
  });

  it.each(['麦克风', '摄像头'])('%s publish 期间退出，晚到成功撤销原轨道且不恢复本地状态', async (kind) => {
    const sdk = fakeSdk();
    const pending = deferred<void>();
    sdk.client.publish.mockReturnValueOnce(pending.promise);
    const rtc = createRtcHelper(sdk.deps);
    const track = kind === '麦克风' ? sdk.microphone : sdk.camera;
    await rtc.join(SETTINGS);
    const publishing = (kind === '麦克风' ? rtc.publishMicrophone() : rtc.publishCamera()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(sdk.client.publish).toHaveBeenCalledOnce());
    await rtc.leave();
    sdk.client.unpublish.mockClear();

    pending.resolve();

    expect(await publishing).toBeInstanceOf(RtcUsageError);
    expect(sdk.client.unpublish).toHaveBeenCalledWith(track);
    expect(track.close).toHaveBeenCalledOnce();
    expect(rtc.isMicrophoneCaptureHealthy()).toBe(false);
    expect(rtc.getLocalVideoTrack()).toBeUndefined();
  });

  it('退出时 unpublish 失败仍离开 SDK 频道并关闭本地轨道', async () => {
    const sdk = fakeSdk();
    const rtc = createRtcHelper(sdk.deps);
    await rtc.join(SETTINGS);
    await rtc.publishMicrophone();
    sdk.client.unpublish.mockRejectedValueOnce(new Error('NETWORK_ERROR'));

    await expect(rtc.leave()).rejects.toBeInstanceOf(RtcSdkError);

    expect(sdk.client.leave).toHaveBeenCalledOnce();
    expect(sdk.microphone.close).toHaveBeenCalledOnce();
  });
});
