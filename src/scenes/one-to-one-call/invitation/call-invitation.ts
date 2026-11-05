import { callErrorDetails, type CallErrorDetails } from './call-errors';
import { buildCallSignal, type CallSignal, type CallSignalType } from './call-protocol';
import {
  canTransitionInvitation, isTerminalInvitationState, CallerInvitationState as Caller, CalleeInvitationState as Callee,
  type CallFinishReason, type InvitationLinkState, type InvitationMessageOutcome, type InvitationOptions,
  type InvitationRole, type InvitationState, type InvitationTrigger,
} from './call-state';

export type { InvitationOptions, InvitationRole, InvitationState } from './call-state';

export interface InvitationRtmPort {
  publishToUser(targetUid: string, customType: CallSignalType, message: string): Promise<void>;
}

export interface CallInvitationSnapshot {
  callId: string;
  role: InvitationRole;
  localUid: string;
  remoteUid: string;
  state: InvitationState;
  ended: boolean;
  extra: string;
  remoteExtra: string;
  startTs: number;
  endTs: number;
  publishing: boolean;
  reason?: CallFinishReason;
  trigger?: InvitationTrigger;
  sdkError?: CallErrorDetails;
  linkStateAtFailure?: InvitationLinkState;
  failureAt?: number;
  failureAttempt?: number;
}

export interface InvitationStateChangedEvent extends CallInvitationSnapshot {
  previousState: InvitationState;
  sequence: number;
  timestamp: number;
}

export interface InvitationOperationError {
  callId: string;
  role: InvitationRole;
  operation: 'INVITE' | 'ACCEPT' | 'ACK' | 'REFUSE' | 'CANCEL';
  error: CallErrorDetails;
  sdkError?: CallErrorDetails;
  reason: CallFinishReason;
  linkStateAtFailure: InvitationLinkState;
  timestamp: number;
}

export interface CallInvitationOptions {
  callId: string;
  role: InvitationRole;
  localUid: string;
  remoteUid: string;
  extra?: string;
  remoteExtra?: string;
  port: InvitationRtmPort;
  getLinkState: () => InvitationLinkState;
  now?: () => number;
  invitationOptions?: InvitationOptions;
}

type PublishResult =
  | { kind: 'ok' }
  | { kind: 'error'; error: unknown; linkState: InvitationLinkState; at: number; attempt?: number }
  | { kind: 'ended' };

export function notifyCallListeners<T>(listeners: Iterable<(event: T) => void>, event: T): void {
  for (const listener of [...listeners]) {
    try { void Promise.resolve(listener(event)).catch(() => undefined); }
    catch { /* External listeners cannot interrupt state commits or cleanup. */ }
  }
}

export function classifyPublishFailure(error: unknown, linkState: InvitationLinkState): CallFinishReason {
  const details = callErrorDetails(error);
  const code = Number(details.code);
  if ([-11033, -11035, -11036].includes(code)
    || /(?:target|peer|receiver|user).*(?:offline|not online)|(?:目标|对端|接收方).*离线/i.test(details.message)) return 'PEER_OFFLINE';
  if (linkState !== 'connected') return 'LOCAL_NETWORK_ERROR';
  if (code === -11026 || /timeout|timed out|超时/i.test(details.message)) return 'PUBLISH_TIMEOUT';
  return 'PUBLISH_FAILED';
}

const DEFAULTS: Required<InvitationOptions> = {
  maxRetries: 2, retryIntervalMs: 2_000, sendTimeoutMs: 30_000,
  callerInvitationExpireMs: 30_000, calleeInvitationExpireMs: 30_000,
};

function resolveOptions(value: InvitationOptions = {}): Required<InvitationOptions> {
  const result = { ...DEFAULTS, ...value };
  for (const [key, number] of Object.entries(result)) {
    if (!Number.isFinite(number) || !Number.isInteger(number) || number < (key === 'maxRetries' ? 0 : 1)) {
      throw new Error('邀请配置 ' + key + ' 无效');
    }
  }
  return result;
}

