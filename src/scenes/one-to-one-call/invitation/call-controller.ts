import {
  CallInvitation, notifyCallListeners, type CallInvitationOptions, type InvitationOperationError,
  type InvitationRtmPort, type InvitationStateChangedEvent,
} from './call-invitation';
import { createCallId, parseCallSignal, type InvitationMessageEvent } from './call-protocol';
import type { CallSignalType } from './call-protocol';
import {
  type InvitationLinkState, type InvitationMessageOutcome, type InvitationOptions,
  CalleeInvitationState,
} from './call-state';

export interface CallControllerSnapshot {
  callerInvitations: readonly CallInvitation[];
  incomingInvitations: readonly CallInvitation[];
}

interface ControllerEvents {
  incomingInvitation: CallInvitation;
  callerStateChanged: InvitationStateChangedEvent;
  calleeStateChanged: InvitationStateChangedEvent;
  incomingInvitationsChanged: readonly CallInvitation[];
  operationError: InvitationOperationError;
}

export interface CallControllerOptions {
  localUid: string;
  port: InvitationRtmPort;
  getLinkState: () => InvitationLinkState;
  now?: () => number;
  createCallId?: () => string;
  invitationOptions?: InvitationOptions;
  onIncomingInvitationsChanged?: (invitations: readonly CallInvitation[]) => void;
  onCallerStateChanged?: (event: InvitationStateChangedEvent) => void;
  onCalleeStateChanged?: (event: InvitationStateChangedEvent) => void;
}

interface InvitationSdkEvents {
  message: (event: InvitationMessageEvent) => void;
  linkState: (event: { currentState: string; serviceType?: string }) => void;
}

export interface InvitationRtmClient {
  publish(targetUid: string, message: string, options: {
    channelType: 'USER'; customType: CallSignalType; storeInHistory: false;
  }): Promise<unknown>;
  addEventListener(name: 'message', listener: InvitationSdkEvents['message']): void;
  addEventListener(name: 'linkState', listener: InvitationSdkEvents['linkState']): void;
  removeEventListener(name: 'message', listener: InvitationSdkEvents['message']): void;
  removeEventListener(name: 'linkState', listener: InvitationSdkEvents['linkState']): void;
}

export interface InvitationPluginOptions extends Omit<CallControllerOptions, 'localUid' | 'port' | 'getLinkState'> {
  userId: string;
  initialLinkState?: InvitationLinkState;
}

const installedClients = new WeakSet<InvitationRtmClient>();

function validUserId(uid: unknown): uid is string {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 64 && !/[\u0000-\u001f]/.test(uid);
}

function connectionState(state: string): InvitationLinkState {
  if (state === 'CONNECTED') return 'connected';
  if (state === 'CONNECTING') return 'connecting';
  if (state === 'FAILED') return 'failed';
  if (state === 'SUSPENDED' || state === 'DISCONNECTED' || state === 'RECONNECTING') return 'reconnecting';
  return 'disconnected';
}

/** Routes USER messages without owning RTM login, application policy or media. */
export class CallController {
  private readonly options: CallControllerOptions;
  private unbindSdk: (() => void) | undefined;
  private readonly invitations = new Map<string, CallInvitation>();
  private readonly canceledBeforeInvite = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly events: { [Key in keyof ControllerEvents]: Set<(event: ControllerEvents[Key]) => void> } = {
    incomingInvitation: new Set(), callerStateChanged: new Set(), calleeStateChanged: new Set(),
    incomingInvitationsChanged: new Set(), operationError: new Set(),
  };
  private snapshot: CallControllerSnapshot = { callerInvitations: [], incomingInvitations: [] };
  private disposed = false;
  private readonly makeCallId: () => string;

