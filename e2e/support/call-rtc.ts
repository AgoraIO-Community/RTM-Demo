import type { RtcHandlers, RtcHelper } from '../../src/shared/rtc';
import { CallAudioSession } from '../../src/scenes/one-to-one-call/rtc/call-audio';

type RtcBusEvent = {
  kind: 'join' | 'present' | 'leave';
  roomId: string;
  userId: string;
};

const BUS_NAME = 'one-to-one-call-e2e:rtc';

export function createCallAudioSession(_rtc?: RtcHelper): CallAudioSession {
  // Always isolate E2E media, including when the scene supplies a token-aware helper.
  return new CallAudioSession(createE2eCallRtc());
}

function createE2eCallRtc(): RtcHelper {
  const bus = new BroadcastChannel(BUS_NAME);
  let handlers: RtcHandlers | undefined;
  let current: { roomId: string; userId: string } | undefined;
  let muted = false;

  bus.addEventListener('message', ({ data }) => {
    const event = data as RtcBusEvent;
    if (!current || event.roomId !== current.roomId || event.userId === current.userId) return;
    if (event.kind === 'leave') {
      handlers?.remoteUserLeft?.(event.userId);
      return;
    }
    handlers?.remoteUserJoined?.(event.userId);
    if (event.kind === 'join') {
      bus.postMessage({ kind: 'present', ...current } satisfies RtcBusEvent);
    }
  });

  const noop = async () => undefined;
  return {
    registerEvents(next) { handlers = next; },
    async join(settings) {
      current = { roomId: settings.roomId, userId: settings.userId };
      bus.postMessage({ kind: 'join', ...current } satisfies RtcBusEvent);
    },
    async leave() {
      if (!current) return;
      bus.postMessage({ kind: 'leave', ...current } satisfies RtcBusEvent);
      current = undefined;
      muted = false;
    },
    publishMicrophone: noop,
    unpublishMicrophone: noop,
    async setMicrophoneMuted(next) { muted = next; },
    isMicrophoneCaptureHealthy: () => !muted || Boolean(current),
    publishCamera: noop,
    unpublishCamera: noop,
    setCameraMuted: noop,
    getLocalVideoTrack: () => undefined,
  };
}