/** A reusable signaling instance: one call identity, no media or application dependencies. */
export class CallInvitation {
  readonly callId: string;
  readonly role: InvitationRole;
  private snapshot: CallInvitationSnapshot;
  private readonly now: () => number;
  private readonly config: Required<InvitationOptions>;
  private readonly listeners = new Set<() => void>();
  private readonly stateListeners = new Set<(event: InvitationStateChangedEvent) => void>();
  private readonly errorListeners = new Set<(event: InvitationOperationError) => void>();
  private readonly eventQueue: InvitationStateChangedEvent[] = [];
  private readonly activeWaiters = new Set<() => void>();
  private readonly notificationWaiters = new Set<() => void>();
  private notifying = false;
  private stopped = false;
  private sequence = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryRelease: (() => void) | undefined;
  private nextRetryAt = 0;
  private lastFailure: Extract<PublishResult, { kind: 'error' }> | undefined;
  private invitePending = false;
  private ackReplayUntil = 0;

  constructor(private readonly options: CallInvitationOptions) {
    this.config = resolveOptions(options.invitationOptions);
    this.now = options.now ?? Date.now;
    this.callId = options.callId;
    this.role = options.role;
    this.snapshot = {
      callId: options.callId, role: options.role, localUid: options.localUid, remoteUid: options.remoteUid,
      state: options.role === 'CALLER' ? Caller.IDLE : Callee.IDLE, ended: false,
      extra: options.extra ?? '', remoteExtra: options.remoteExtra ?? '',
      startTs: 0, endTs: 0, publishing: false,
    };
  }

  getSnapshot = (): CallInvitationSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  on(event: 'stateChanged', listener: (event: InvitationStateChangedEvent) => void): () => void;
  on(event: 'operationError', listener: (event: InvitationOperationError) => void): () => void;
  on(event: 'stateChanged' | 'operationError', listener: ((event: InvitationStateChangedEvent) => void) | ((event: InvitationOperationError) => void)): () => void {
    if (event === 'stateChanged') {
      const typed = listener as (event: InvitationStateChangedEvent) => void;
      this.stateListeners.add(typed);
      return () => { this.stateListeners.delete(typed); };
    }
    const typed = listener as (event: InvitationOperationError) => void;
    this.errorListeners.add(typed);
    return () => { this.errorListeners.delete(typed); };
  }

  async start(): Promise<void> {
    if (this.stopped || this.snapshot.ended) throw new Error('邀请实例已结束');
    if (this.role !== 'CALLER' || this.snapshot.state !== Caller.IDLE) return;
    this.setWindow(this.config.sendTimeoutMs);
    this.commit(Caller.SENT_TO_CALLEE);
    if (this.snapshot.ended || this.stopped) return;
    if (this.options.getLinkState() !== 'connected') {
      this.commit(Caller.FAILURE, { reason: 'LOCAL_NETWORK_ERROR', linkStateAtFailure: this.options.getLinkState() });
      return;
    }
    let attempt = 0;
    while (!this.snapshot.ended && !this.stopped && !this.checkDeadline()) {
      if (this.options.getLinkState() !== 'connected') {
        await this.waitForRetry();
        continue;
      }
      this.invitePending = true;
      const result = await this.publishActive('CALL_KIT_INVITE');
      if (this.snapshot.ended || this.stopped || this.checkDeadline() || result.kind === 'ended') {
        this.invitePending = false;
        return;
      }
      this.invitePending = false;
      if (result.kind === 'ok') {
        this.setWindow(this.config.callerInvitationExpireMs);
        this.commit(Caller.RECEIVED_BY_CALLEE, { publishing: false });
        return;
      }
      this.lastFailure = { ...result, attempt: attempt + 1 };
      this.setPublishing(false);
      if (this.snapshot.ended || this.stopped) return;
      if (attempt++ >= this.config.maxRetries) {
        this.failSend('RETRY_EXHAUSTED', this.lastFailure);
        return;
      }
      await this.waitForRetry();
    }
  }

  receive(): void {
    if (this.stopped || this.role !== 'CALLEE' || this.snapshot.state !== Callee.IDLE) return;
    this.setWindow(this.config.calleeInvitationExpireMs);
    this.commit(Callee.INVITATION_RECEIVED);
  }