  constructor(rtmClient: InvitationRtmClient, options: InvitationPluginOptions);
  constructor(options: CallControllerOptions);
  constructor(input: CallControllerOptions | InvitationRtmClient, pluginOptions?: InvitationPluginOptions) {
    let client: InvitationRtmClient | undefined;
    let updateConnection: ((state: string) => void) | undefined;
    if (pluginOptions) {
      client = input as InvitationRtmClient;
      if (!client || typeof client.publish !== 'function' || typeof client.addEventListener !== 'function'
        || typeof client.removeEventListener !== 'function') throw new Error('需要传入有效的 RTM Client');
      if (installedClients.has(client)) throw new Error('该 RTM Client 已绑定邀请插件');
      let linkState = pluginOptions.initialLinkState ?? 'connected';
      updateConnection = state => { linkState = connectionState(state); };
      const sdk = client;
      this.options = {
        ...pluginOptions, localUid: pluginOptions.userId,
        getLinkState: () => linkState,
        port: { async publishToUser(targetUid, customType, message) {
          await sdk.publish(targetUid, message, { channelType: 'USER', customType, storeInHistory: false });
        } },
      };
    } else this.options = input as CallControllerOptions;
    if (!validUserId(this.options.localUid)) throw new Error('本端 RTM 用户 ID 无效');
    this.makeCallId = this.options.createCallId ?? (() => createCallId());
    if (client && updateConnection) this.bindSdk(client, updateConnection);
  }

  getSnapshot = (): CallControllerSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  on<Key extends keyof ControllerEvents>(event: Key, listener: (event: ControllerEvents[Key]) => void): () => void {
    this.events[event].add(listener);
    return () => { this.events[event].delete(listener); };
  }

  getInvitation(callId: string): CallInvitation | undefined { return this.invitations.get(callId); }

  createOutgoingInvitation(remoteUid: string, extra = '', options?: InvitationOptions): CallInvitation {
    if (this.disposed) throw new Error('邀请管理器已关闭');
    const target = remoteUid.trim();
    if (!validUserId(target) || target === this.options.localUid) throw new Error('对端 RTM 用户 ID 无效');
    const callId = this.makeCallId();
    if (!/^[0-9A-F]{32}$/.test(callId) || this.invitations.has(callId)) throw new Error('邀请 ID 无效或已使用');
    return this.createInvitation({ callId, role: 'CALLER', remoteUid: target, extra, invitationOptions: options });
  }

  async handleMessage(event: InvitationMessageEvent): Promise<InvitationMessageOutcome> {
    if (this.disposed) return { consumed: false, reason: '邀请管理器已关闭' };
    this.checkDeadlines();
    const parsed = parseCallSignal(event, this.options.localUid);
    if (!parsed.accepted) return { consumed: false, reason: parsed.reason };
    const signal = parsed.signal;
    const current = this.invitations.get(signal.callId);
    if (current) {
      if (current.getSnapshot().remoteUid !== signal.senderId) return { consumed: false, reason: 'callId 对端不匹配' };
      if (signal.customType === 'CALL_KIT_INVITE') {
        const view = current.getSnapshot();
        if (view.role !== 'CALLEE' || view.ended) return { consumed: false, reason: '邀请已存在或终结' };
        return { consumed: true, reason: '重复邀请，保留原状态和截止' };
      }
      return current.handleSignal(signal);
    }
    if (signal.customType === 'CALL_KIT_CANCEL') {
      this.canceledBeforeInvite.add(signal.callId + '\0' + signal.senderId);
      return { consumed: true, reason: '记录先到达的取消，抑制迟到邀请' };
    }
    if (signal.customType !== 'CALL_KIT_INVITE') return { consumed: false, reason: '未找到对应邀请' };
    if (this.canceledBeforeInvite.has(signal.callId + '\0' + signal.senderId)) {
      return { consumed: false, reason: '该邀请已被主叫取消' };
    }
    const invitation = this.createInvitation({
      callId: signal.callId, role: 'CALLEE', remoteUid: signal.senderId, remoteExtra: signal.extra,
    });
    this.emit('incomingInvitation', invitation);
    invitation.receive();
    return { consumed: true, reason: '已创建独立来电邀请' };
  }

  checkDeadlines(): void {
    if (this.disposed) return;
    for (const invitation of [...this.invitations.values()]) invitation.checkDeadline();
  }

