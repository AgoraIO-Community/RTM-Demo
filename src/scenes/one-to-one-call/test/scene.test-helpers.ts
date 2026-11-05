import type { RtcHandlers, RtcHelper } from '../../../shared/rtc';
import { AppCallRtmSession, type CallRtmClient } from '../rtm';
import type { OneToOneCallOverrides } from '../OneToOneCallScene';

function createRtc(onRegister: (handlers: RtcHandlers) => void): RtcHelper {
  const noop = async () => undefined;
  return {
    registerEvents: onRegister, join: noop, leave: noop,
    publishMicrophone: noop, unpublishMicrophone: noop, setMicrophoneMuted: noop,
    isMicrophoneCaptureHealthy: () => true, publishCamera: noop, unpublishCamera: noop,
    setCameraMuted: noop, getLocalVideoTrack: () => undefined,
  };
}

function createSession(appId: string, uid: string, listeners: Map<string, Set<(event: never) => void>>): AppCallRtmSession {
  return new AppCallRtmSession(appId, uid, {
    createClient: () => ({
      addEventListener(name, listener) {
        const set = listeners.get(name) ?? new Set();
        set.add(listener as (event: never) => void);
        listeners.set(name, set);
      },
      removeEventListener(name, listener) { listeners.get(name)?.delete(listener as (event: never) => void); },
      async login() {
        for (const listener of listeners.get('linkState') ?? []) {
          listener({ currentState: 'CONNECTED', previousState: 'CONNECTING', timestamp: Date.now() } as never);
        }
      }, async logout() {}, async publish() {},
    } as CallRtmClient),
  });
}

/** Network-free RTM and RTC fakes shared by scene and app-shell tests. */
export function createOneToOneCallFakes() {
  const listeners = new Map<string, Set<(event: never) => void>>();
  let rtcHandlers: RtcHandlers | undefined;
  const overrides: OneToOneCallOverrides = {
    createAppRtmSession: (appId, uid) => createSession(appId, uid, listeners),
    createRtc: () => createRtc((handlers) => { rtcHandlers = handlers; }),
  };
  return {
    overrides,
    emitMessage(event: Record<string, unknown>): void {
      for (const listener of listeners.get('message') ?? []) listener(event as never);
    },
    remoteJoined(uid: string): void { rtcHandlers?.remoteUserJoined?.(uid); },
    remoteLeft(uid: string): void { rtcHandlers?.remoteUserLeft?.(uid); },
  };
}