  async accept(extra = this.snapshot.extra): Promise<void> {
    if (this.role === 'CALLEE' && this.snapshot.state === Callee.IDLE) this.receive();
    if (this.stopped || this.role !== 'CALLEE' || this.snapshot.ended || this.checkDeadline()
      || this.snapshot.state !== Callee.INVITATION_RECEIVED || this.snapshot.publishing) return;
    this.snapshot = { ...this.snapshot, extra };
    const result = await this.publishActive('CALL_KIT_ACCEPT', 'accepted');
    if (this.stopped || this.snapshot.ended || this.checkDeadline() || result.kind === 'ended') return;
    if (result.kind === 'error') {
      this.setPublishing(false);
      this.reportError('ACCEPT', result);
      throw result.error;
    }
    this.commit(Callee.ACCEPT_SENT_TO_CALLER, { publishing: false });
  }

  async refuse(extra = this.snapshot.extra): Promise<void> {
    if (this.role === 'CALLEE' && this.snapshot.state === Callee.IDLE) this.receive();
    if (this.stopped || this.role !== 'CALLEE' || this.snapshot.ended || this.checkDeadline()
      || this.snapshot.state !== Callee.INVITATION_RECEIVED || this.snapshot.publishing) return;
    this.commit(Callee.REFUSED, { extra });
    await this.publishNotification('CALL_KIT_REFUSE', undefined, extra);
  }

  async cancel(extra = this.snapshot.extra): Promise<void> {
    if (this.stopped || this.role !== 'CALLER' || this.snapshot.ended || this.checkDeadline()
      || (this.snapshot.state !== Caller.SENT_TO_CALLEE && this.snapshot.state !== Caller.RECEIVED_BY_CALLEE)) return;
    this.commit(Caller.CANCELED, { extra });
    await this.publishNotification('CALL_KIT_CANCEL', undefined, extra);
  }

  handleSignal(signal: CallSignal): InvitationMessageOutcome {
    if (this.stopped || signal.callId !== this.callId || signal.senderId !== this.snapshot.remoteUid) {
      return { consumed: false, reason: '邀请身份或对端不匹配' };
    }
    if (this.snapshot.ended) {
      if (this.role === 'CALLER' && this.snapshot.state === Caller.ACCEPTED_BY_CALLEE
        && signal.customType === 'CALL_KIT_ACCEPT' && signal.type === 'accepted' && this.now() < this.ackReplayUntil) {
        this.replyAck();
        return { consumed: true, reason: '重复接听，幂等补发确认' };
      }
      return { consumed: false, reason: '邀请已终结，忽略迟到消息' };
    }
    if (this.checkDeadline()) return { consumed: false, reason: '邀请已超过本地截止' };
    const state = this.snapshot.state;
    if (this.role === 'CALLER') {
      const response = signal.customType === 'CALL_KIT_REFUSE'
        || (signal.customType === 'CALL_KIT_ACCEPT' && signal.type === 'accepted');
      if (state === Caller.RECEIVED_BY_CALLEE && response) {
        if (signal.customType === 'CALL_KIT_REFUSE') {
          this.commit(Caller.REFUSED_BY_CALLEE, { remoteExtra: signal.extra });
          return { consumed: true, reason: '对方拒绝邀请' };
        }
        this.ackReplayUntil = Math.max(this.snapshot.endTs, this.now() + this.config.calleeInvitationExpireMs);
        this.commit(Caller.ACCEPTED_BY_CALLEE, { remoteExtra: signal.extra });
        if (!this.stopped) this.replyAck();
        return { consumed: true, reason: '主叫接受并发送业务 ACK' };
      }
    } else {
      if (signal.customType === 'CALL_KIT_CANCEL' && (state === Callee.INVITATION_RECEIVED || state === Callee.ACCEPT_SENT_TO_CALLER)) {
        this.commit(Callee.CANCELED_BY_CALLER);
        return { consumed: true, reason: '主叫取消邀请' };
      }
      if (signal.customType === 'CALL_KIT_ACCEPT' && signal.type === 'ack') {
        if (state === Callee.ACCEPT_SENT_TO_CALLER) {
          this.commit(Callee.ACCEPTED);
          return { consumed: true, reason: '被叫收到主叫确认，邀请已接受' };
        }
      }
    }
    return { consumed: false, reason: '信令与当前邀请状态不匹配' };
  }

