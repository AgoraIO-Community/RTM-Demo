/**
 * 共享 RTC 辅助模块。
 *
 * ## 为什么这个文件可以被各场景 import（零依赖铁律的唯一例外）
 *
 * Role RTM modules stay independent from business state, while `rtc.ts` is shared by all scenes.
 *
 * 1. **它不是本 demo 要展示的东西。** 实验室要演示的是 RTM 能力，RTC 只是让语音能真的
 *    听见的配角。客户拷走角色 `rtm.ts` / `onRtmEvent.ts` 是为了照抄 RTM 调用顺序；RTC 那部分他们项目里
 *    早已有了，不需要跟着拷。
 * 2. **它没有场景差异。** 加入频道、开关麦、开关摄像头、订阅远端 —— 23 个场景要的都是
 *    这四件事，逐场景复制一份只会产生 23 份一模一样的代码。
 * 3. **它不采集 trace。** 时间线只呈现 RTM（见下），所以它不参与「客户拷走后要能看懂
 *    调用顺序」这个目标，也就没有零依赖的必要性。
 *
 * **不要把这条例外推广成「可以再抽一个共享层」。** 判据是上面三条同时成立；
 * 任何承载 RTM 调用顺序的代码都不满足第 1 条和第 3 条。
 *
 * ## 两条容易被「顺手优化」掉的设计
 *
 * **视频轨道交给 UI 自己 play，音频由模块内部 play。** 这不是不一致，是挂载点的差异：
 * 视频必须播到某个具体 DOM 节点里，只有 UI 知道是哪个；音频没有这个问题，交出去只会
 * 让每个场景重复写一遍 `track.play()`。
 *
 * **不采集 trace。** 时间线只呈现 RTM —— 混入 RTC 节点会稀释「RTM 数据流」这条主线。
 * RTC 的成败会体现为后续那次 RTM 调用的出现或缺席（麦位激活由媒体结果驱动），
 * 所以时间线上仍然看得懂因果。
 */

import AgoraRTC, {
  type ConnectionState as AgoraConnectionState,
  type IAgoraRTCClient,
  type IAgoraRTCRemoteUser,
  type ICameraVideoTrack,
  type IMicrophoneAudioTrack,
  type IRemoteVideoTrack,
} from 'agora-rtc-sdk-ng';

import { RtcUsageError, toRtcSdkError } from './rtcErrors';
import type { TokenProvider } from './utils/token';


/** 与 RTM 侧共用同一套状态词，便于 UI 统一呈现。 */
export type RtcConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export interface RtcHandlers {
  connection: (state: RtcConnectionState, reason?: string) => void;
  remoteUserJoined?: (userId: string) => void;
  remoteUserLeft?: (userId: string) => void;
  remoteAudioPublished: (userId: string) => void;
  remoteAudioUnpublished: (userId: string) => void;
  /** 远端视频轨道交给 UI 自己 play，模块内部不 play。 */
  remoteVideoTrack: (userId: string, track: IRemoteVideoTrack) => void;
  remoteVideoUnpublished: (userId: string) => void;
  volume: (levels: Record<string, number>) => void;
}

/**
 * 加入频道所需的最小配置。
 *
 * Tokens are obtained through the injected provider before joining.
 */
export interface RtcJoinSettings {
  appId: string;
  roomId: string;
  userId: string;
}

/** 注入 SDK 工厂，测试用假实现驱动，不连真实网络。 */
export interface RtcDependencies {
  createClient: typeof AgoraRTC.createClient;
  createMicrophoneAudioTrack: typeof AgoraRTC.createMicrophoneAudioTrack;
  createCameraVideoTrack: typeof AgoraRTC.createCameraVideoTrack;
}

export interface RtcHelper {
  registerEvents(handlers: RtcHandlers): void;
  join(settings: RtcJoinSettings): Promise<void>;
  leave(): Promise<void>;
  publishMicrophone(): Promise<void>;
  unpublishMicrophone(): Promise<void>;
  setMicrophoneMuted(muted: boolean): Promise<void>;
  /** 本地麦克风轨道存在且底层 MediaStreamTrack 仍为 live。与是否发布成功无关。 */
  isMicrophoneCaptureHealthy(): boolean;
  publishCamera(): Promise<void>;
  unpublishCamera(): Promise<void>;
  setCameraMuted(muted: boolean): Promise<void>;
  /** 本地视频轨道，供 UI 自己播放。未发布摄像头时为 `undefined`。 */
  getLocalVideoTrack(): ICameraVideoTrack | undefined;
}

