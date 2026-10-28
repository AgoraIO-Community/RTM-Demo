import {
  Invitation, type CallInvitation, type CallInvitationSnapshot,
  type InvitationMessageEvent, type InvitationMessageOutcome, type InvitationOptions,
  type InvitationOperationError, type InvitationStateChangedEvent,
} from './invitation/index';
import type { CallRtmLinkState, CallRtmPort } from './app-rtm';

export { AppCallRtmSession } from './app-rtm';
export type { CallMessageOutcome, CallRtmClient, CallRtmClientFactory, CallRtmLinkState, CallRtmPort } from './app-rtm';
export { CallerInvitationState, CalleeInvitationState } from './invitation/index';
export type {
  CallInvitationSnapshot, InvitationOptions, InvitationState, InvitationRole, InvitationLinkState,
  CallFinishReason, InvitationTrigger, InvitationStateChangedEvent, InvitationOperationError,
  InvitationMessageEvent, CallSignalType,
} from './invitation/index';

export interface CallRtmSession {
  getCallPort(): CallRtmPort;
  getCurrentLinkState(): CallRtmLinkState;
}

export interface CallRtmOptions {
  userId: string;
  session: CallRtmSession;
  invitationOptions?: InvitationOptions;
  now?: () => number;
  createCallId?: () => string;
}

export interface RtmInvitation {
  readonly callId: string;
  getSnapshot(): Readonly<CallInvitationSnapshot>;
  subscribe(listener: () => void): () => void;
}

export interface CallRtmSnapshot {
  callerInvitations: readonly RtmInvitation[];
  incomingInvitations: readonly RtmInvitation[];
}

interface CallRtmEvents {
  incomingInvitation: RtmInvitation;
  incomingInvitationsChanged: readonly RtmInvitation[];
  callerStateChanged: InvitationStateChangedEvent;
  calleeStateChanged: InvitationStateChangedEvent;
  operationError: InvitationOperationError;
}

function notify<T>(listeners: Iterable<(event: T) => void>, event: T): void {
  for (const listener of [...listeners]) {
    try { void Promise.resolve(listener(event)).catch(() => undefined); }
    catch { /* App callbacks cannot interrupt signaling or the next observer. */ }
  }
}

/** Scene signaling interface: the App owns media and sees only read-only invitation views. */
export class CallRtm {
  private readonly plugin: Invitation;
  private readonly views = new Map<string, RtmInvitation>();
  private readonly listeners = new Set<() => void>();
  private readonly events: { [Key in keyof CallRtmEvents]: Set<(event: CallRtmEvents[Key]) => void> } = {
    incomingInvitation: new Set(), incomingInvitationsChanged: new Set(), callerStateChanged: new Set(),
    calleeStateChanged: new Set(), operationError: new Set(),
  };
  private readonly subscriptions: Array<() => void>;
  private snapshot: CallRtmSnapshot = { callerInvitations: [], incomingInvitations: [] };
  private disposed = false;

  constructor(options: CallRtmOptions) {
    this.plugin = new Invitation({
      localUid: options.userId,
      port: options.session.getCallPort(),
      getLinkState: () => options.session.getCurrentLinkState(),
      invitationOptions: options.invitationOptions,
      now: options.now, createCallId: options.createCallId,
    });
    this.subscriptions = [
      this.plugin.subscribe(() => this.refresh()),
      this.plugin.on('incomingInvitation', invitation => this.emit('incomingInvitation', this.view(invitation))),
      this.plugin.on('incomingInvitationsChanged', invitations => this.emit('incomingInvitationsChanged', invitations.map(invitation => this.view(invitation)))),
      this.plugin.on('callerStateChanged', event => this.emit('callerStateChanged', event)),
      this.plugin.on('calleeStateChanged', event => this.emit('calleeStateChanged', event)),
      this.plugin.on('operationError', event => this.emit('operationError', event)),
    ];
  }

  getSnapshot = (): CallRtmSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  on<Key extends keyof CallRtmEvents>(event: Key, listener: (event: CallRtmEvents[Key]) => void): () => void {
    this.events[event].add(listener);
    return () => { this.events[event].delete(listener); };
  }

  createOutgoingInvitation(remoteUid: string, extra = '', options?: InvitationOptions): RtmInvitation {
    return this.view(this.plugin.createOutgoingInvitation(remoteUid, extra, options));
  }

  sendCallInvitation(callId: string): Promise<void> { return this.requireInvitation(callId).start(); }
  acceptCallInvitation(callId: string, extra?: string): Promise<void> { return this.requireInvitation(callId).accept(extra); }
  refuseCallInvitation(callId: string, extra?: string): Promise<void> { return this.requireInvitation(callId).refuse(extra); }
  cancelCallInvitation(callId: string, extra?: string): Promise<void> { return this.requireInvitation(callId).cancel(extra); }

  getInvitation(callId: string): RtmInvitation | undefined {
    const invitation = this.plugin.getInvitation(callId);
    return invitation ? this.view(invitation) : undefined;
  }

  handleMessage(event: InvitationMessageEvent): Promise<InvitationMessageOutcome> { return this.plugin.handleMessage(event); }
  handleLinkStateChange(): void { this.plugin.handleLinkStateChange(); }
  checkDeadlines(): void { this.plugin.checkDeadlines(); }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    const stopped = this.plugin.dispose();
    this.snapshot = { callerInvitations: this.snapshot.callerInvitations, incomingInvitations: [] };
    this.listeners.clear();
    for (const listeners of Object.values(this.events)) listeners.clear();
    return stopped;
  }

  private requireInvitation(callId: string): CallInvitation {
    if (this.disposed) throw new Error('呼叫信令已关闭');
    const invitation = this.plugin.getInvitation(callId);
    if (!invitation) throw new Error('未找到呼叫邀请');
    return invitation;
  }

  private view(invitation: CallInvitation): RtmInvitation {
    const existing = this.views.get(invitation.callId);
    if (existing) return existing;
    let previous: CallInvitationSnapshot | undefined;
    let snapshot: Readonly<CallInvitationSnapshot>;
    const view: RtmInvitation = Object.freeze({
      callId: invitation.callId,
      getSnapshot: () => {
        const current = invitation.getSnapshot();
        if (current !== previous) {
          previous = current;
          snapshot = Object.freeze({ ...current, ...(current.sdkError ? { sdkError: Object.freeze({ ...current.sdkError }) } : {}) });
        }
        return snapshot;
      },
      subscribe: invitation.subscribe,
    });
    this.views.set(invitation.callId, view);
    return view;
  }

  private refresh(): void {
    if (this.disposed) return;
    const snapshot = this.plugin.getSnapshot();
    this.snapshot = {
      callerInvitations: snapshot.callerInvitations.map(invitation => this.view(invitation)),
      incomingInvitations: snapshot.incomingInvitations.map(invitation => this.view(invitation)),
    };
    notify(this.listeners, undefined);
  }

  private emit<Key extends keyof CallRtmEvents>(event: Key, value: CallRtmEvents[Key]): void {
    if (!this.disposed) notify(this.events[event], value);
  }
}
