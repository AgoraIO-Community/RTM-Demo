import {
  CallerInvitationState, CalleeInvitationState,
  type CallRtm, type RtmInvitation, type CallInvitationSnapshot, type CallFinishReason,
} from '../rtm';
import type { CallAudioSession, CallAudioSnapshot } from '../rtc/call-audio';
import { isValidCallUid, normalizeCallNickname } from './identity';

interface CallDescriptor {
  callId: string;
  localUid: string;
  remoteUid: string;
  remoteNickname: string;
  expiresAt: number;
}

type AppCallFinishReason = CallFinishReason | 'REFUSED' | 'CANCELED' | 'MEDIA_FAILED' | 'MEDIA_TIMEOUT' | 'ENDED';

type CallState =
  | { status: 'IDLE'; result?: { call: CallDescriptor; reason: AppCallFinishReason } }
  | { status: 'OUTGOING_SENDING' | 'OUTGOING_RINGING' | 'INCOMING_RINGING' | 'ACCEPTING' | 'ACCEPT_WAITING_ACK' | 'MEDIA_CONNECTING'; call: CallDescriptor }
  | { status: 'ACTIVE'; call: CallDescriptor; startedAt: number };

export interface AppIncomingInvitation extends CallInvitationSnapshot {
  remoteNickname: string;
}

export interface AppCallControllerSnapshot {
  call: CallState;
  audio: CallAudioSnapshot;
  incomingInvitations: readonly AppIncomingInvitation[];
  canAcceptIncoming: boolean;
  notice?: string;
}

interface Options {
  appId: string;
  localUid: string;
  nickname: string;
  rtm: CallRtm;
  createAudio: () => CallAudioSession;
  now?: () => number;
  mediaTimeoutMs?: number;
}

interface MediaSession {
  invitation: RtmInvitation;
  audio: CallAudioSession;
  endTs: number;
  startedAt?: number;
  unsubscribe: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

const IDLE_AUDIO: CallAudioSnapshot = { status: 'idle', remoteJoined: false, microphone: 'off' };

/** App policy: independent invitations, one reserved media slot, per-call RTC ownership. */
export class AppCallController {
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions = new Map<RtmInvitation, () => void>();
  private readonly accepted = new Set<string>();
  private readonly cleaning = new Map<CallAudioSession, Promise<void>>();
  private readonly unsubscribeRtm: () => void;
  private readonly unsubscribeIncoming: () => void;
  private readonly unsubscribeErrors: () => void;
  private selected: RtmInvitation | undefined;
  private current: RtmInvitation | undefined;
  private media: MediaSession | undefined;
  private result: Extract<CallState, { status: 'IDLE' }>['result'];
  private notice: string | undefined;
  private snapshot: AppCallControllerSnapshot = {
    call: { status: 'IDLE' }, audio: IDLE_AUDIO, incomingInvitations: [], canAcceptIncoming: true,
  };
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.unsubscribeRtm = this.options.rtm.subscribe(() => this.publishSnapshot());
    this.unsubscribeIncoming = this.options.rtm.on('incomingInvitation', (invitation) => this.observe(invitation));
    this.unsubscribeErrors = this.options.rtm.on('operationError', (event) => {
      if (event.operation === 'INVITE') return;
      if (this.selected && this.selected.callId !== event.callId) return;
      this.notice = event.error.message;
      this.publishSnapshot();
    });
  }

  getSnapshot = (): AppCallControllerSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getInvitation(callId: string): RtmInvitation | undefined { return this.options.rtm.getInvitation(callId); }
  getCurrentInvitation(): RtmInvitation | undefined { return this.current; }

  async startCall(remoteUid: string): Promise<void> {
    this.checkDeadlines();
    const target = remoteUid.trim();
    if (this.disposed || this.selected || !isValidCallUid(target) || target === this.options.localUid) return;
    const invitation = this.options.rtm.createOutgoingInvitation(target, this.nicknameExtra());
    this.selected = invitation;
    this.current = invitation;
    this.result = undefined;
    this.notice = undefined;
    this.observe(invitation);
    await this.options.rtm.sendCallInvitation(invitation.callId);
  }

  async accept(callId?: string): Promise<void> {
    this.checkDeadlines();
    const invitation = this.incoming(callId);
    if (!invitation || (this.selected && this.selected !== invitation)) return;
    const state = invitation.getSnapshot();
    if (state.state !== CalleeInvitationState.INVITATION_RECEIVED || state.publishing) return;
    this.selected = invitation;
    this.current = invitation;
    this.result = undefined;
    this.notice = undefined;
    this.publishSnapshot();
    try { await this.options.rtm.acceptCallInvitation(invitation.callId, this.nicknameExtra()); }
    catch { /* The core reports the operation error without changing the invitation. */ }
    if (this.selected === invitation && invitation.getSnapshot().state === CalleeInvitationState.INVITATION_RECEIVED) {
      this.selected = undefined;
      this.publishSnapshot();
    }
  }

