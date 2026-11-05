import { createRtcHelper, type RtcHelper } from '../../../shared/rtc';

interface CallErrorDetails {
  code?: number | string;
  message: string;
}

export interface CallAudioSettings {
  appId: string;
  callId: string;
  localUid: string;
  remoteUid: string;
}

export interface CallAudioSnapshot {
  status: 'idle' | 'connecting' | 'connected' | 'failed';
  callId?: string;
  remoteJoined: boolean;
  microphone: 'off' | 'on' | 'muted' | 'error';
  error?: string;
  failure?: CallErrorDetails;
}

const IDLE: CallAudioSnapshot = { status: 'idle', remoteJoined: false, microphone: 'off' };

export function createCallAudioSession(rtc: RtcHelper = createRtcHelper()): CallAudioSession {
  return new CallAudioSession(rtc);
}

export function rtcChannelFor(callId: string): string {
  return `CALL_KIT_RTC_${callId}`;
}

export class CallAudioSession {
  private snapshot: CallAudioSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private settings: CallAudioSettings | undefined;
  private ended = false;
  private readonly operations = new Set<Promise<void>>();
  private cleanup: Promise<void> | undefined;
  private cleanupFailed = false;

  constructor(private readonly rtc: RtcHelper) {}

  getSnapshot = (): CallAudioSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(settings: CallAudioSettings): Promise<void> {
    return this.trackOperation(() => this.connectAudio(settings));
  }

  private async connectAudio(settings: CallAudioSettings): Promise<void> {
    if (this.settings?.callId === settings.callId && this.snapshot.status !== 'failed') return;
    const operationGeneration = ++this.generation;
    this.settings = settings;
    this.update({ status: 'connecting', callId: settings.callId, remoteJoined: false, microphone: 'off' });
    if (!this.isCurrent(operationGeneration)) return;
    this.rtc.registerEvents({
      connection: (state, reason) => {
        if (!this.isCurrent(operationGeneration)) return;
        if (state === 'failed') this.update({
          ...this.snapshot, status: 'failed', error: reason ?? 'RTC 连接失败',
          failure: { message: reason ?? 'RTC 连接失败' },
        });
      },
      remoteUserJoined: (userId) => {
        if (!this.isCurrent(operationGeneration) || userId !== settings.remoteUid) return;
        this.update({ ...this.snapshot, remoteJoined: true });
      },
      remoteUserLeft: (userId) => {
        if (!this.isCurrent(operationGeneration) || userId !== settings.remoteUid) return;
        this.update({ ...this.snapshot, remoteJoined: false });
      },
      remoteAudioPublished: () => undefined,
      remoteAudioUnpublished: () => undefined,
      remoteVideoTrack: () => undefined,
      remoteVideoUnpublished: () => undefined,
      volume: () => undefined,
    });

    try {
      await this.rtc.join({ appId: settings.appId, roomId: rtcChannelFor(settings.callId), userId: settings.localUid });
    } catch (error) {
      if (this.isCurrent(operationGeneration)) {
        this.update({ ...this.snapshot, status: 'failed', error: messageOf(error), failure: callErrorDetails(error) });
      }
      throw error;
    }
    if (!this.isCurrent(operationGeneration)) return;
    this.update({ ...this.snapshot, status: 'connected' });
    if (!this.isCurrent(operationGeneration)) return;
    try {
      await this.rtc.publishMicrophone();
      if (this.isCurrent(operationGeneration)) this.update({ ...this.snapshot, microphone: 'on', error: undefined });
    } catch (error) {
      if (this.isCurrent(operationGeneration)) {
        this.update({ ...this.snapshot, microphone: 'error', error: messageOf(error) });
      }
    }
  }

  retryMicrophone(): Promise<void> {
    return this.trackOperation(() => this.publishMicrophone());
  }

  private async publishMicrophone(): Promise<void> {
    if (!this.settings || this.snapshot.status !== 'connected') return;
    const operationGeneration = this.generation;
    try {
      await this.rtc.publishMicrophone();
      if (this.isCurrent(operationGeneration)) this.update({ ...this.snapshot, microphone: 'on', error: undefined });
    } catch (error) {
      if (this.isCurrent(operationGeneration)) this.update({ ...this.snapshot, microphone: 'error', error: messageOf(error) });
      throw error;
    }
  }

  setMuted(muted: boolean): Promise<void> {
    return this.trackOperation(() => this.muteMicrophone(muted));
  }

  private async muteMicrophone(muted: boolean): Promise<void> {
    if (!this.settings || this.snapshot.microphone === 'error' || this.snapshot.microphone === 'off') return;
    const operationGeneration = this.generation;
    await this.rtc.setMicrophoneMuted(muted);
    if (this.isCurrent(operationGeneration)) {
      this.update({ ...this.snapshot, microphone: muted ? 'muted' : 'on', error: undefined });
    }
  }

  end(): Promise<void> {
    if (this.cleanup && !this.cleanupFailed) return this.cleanup;
    const hasMedia = Boolean(this.settings) || this.snapshot.status !== 'idle' || this.cleanupFailed;
    this.ended = true;
    this.cleanupFailed = false;
    this.generation += 1;
    this.settings = undefined;
    this.update(IDLE);
    let leave: Promise<void>;
    try { leave = hasMedia ? this.rtc.leave() : Promise.resolve(); }
    catch (error) { leave = Promise.reject(error); }
    // A canceled join or capture can still own resources until its Promise settles.
    const operations = [...this.operations];
    this.cleanup = Promise.allSettled([leave, ...operations]).then(async ([result]) => {
      if (result?.status === 'rejected') {
        this.cleanupFailed = true;
        throw result.reason;
      }
      // A late join may have failed its own leave after the first cleanup already ran.
      if (operations.length) {
        try { await this.rtc.leave(); }
        catch (error) { this.cleanupFailed = true; throw error; }
      }
    });
    void this.cleanup.catch(() => undefined);
    return this.cleanup;
  }

  private trackOperation(operation: () => Promise<void>): Promise<void> {
    if (this.ended) return Promise.reject(new Error('音频会话已结束'));
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const pending = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    this.operations.add(pending);
    try { void operation().then(resolve, reject); }
    catch (error) { reject(error); }
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending));
    return pending;
  }

  private isCurrent(target: number): boolean {
    return this.generation === target;
  }

  private update(next: CallAudioSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'RTC 音频失败';
}

/** RTC wrappers retain the original SDK error in cause. */
function callErrorDetails(error: unknown): CallErrorDetails {
  let source = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!(source instanceof Error) || source.cause === undefined || source.cause === source) break;
    source = source.cause;
  }
  const value = source as { errorCode?: unknown; code?: unknown; message?: unknown } | null;
  const code = value?.errorCode ?? value?.code;
  return {
    ...(typeof code === 'number' || typeof code === 'string' ? { code } : {}),
    message: typeof value?.message === 'string' ? value.message : String(source),
  };
}