  checkDeadline(): boolean {
    if (this.stopped || this.snapshot.ended || !this.snapshot.endTs || this.now() < this.snapshot.endTs) return false;
    if (this.role === 'CALLER') {
      if (this.snapshot.state === Caller.SENT_TO_CALLEE) {
        this.failSend('SEND_TIMEOUT', this.invitePending ? undefined : this.lastFailure);
      } else if (this.snapshot.state === Caller.RECEIVED_BY_CALLEE) {
        const linkState = this.options.getLinkState();
        this.commit(Caller.FAILURE, {
          reason: linkState === 'connected' ? 'PEER_NO_RESPONSE' : 'LOCAL_NETWORK_ERROR',
          trigger: 'INVITATION_TIMEOUT', ...(linkState === 'connected' ? {} : { linkStateAtFailure: linkState }),
        });
      }
    } else {
      const waitingAck = this.snapshot.state === Callee.ACCEPT_SENT_TO_CALLER;
      this.commit(Callee.FAILURE, {
        reason: waitingAck ? 'ACCEPT_ACK_TIMEOUT' : 'INVITATION_EXPIRE',
        trigger: waitingAck ? 'ACK_TIMEOUT' : 'INVITATION_TIMEOUT',
      });
    }
    return this.snapshot.ended;
  }

  handleLinkStateChange(): void {
    if (this.stopped || this.snapshot.ended || this.checkDeadline()) return;
    if (this.options.getLinkState() === 'failed') this.commit(this.role === 'CALLER' ? Caller.FAILURE : Callee.FAILURE, {
      reason: 'LOCAL_NETWORK_ERROR', trigger: 'LINK_FAILED', linkStateAtFailure: 'failed',
    });
  }

  stop(): void {
    if (this.stopped) return;
    if (!this.snapshot.ended) this.commit(this.role === 'CALLER' ? Caller.FAILURE : Callee.FAILURE, { reason: 'STOPPED', trigger: 'STOPPED' });
    this.stopped = true;
    this.clearTimers();
    for (const release of [...this.notificationWaiters]) release();
    this.notificationWaiters.clear();
    this.listeners.clear();
    this.stateListeners.clear();
    this.errorListeners.clear();
  }