  async refuse(callId?: string): Promise<void> {
    this.checkDeadlines();
    const invitation = this.incoming(callId);
    if (!invitation || invitation.getSnapshot().publishing) return;
    try { await this.options.rtm.refuseCallInvitation(invitation.callId, this.nicknameExtra()); }
    catch { /* Refusal remains a terminal invitation even when the notification fails. */ }
  }

  async cancel(): Promise<void> {
    this.checkDeadlines();
    const invitation = this.selected;
    if (!invitation || invitation.getSnapshot().role !== 'CALLER' || invitation.getSnapshot().ended) return;
    try { await this.options.rtm.cancelCallInvitation(invitation.callId); }
    catch { /* Local cancellation is already committed. */ }
  }

  async end(): Promise<void> {
    if (this.media) this.finishMedia(this.media, 'ENDED');
  }

  async toggleMute(): Promise<void> {
    const media = this.media;
    if (!media) return;
    try { await media.audio.setMuted(media.audio.getSnapshot().microphone !== 'muted'); }
    catch (error) { if (this.media === media) this.setNotice(error); }
  }

  async retryMicrophone(): Promise<void> {
    const media = this.media;
    if (!media) return;
    try { await media.audio.retryMicrophone(); }
    catch (error) { if (this.media === media) this.setNotice(error); }
  }

  setNickname(nickname: string): void { this.options.nickname = nickname; }
  dismissResult(): void { this.result = undefined; this.publishSnapshot(); }

  checkDeadlines(): void {
    if (this.disposed) return;
    this.options.rtm.checkDeadlines();
    const media = this.media;
    if (media && media.startedAt === undefined && this.now() >= media.endTs) this.finishMedia(media, 'MEDIA_TIMEOUT');
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const selected = this.selected;
    if (selected?.getSnapshot().role === 'CALLER' && !selected.getSnapshot().ended) {
      void this.options.rtm.cancelCallInvitation(selected.callId).catch(() => undefined);
    }
    this.unsubscribeRtm();
    this.unsubscribeIncoming();
    this.unsubscribeErrors();
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    if (this.media) this.finishMedia(this.media, 'ENDED');
    this.options.rtm.dispose();
    this.listeners.clear();
    this.disposal = Promise.allSettled([...this.cleaning.keys()].map((audio) => audio.end())).then(() => undefined);
    return this.disposal;
  }

  private incoming(callId?: string): RtmInvitation | undefined {
    const incoming = this.options.rtm.getSnapshot().incomingInvitations;
    return callId ? incoming.find((invitation) => invitation.callId === callId) : incoming[0];
  }

  private observe(invitation: RtmInvitation): void {
    if (this.subscriptions.has(invitation)) return;
    this.subscriptions.set(invitation, invitation.subscribe(() => this.onInvitationChanged(invitation)));
  }

  private onInvitationChanged(invitation: RtmInvitation): void {
    if (this.disposed) return;
    const state = invitation.getSnapshot();
    if (state.role === 'CALLEE' && state.state === CalleeInvitationState.INVITATION_RECEIVED) {
      const outgoing = this.selected?.getSnapshot();
      if (outgoing?.role === 'CALLER' && !outgoing.ended && outgoing.remoteUid === state.remoteUid) {
        if (state.callId < outgoing.callId) void this.cancel();
        else void this.refuse(invitation.callId);
      }
    }
    const accepted = state.state === CallerInvitationState.ACCEPTED_BY_CALLEE || state.state === CalleeInvitationState.ACCEPTED;
    if (accepted && !this.accepted.has(state.callId)) {
      this.accepted.add(state.callId);
      if (!this.selected || this.selected === invitation) this.beginMedia(invitation);
    } else if (state.ended && !accepted && (!this.selected || this.selected === invitation)) {
      this.selected = undefined;
      this.current = invitation;
      this.result = {
        call: descriptor(state),
        reason: state.state === CallerInvitationState.CANCELED || state.state === CalleeInvitationState.CANCELED_BY_CALLER
          ? 'CANCELED' : state.state === CallerInvitationState.REFUSED_BY_CALLEE || state.state === CalleeInvitationState.REFUSED
            ? 'REFUSED' : state.reason ?? 'PUBLISH_FAILED',
      };
    }
    this.publishSnapshot();
  }