const CONNECTION_STATES: Record<AgoraConnectionState, RtcConnectionState> = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTING: 'disconnected',
  DISCONNECTED: 'disconnected',
};

function noopHandlers(): RtcHandlers {
  return {
    connection: () => undefined,
    remoteUserJoined: () => undefined,
    remoteUserLeft: () => undefined,
    remoteAudioPublished: () => undefined,
    remoteAudioUnpublished: () => undefined,
    remoteVideoTrack: () => undefined,
    remoteVideoUnpublished: () => undefined,
    volume: () => undefined,
  };
}

/**
 * 创建 RTC 辅助。
 *
 * **构造时不碰 SDK** —— 只有实际开音视频的用户才在 `join()` 时创建客户端实例，
 * 纯听众调用 `createRtcHelper` 也不会建（见票 08 的「只有一人开音视频」约束）。
 */
export function createRtcHelper(deps: RtcDependencies = AgoraRTC, getToken?: TokenProvider): RtcHelper {
  let client: IAgoraRTCClient | undefined;
  let microphone: IMicrophoneAudioTrack | undefined;
  let camera: ICameraVideoTrack | undefined;
  let handlers = noopHandlers();
  let joined = false;
  let micPublished = false;
  let cameraPublished = false;
  let generation = 0;
  const failedLeaves = new Set<IAgoraRTCClient>();
  const leaving = new Map<IAgoraRTCClient, Promise<void>>();

  function leaveClient(target: IAgoraRTCClient): Promise<void> {
    const existing = leaving.get(target);
    if (existing) return existing;
    const pending = Promise.resolve().then(() => target.leave()).then(() => {
      failedLeaves.delete(target);
    }, (error: unknown) => {
      failedLeaves.add(target);
      throw error;
    }).finally(() => { leaving.delete(target); });
    leaving.set(target, pending);
    return pending;
  }
  /**
   * 已订阅的远端，`uid` → 已订阅的媒体种类。
   *
   * 存在的理由只有一个：**离开频道前要先通知 UI 停播**。UI 手里握着远端 track 的
   * 引用，如果先 `leave()` 再（或根本不）通知，UI 会继续对已销毁的 track 调用
   * 渲染，画面卡死或报错。所以这里记住「谁在播什么」，退出时逐个通知。
   */
  const subscribed = new Map<string, Set<'audio' | 'video'>>();

  function requireJoined(): IAgoraRTCClient {
    if (!client || !joined) throw new RtcUsageError('RTC 尚未加入房间');
    return client;
  }

  function isCurrent(target: IAgoraRTCClient, operationGeneration: number): boolean {
    return client === target && generation === operationGeneration;
  }

  function attachListeners(target: IAgoraRTCClient, operationGeneration: number): void {
    target.on('connection-state-change', (currentState, _previous, reason) => {
      if (!isCurrent(target, operationGeneration)) return;
      const failed = currentState === 'DISCONNECTED' && reason && reason !== 'LEAVE';
      handlers.connection(failed ? 'failed' : CONNECTION_STATES[currentState], reason);
    });

    target.on('user-joined', (user) => {
      if (!isCurrent(target, operationGeneration)) return;
      handlers.remoteUserJoined?.(String(user.uid));
    });

    target.on('user-left', (user) => {
      if (!isCurrent(target, operationGeneration)) return;
      handlers.remoteUserLeft?.(String(user.uid));
    });

    target.on('user-published', (user, mediaType) => {
      if (!isCurrent(target, operationGeneration)) return;
      if (mediaType === 'audio' || mediaType === 'video') {
        void subscribe(target, user, mediaType, operationGeneration);
      }
    });

    target.on('user-unpublished', (user, mediaType) => {
      if (!isCurrent(target, operationGeneration)) return;
      if (mediaType !== 'audio' && mediaType !== 'video') return;
      // 顺序要紧：**先**通知 UI 停播，**再**取消订阅。
      // 反过来会让 UI 在 track 已销毁之后还持有它。
      notifyStopped(String(user.uid), mediaType);
      void unsubscribeQuietly(target, user, mediaType);
    });

    target.on('volume-indicator', (levels) => {
      if (!isCurrent(target, operationGeneration)) return;
      handlers.volume(Object.fromEntries(levels.map((item) => [String(item.uid), item.level])));
    });
  }

  /** 通知 UI 停播，并从订阅记录里移除。 */
  function notifyStopped(userId: string, mediaType: 'audio' | 'video'): void {
    if (mediaType === 'audio') handlers.remoteAudioUnpublished(userId);
    else handlers.remoteVideoUnpublished(userId);

    const kinds = subscribed.get(userId);
    if (!kinds) return;
    kinds.delete(mediaType);
    if (kinds.size === 0) subscribed.delete(userId);
  }

  /**
   * 取消订阅，失败只吞掉不上抛。
   *
   * 这是清理路径：远端可能已经离开，`unsubscribe` 报错是常态而非异常。
   * 让它冒泡会掩盖真正的失败原因（见 spec「分阶段回滚」的同一取舍）。
   */
  async function unsubscribeQuietly(
    target: IAgoraRTCClient,
    user: IAgoraRTCRemoteUser | { uid: string },
    mediaType: 'audio' | 'video',
  ): Promise<void> {
    try {
      await target.unsubscribe(user as IAgoraRTCRemoteUser, mediaType);
    } catch {
      // 清理失败不影响调用方。
    }
  }

  /** 离开前把所有远端的停播通知发完 —— UI 先松手，再拆链路。 */
  function notifyAllStopped(): void {
    for (const [userId, kinds] of [...subscribed]) {
      for (const mediaType of [...kinds]) notifyStopped(userId, mediaType);
    }
  }

  async function subscribe(
    target: IAgoraRTCClient,
    user: IAgoraRTCRemoteUser,
    mediaType: 'audio' | 'video',
    operationGeneration: number,
  ): Promise<void> {
    try {
      const track = await target.subscribe(user, mediaType);
      if (!isCurrent(target, operationGeneration)) {
        await unsubscribeQuietly(target, user, mediaType);
        return;
      }
      const kinds = subscribed.get(String(user.uid)) ?? new Set<'audio' | 'video'>();
      kinds.add(mediaType);
      subscribed.set(String(user.uid), kinds);
      if (mediaType === 'audio') {
        // 音频没有挂载点问题，模块内部直接播。
        (track as { play(): void }).play();
        handlers.remoteAudioPublished(String(user.uid));
        return;
      }
      // 视频交给 UI 自己播 —— 只有 UI 知道播到哪个节点。
      handlers.remoteVideoTrack(String(user.uid), track as IRemoteVideoTrack);
    } catch (error) {
      if (isCurrent(target, operationGeneration)) {
        handlers.connection('failed', toRtcSdkError(error).message);
      }
    }
  }

  return {
    registerEvents(next) {
      handlers = next;
    },

    async join(settings) {
      const cleanup = client || joined ? this.leave() : undefined;
      const operationGeneration = ++generation;
      if (cleanup) await cleanup;
      if (operationGeneration !== generation) throw new RtcUsageError('RTC 加入已取消');
      const created = deps.createClient({ mode: 'rtc', codec: 'vp8' });
      client = created;
      attachListeners(created, operationGeneration);
      try {
        const token = getToken ? await getToken({
          service: 'rtc', appId: settings.appId, userId: settings.userId, channelName: settings.roomId,
        }) : undefined;
        // The RTC SDK requires null for an unauthenticated join.
        await created.join(settings.appId, settings.roomId, token ?? null, settings.userId);
        if (!isCurrent(created, operationGeneration)) {
          throw new RtcUsageError('RTC 加入已取消');
        }
        joined = true;
        created.enableAudioVolumeIndicator();
      } catch (error) {
        if (isCurrent(created, operationGeneration)) {
          client = undefined;
          joined = false;
        }
        try { await leaveClient(created); } catch { /* Retain the old client for cleanup retry without hiding the join error. */ }
        throw toRtcSdkError(error);
      }
    },

    async leave() {
      generation += 1;
      // 离开也要先发停播通知，理由与 `user-unpublished` 相同：
      // 频道与本地轨道即将销毁，UI 必须先停止播放远端 track。
      if (joined) notifyAllStopped();

      const target = client;
      const localMic = microphone;
      const localCamera = camera;
      const wasJoined = joined;
      const previousLeaves = [...failedLeaves].filter((old) => old !== target);

      // 先清状态再做异步清理：重复调用 leave 不会重复 leave 客户端。
      client = undefined;
      microphone = undefined;
      camera = undefined;
      joined = false;
      micPublished = false;
      cameraPublished = false;
      subscribed.clear();

      const cleanupCurrent = async () => {
        try {
          if (target && wasJoined) {
            const tracks = [localMic, localCamera].filter(Boolean);
            try {
              if (tracks.length > 0) await target.unpublish(tracks as never);
            } finally {
              await leaveClient(target);
            }
          }
        } finally {
          localMic?.close();
          localCamera?.close();
        }
      };
      const results = await Promise.allSettled([cleanupCurrent(), ...previousLeaves.map(leaveClient)]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw toRtcSdkError(failure.reason);
    },

    async publishMicrophone() {
      if (micPublished) return;
      const target = requireJoined();
      const operationGeneration = generation;
      try {
        const localMic = microphone ?? await deps.createMicrophoneAudioTrack();
        if (!isCurrent(target, operationGeneration)) {
          localMic.close();
          throw new RtcUsageError('麦克风发布已取消');
        }
        microphone = localMic;
        await target.publish(localMic);
        if (!isCurrent(target, operationGeneration)) {
          // leave owns the captured track's close; undo a publish that finished afterwards.
          try { await target.unpublish(localMic); } catch { /* The old client may already have left. */ }
          throw new RtcUsageError('麦克风发布已取消');
        }
        micPublished = true;
      } catch (error) {
        throw toRtcSdkError(error);
      }
    },

    async unpublishMicrophone() {
      if (!micPublished || !client || !microphone) return;
      const target = client;
      const localMic = microphone;
      const operationGeneration = generation;
      try {
        await target.unpublish(localMic);
        if (isCurrent(target, operationGeneration)) micPublished = false;
      } catch (error) {
        throw toRtcSdkError(error);
      }
    },

    async setMicrophoneMuted(muted) {
      if (!microphone) throw new RtcUsageError('麦克风尚未发布');
      try {
        await microphone.setMuted(muted);
      } catch (error) {
        throw toRtcSdkError(error);
      }
    },

    isMicrophoneCaptureHealthy() {
      if (!microphone) return false;
      try {
        const mediaTrack = microphone.getMediaStreamTrack();
        return mediaTrack.readyState === 'live' && !mediaTrack.muted;
      } catch {
        return false;
      }
    },

    async publishCamera() {
      if (cameraPublished) return;
      const target = requireJoined();
      const operationGeneration = generation;
      try {
        const localCamera = camera ?? await deps.createCameraVideoTrack();
        if (!isCurrent(target, operationGeneration)) {
          localCamera.close();
          throw new RtcUsageError('摄像头发布已取消');
        }
        camera = localCamera;
        await target.publish(localCamera);
        if (!isCurrent(target, operationGeneration)) {
          try { await target.unpublish(localCamera); } catch { /* The old client may already have left. */ }
          throw new RtcUsageError('摄像头发布已取消');
        }
        cameraPublished = true;
      } catch (error) {
        throw toRtcSdkError(error);
      }
    },

    async unpublishCamera() {
      if (!cameraPublished || !client || !camera) return;
      const target = client;
      const localCamera = camera;
      const operationGeneration = generation;
      try {
        await target.unpublish(localCamera);
        if (isCurrent(target, operationGeneration)) cameraPublished = false;
      } catch (error) {
        throw toRtcSdkError(error);
      }
    },

    async setCameraMuted(muted) {
      if (!camera) throw new RtcUsageError('摄像头尚未发布');
      try {
        await camera.setMuted(muted);
      } catch (error) {
        throw toRtcSdkError(error);
      }
    },

    getLocalVideoTrack() {
      // 刻意只在已发布时返回：未发布就交出轨道会让 UI 播一个空画面。
      return cameraPublished ? camera : undefined;
    },
  };
}