  handleLinkStateChange(): void {
    if (this.disposed) return;
    for (const invitation of [...this.invitations.values()]) invitation.handleLinkStateChange();
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.unbindSdk?.();
    this.unbindSdk = undefined;
    for (const invitation of this.invitations.values()) invitation.stop();
    this.snapshot = { callerInvitations: [...this.snapshot.callerInvitations], incomingInvitations: [] };
    this.listeners.clear();
    for (const listeners of Object.values(this.events)) listeners.clear();
    this.canceledBeforeInvite.clear();
    return Promise.resolve();
  }

  private bindSdk(client: InvitationRtmClient, updateConnection: (state: string) => void): void {
    const message: InvitationSdkEvents['message'] = event => {
      void this.handleMessage(event).catch(() => undefined);
    };
    const linkState: InvitationSdkEvents['linkState'] = event => {
      if (event.serviceType === 'STREAM') return;
      updateConnection(event.currentState);
      this.handleLinkStateChange();
    };
    let bound = true;
    const unbind = () => {
      if (!bound) return;
      bound = false;
      installedClients.delete(client);
      try { client.removeEventListener('message', message); }
      catch { /* SDK logout may already have released these listeners. */ }
      try { client.removeEventListener('linkState', linkState); }
      catch { /* Cleanup must continue without touching another module's callbacks. */ }
    };
    installedClients.add(client);
    this.unbindSdk = unbind;
    try {
      client.addEventListener('message', message);
      client.addEventListener('linkState', linkState);
    } catch (error) {
      unbind();
      this.unbindSdk = undefined;
      throw error;
    }
  }

  private createInvitation(input: Pick<CallInvitationOptions, 'callId' | 'role' | 'remoteUid' | 'extra' | 'remoteExtra' | 'invitationOptions'>): CallInvitation {
    const invitation = new CallInvitation({
      ...input, localUid: this.options.localUid, port: this.options.port, getLinkState: this.options.getLinkState,
      now: this.options.now, invitationOptions: { ...this.options.invitationOptions, ...input.invitationOptions },
    });
    this.invitations.set(invitation.callId, invitation);
    invitation.subscribe(() => this.refreshSnapshot());
    invitation.on('stateChanged', event => {
      if (this.disposed) return;
      if (event.role === 'CALLER') {
        this.emit('callerStateChanged', event);
        if (this.options.onCallerStateChanged) notifyCallListeners([this.options.onCallerStateChanged], event);
      } else {
        this.emit('calleeStateChanged', event);
        if (this.options.onCalleeStateChanged) notifyCallListeners([this.options.onCalleeStateChanged], event);
      }
    });
    invitation.on('operationError', event => { if (!this.disposed) this.emit('operationError', event); });
    this.refreshSnapshot();
    return invitation;
  }

  private refreshSnapshot(): void {
    if (this.disposed) return;
    const previous = this.snapshot.incomingInvitations;
    const values = [...this.invitations.values()];
    const incomingInvitations = values.filter(invitation => {
      const view = invitation.getSnapshot();
      return view.role === 'CALLEE' && !view.ended && view.state !== CalleeInvitationState.IDLE;
    }).sort((a, b) => b.getSnapshot().startTs - a.getSnapshot().startTs);
    this.snapshot = {
      callerInvitations: values.filter(invitation => invitation.getSnapshot().role === 'CALLER'),
      incomingInvitations,
    };
    notifyCallListeners(this.listeners, undefined);
    if (previous.length !== incomingInvitations.length || previous.some((item, i) => item !== incomingInvitations[i])) {
      this.emit('incomingInvitationsChanged', incomingInvitations);
      if (this.options.onIncomingInvitationsChanged) notifyCallListeners([this.options.onIncomingInvitationsChanged], incomingInvitations);
    }
  }

  private emit<Key extends keyof ControllerEvents>(event: Key, value: ControllerEvents[Key]): void {
    notifyCallListeners(this.events[event], value);
  }
}