  private beginMedia(invitation: RtmInvitation): void {
    const audio = this.options.createAudio();
    const media: MediaSession = {
      invitation, audio, endTs: this.now() + (this.options.mediaTimeoutMs ?? 15_000), unsubscribe: () => undefined,
    };
    this.selected = invitation;
    this.current = invitation;
    this.result = undefined;
    this.media = media;
    media.unsubscribe = audio.subscribe(() => this.onAudioChanged(media));
    const check = () => {
      if (this.media !== media || media.startedAt !== undefined) return;
      this.checkDeadlines();
      if (this.media === media) media.timer = setTimeout(check, Math.max(0, media.endTs - this.now()));
    };
    media.timer = setTimeout(check, Math.max(0, media.endTs - this.now()));
    this.publishSnapshot();
    if (this.media !== media) return;
    const state = invitation.getSnapshot();
    void audio.connect({ appId: this.options.appId, callId: state.callId, localUid: state.localUid, remoteUid: state.remoteUid })
      .then(() => this.onAudioChanged(media), () => {
        if (this.media === media) this.finishMedia(media, 'MEDIA_FAILED');
      });
  }

  private onAudioChanged(media: MediaSession): void {
    if (this.media !== media || this.disposed) return;
    this.checkDeadlines();
    if (this.media !== media) return;
    const audio = media.audio.getSnapshot();
    if (audio.status === 'failed') this.finishMedia(media, 'MEDIA_FAILED');
    else if (audio.status === 'connected' && audio.remoteJoined) {
      if (media.startedAt === undefined) {
        media.startedAt = this.now();
        clearTimeout(media.timer);
      }
      this.publishSnapshot();
    } else if (media.startedAt !== undefined && !audio.remoteJoined) this.finishMedia(media, 'ENDED');
    else this.publishSnapshot();
  }

  private finishMedia(media: MediaSession, reason: AppCallFinishReason): void {
    if (this.media !== media) return;
    this.media = undefined;
    this.selected = undefined;
    media.unsubscribe();
    clearTimeout(media.timer);
    this.result = { call: descriptor(media.invitation.getSnapshot()), reason };
    const cleanup = media.audio.end();
    this.cleaning.set(media.audio, cleanup);
    void cleanup.then(() => this.cleaning.delete(media.audio), () => undefined);
    this.publishSnapshot();
  }

  private nicknameExtra(): string { return this.options.nickname ? JSON.stringify({ nickname: this.options.nickname }) : ''; }

  private setNotice(error: unknown): void {
    this.notice = error instanceof Error ? error.message : '音频操作失败';
    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    if (this.disposed) return;
    const incoming = this.options.rtm.getSnapshot().incomingInvitations.map((invitation) => {
      const state = invitation.getSnapshot();
      return { ...state, remoteNickname: nicknameFromExtra(state.remoteExtra) };
    });
    let call: CallState = { status: 'IDLE', ...(this.result ? { result: this.result } : {}) };
    if (this.media) {
      call = this.media.startedAt === undefined
        ? { status: 'MEDIA_CONNECTING', call: descriptor(this.media.invitation.getSnapshot()) }
        : { status: 'ACTIVE', call: descriptor(this.media.invitation.getSnapshot()), startedAt: this.media.startedAt };
    } else if (this.selected) {
      const state = this.selected.getSnapshot();
      if (!state.ended) call = {
        status: state.role === 'CALLER'
          ? state.state === CallerInvitationState.RECEIVED_BY_CALLEE ? 'OUTGOING_RINGING' : 'OUTGOING_SENDING'
          : state.state === CalleeInvitationState.ACCEPT_SENT_TO_CALLER ? 'ACCEPT_WAITING_ACK' : 'ACCEPTING',
        call: descriptor(state),
      };
    } else if (incoming[0]) call = { status: 'INCOMING_RINGING', call: descriptor(incoming[0]) };
    this.snapshot = {
      call, audio: this.media?.audio.getSnapshot() ?? IDLE_AUDIO, incomingInvitations: incoming,
      canAcceptIncoming: !this.selected && !this.media,
      ...(this.notice ? { notice: this.notice } : {}),
    };
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* View listeners cannot interrupt resource ownership. */ }
    }
  }
}

function descriptor(state: CallInvitationSnapshot): CallDescriptor {
  return {
    callId: state.callId, localUid: state.localUid, remoteUid: state.remoteUid,
    remoteNickname: nicknameFromExtra(state.remoteExtra), expiresAt: state.endTs,
  };
}

function nicknameFromExtra(extra: string): string {
  try {
    const value: unknown = JSON.parse(extra);
    if (!value || typeof value !== 'object' || !('nickname' in value) || typeof value.nickname !== 'string') return '';
    const normalized = normalizeCallNickname(value.nickname);
    return 'value' in normalized ? normalized.value : '';
  } catch { return ''; }
}