  private setWindow(duration: number): void {
    const startTs = this.now();
    this.snapshot = { ...this.snapshot, startTs, endTs: startTs + duration };
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    if (this.snapshot.ended || this.stopped) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      if (!this.checkDeadline() && !this.snapshot.ended && !this.stopped) this.scheduleExpiry();
    }, Math.min(2_147_483_647, Math.max(0, this.snapshot.endTs - this.now())));
  }

  private waitForRetry(): Promise<void> {
    if (this.snapshot.ended || this.stopped || this.checkDeadline()) return Promise.resolve();
    this.nextRetryAt = this.now() + this.config.retryIntervalMs;
    return new Promise(resolve => {
      const complete = () => { this.retryRelease = undefined; resolve(); };
      this.retryRelease = complete;
      const wake = () => {
        this.retryTimer = undefined;
        if (this.stopped || this.snapshot.ended || this.checkDeadline() || this.now() >= this.nextRetryAt) complete();
        else this.retryTimer = setTimeout(wake, Math.min(2_147_483_647, this.nextRetryAt - this.now()));
      };
      this.retryTimer = setTimeout(wake, Math.min(2_147_483_647, this.config.retryIntervalMs));
    });
  }

  private publishActive(customType: CallSignalType, type?: 'accepted'): Promise<PublishResult> {
    if (this.snapshot.ended || this.stopped || this.checkDeadline()) return Promise.resolve({ kind: 'ended' });
    this.snapshot = { ...this.snapshot, publishing: true };
    notifyCallListeners(this.listeners, undefined);
    if (this.snapshot.ended || this.stopped) return Promise.resolve({ kind: 'ended' });
    return new Promise(resolve => {
      let complete = false;
      const done = (result: PublishResult) => {
        if (complete) return;
        complete = true;
        this.activeWaiters.delete(cancel);
        resolve(result);
      };
      const cancel = () => done({ kind: 'ended' });
      this.activeWaiters.add(cancel);
      let pending: Promise<void>;
      try { pending = this.options.port.publishToUser(this.snapshot.remoteUid, customType,
        JSON.stringify(buildCallSignal({ customType, callId: this.callId, extra: this.snapshot.extra, type }))); }
      catch (error) { pending = Promise.reject(error); }
      void pending.then(() => done({ kind: 'ok' }), error => done({
        kind: 'error', error, linkState: this.options.getLinkState(), at: this.now(),
      }));
    });
  }

  private publishNotification(customType: CallSignalType, type?: 'ack', extra = this.snapshot.extra): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const operation = customType === 'CALL_KIT_ACCEPT' ? 'ACK' : customType === 'CALL_KIT_CANCEL' ? 'CANCEL' : 'REFUSE';
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const startedAt = this.now();
      const endTs = startedAt + this.config.sendTimeoutMs;
      const finish = (error?: unknown, fromSdk = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.notificationWaiters.delete(cancel);
        if (error !== undefined && !this.stopped) {
          const result = { kind: 'error' as const, error, linkState: this.options.getLinkState(), at: this.now() };
          this.reportError(operation, result, fromSdk);
          reject(error);
        } else resolve();
      };
      const cancel = () => finish();
      const check = () => {
        if (this.now() >= endTs) finish(new Error('通知发送超时'));
        else timer = setTimeout(check, Math.min(2_147_483_647, endTs - this.now()));
      };
      this.notificationWaiters.add(cancel);
      timer = setTimeout(check, Math.min(2_147_483_647, this.config.sendTimeoutMs));
      let pending: Promise<void>;
      try { pending = this.options.port.publishToUser(this.snapshot.remoteUid, customType,
        JSON.stringify(buildCallSignal({ customType, callId: this.callId, extra, type }))); }
      catch (error) { pending = Promise.reject(error); }
      const settleFromSdk = (error?: unknown) => {
        if (this.now() >= endTs) finish(new Error('通知发送超时'));
        else finish(error, error !== undefined);
      };
      void pending.then(() => settleFromSdk(), error => settleFromSdk(error));
    });
  }

  private replyAck(): void {
    void this.publishNotification('CALL_KIT_ACCEPT', 'ack').catch(() => undefined);
  }

  private setPublishing(publishing: boolean): void {
    if (this.stopped || this.snapshot.ended || this.snapshot.publishing === publishing) return;
    this.snapshot = { ...this.snapshot, publishing };
    notifyCallListeners(this.listeners, undefined);
  }

  private reportError(operation: InvitationOperationError['operation'], result: Extract<PublishResult, { kind: 'error' }>, fromSdk = true): void {
    if (this.stopped) return;
    const error = callErrorDetails(result.error);
    notifyCallListeners(this.errorListeners, {
      callId: this.callId, role: this.role, operation, error,
      ...(fromSdk ? { sdkError: error } : {}),
      reason: classifyPublishFailure(result.error, result.linkState),
      linkStateAtFailure: result.linkState, timestamp: result.at,
    });
  }

  private failSend(trigger: 'SEND_TIMEOUT' | 'RETRY_EXHAUSTED', result?: Extract<PublishResult, { kind: 'error' }>): void {
    this.commit(Caller.FAILURE, {
      reason: result ? classifyPublishFailure(result.error, result.linkState) : 'SEND_TIMEOUT', trigger,
      ...(result ? {
        sdkError: callErrorDetails(result.error), linkStateAtFailure: result.linkState,
        failureAt: result.at, failureAttempt: result.attempt,
      } : {}),
    });
  }

  private commit(state: InvitationState, fields: Partial<CallInvitationSnapshot> = {}): void {
    const previousState = this.snapshot.state;
    if (this.stopped || this.snapshot.ended || !canTransitionInvitation(this.role, previousState, state)) return;
    this.snapshot = { ...this.snapshot, ...fields, state, ended: isTerminalInvitationState(state) };
    if (this.snapshot.ended) {
      this.snapshot = { ...this.snapshot, publishing: false };
      this.clearTimers();
      for (const release of [...this.activeWaiters]) release();
    }
    this.eventQueue.push({ ...this.snapshot, previousState, sequence: ++this.sequence, timestamp: this.now() });
    if (this.notifying) return;
    this.notifying = true;
    try {
      while (this.eventQueue.length) {
        const event = this.eventQueue.shift()!;
        notifyCallListeners(this.listeners, undefined);
        notifyCallListeners(this.stateListeners, event);
      }
    } finally { this.notifying = false; }
  }

  private clearTimers(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.expiryTimer = undefined;
    this.retryTimer = undefined;
    this.retryRelease?.();
    this.retryRelease = undefined;
  }
}
