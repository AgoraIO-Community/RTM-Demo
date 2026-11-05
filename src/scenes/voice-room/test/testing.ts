import type { RtcHelper } from '../../../shared/rtc';
import { AppRtmSession, type AppRtmClient } from '../app-rtm';
import type { VoiceRoomSceneProps } from '../VoiceRoomScene';

export interface VoiceRoomFakes {
  overrides: NonNullable<VoiceRoomSceneProps['overrides']>;
}

function createRtc(): RtcHelper {
  const noop = async () => undefined;
  return {
    registerEvents: () => undefined,
    join: noop,
    leave: noop,
    publishMicrophone: noop,
    unpublishMicrophone: noop,
    setMicrophoneMuted: noop,
    isMicrophoneCaptureHealthy: () => true,
    publishCamera: noop,
    unpublishCamera: noop,
    setCameraMuted: noop,
    getLocalVideoTrack: () => undefined,
  };
}

function createAppRtmSession(appId: string, userId: string): AppRtmSession {
  const listeners = new Map<string, Set<(event: never) => void>>();
  return new AppRtmSession(appId, userId, {
    createClient: () => ({
      addEventListener(name, listener) {
        const set = listeners.get(name) ?? new Set();
        set.add(listener as (event: never) => void);
        listeners.set(name, set);
      },
      removeEventListener(name, listener) {
        listeners.get(name)?.delete(listener as (event: never) => void);
      },
      /** 与真实 SDK 一致：登录成功发出一条 linkState CONNECTED，供顶栏连接状态与 trace 使用。 */
      async login() {
        for (const listener of listeners.get('linkState') ?? []) {
          listener({
            timestamp: Date.now(), previousState: 'CONNECTING', currentState: 'CONNECTED', operation: 'LOGIN',
            reasonCode: 'LOGIN_SUCCESS', reason: '', affectedChannels: [], unrestoredChannels: [], isResumed: false, serviceType: 'RTM',
          } as never);
        }
      },
      async logout() {},
      async subscribe() {},
      async unsubscribe() {},
      async publish() {},
      presence: {
        async setState() {},
        async removeState() {},
      },
      storage: {
        async getChannelMetadata() { return { majorRevision: 0, totalCount: 0, metadata: {} }; },
        async setChannelMetadata() {},
        async removeChannelMetadata() {},
      },
    } as AppRtmClient),
  });
}

/** Network-free fakes for the current single-role voice-room page. */
export function createVoiceRoomFakes(): VoiceRoomFakes {
  return {
    overrides: {
      createAppRtmSession,
      createRtc,
    },
  };
}
