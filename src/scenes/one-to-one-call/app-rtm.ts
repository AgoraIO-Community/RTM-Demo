import AgoraRTM from 'agora-rtm';
import type { RTMConfig, RTMEvents } from 'agora-rtm';

import { createTraceStore, type TraceEntry } from '../../shared/timeline/traceStore';
import type { CallSignalType } from './invitation/call-protocol';
import type { TokenProvider } from '../../shared/utils/token';

export type CallRtmLinkState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

type EventName = 'linkState' | 'message' | 'token';
export interface CallMessageOutcome {
  consumed: boolean;
  reason: string;
}

type EventListeners = {
  linkState?: RTMEvents.RTMClientEventMap['linkState'];
  message?: (event: RTMEvents.MessageEvent) => CallMessageOutcome | Promise<CallMessageOutcome>;
  token?: RTMEvents.RTMClientEventMap['token'];
};
type RegisteredListeners = { [Name in EventName]: RTMEvents.RTMClientEventMap[Name] };

export interface CallRtmClient {
  addEventListener<Name extends EventName>(name: Name, listener: RTMEvents.RTMClientEventMap[Name]): void;
  removeEventListener<Name extends EventName>(name: Name, listener: RTMEvents.RTMClientEventMap[Name]): void;
  login(options?: { token?: string }): Promise<unknown>;
  logout(): Promise<unknown>;
  publish(targetUid: string, message: string, options: {
    channelType: 'USER';
    customType: string;
    storeInHistory: false;
  }): Promise<unknown>;
}

export type CallRtmClientFactory = (appId: string, userId: string, config: RTMConfig) => CallRtmClient;

export interface CallRtmPort {
  publishToUser(targetUid: string, customType: CallSignalType, message: string): Promise<void>;
}

interface Options {
  token?: string;
  getToken?: TokenProvider;
  createClient?: CallRtmClientFactory;
  now?: () => number;
  monotonicNow?: () => number;
}

const defaultFactory: CallRtmClientFactory = (appId, userId, config) =>
  new AgoraRTM.RTM(appId, userId, config) as unknown as CallRtmClient;

function errorFields(error: unknown): Pick<TraceEntry, 'errorCode' | 'errorMessage'> {
  const candidate = error as { errorCode?: unknown; code?: unknown; message?: unknown } | undefined;
  const code = candidate?.errorCode ?? candidate?.code;
  return {
    ...(typeof code === 'number' ? { errorCode: code } : {}),
    ...(error ? { errorMessage: error instanceof Error ? error.message : 'RTM 调用失败' } : {}),
  };
}

function callIdDetail(message: string | Uint8Array): string {
  if (typeof message !== 'string') return '';
  try {
    const payload = JSON.parse(message) as { callId?: unknown; type?: unknown };
    const callId = payload.callId;
    if (typeof callId !== 'string' || !callId) return '';
    const display = callId.length > 12 ? `${callId.slice(0, 8)}…${callId.slice(-4)}` : callId;
    const acceptType = payload.type === 'accepted' || payload.type === 'ack' ? ` · type=${payload.type}` : '';
    return ` · callId=${display}${acceptType}`;
  } catch {
    return '';
  }
}

export class AppCallRtmSession {
  private readonly createClient: CallRtmClientFactory;
  private readonly token: string | undefined;
  private readonly getToken: TokenProvider | undefined;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly traces;
  private client: CallRtmClient | undefined;
  private listeners: RegisteredListeners | undefined;
  private activeListeners: EventListeners | undefined;
  private latestLinkState: RTMEvents.LinkStateEvent | undefined;
  private loginPromise: Promise<CallRtmPort> | undefined;
  private authenticatedLogin: Promise<CallRtmPort> | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();

  constructor(private readonly appId: string, readonly userId: string, options: Options = {}) {
    this.createClient = options.createClient ?? defaultFactory;
    this.token = options.token;
    this.getToken = options.getToken;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.traces = createTraceStore({ uid: userId, role: 'caller' });
  }

  login(): Promise<CallRtmPort> {
    if (this.loginPromise) return this.loginPromise;
    let promise!: Promise<CallRtmPort>;
    promise = this.lifecycleTail.then(async () => {
      const at = this.now();
      const started = this.monotonicNow();
      let client: CallRtmClient | undefined;
      try {
        // RTM 2.3 remembers constructed appId + UID even after logout; retries reuse the client.
        client = this.client ?? this.createClient(this.appId, this.userId, {
          logLevel: 'debug', useStringUserId: true, presenceTimeout: 5,
        });
        this.client = client;
        this.attach(client);
        const token = this.getToken
          ? await this.getToken({ service: 'rtm', appId: this.appId, userId: this.userId }) : this.token;
        await client.login(token ? { token } : {});
        this.authenticatedLogin = promise;
        this.traces.record({ at, kind: 'api', name: 'rtm.login', durationMs: this.monotonicNow() - started });
        return this.port();
      } catch (error) {
        this.traces.record({ at, kind: 'api', name: 'rtm.login', durationMs: this.monotonicNow() - started, ...errorFields(error) });
        if (client) {
          this.detach(client);
          try { await client.logout(); } catch { /* Preserve login failure. */ }
        }
        if (this.loginPromise === promise) this.loginPromise = undefined;
        throw error;
      }
    });
    this.loginPromise = promise;
    this.lifecycleTail = promise.then(() => undefined, () => undefined);
    return promise;
  }

  bindEvents(listeners: EventListeners): () => void {
    this.activeListeners = listeners;
    return () => {
      if (this.activeListeners === listeners) this.activeListeners = undefined;
    };
  }

  getCurrentLinkState(): CallRtmLinkState {
    const event = this.latestLinkState;
    if (!event) return 'disconnected';
    if (event.currentState === 'CONNECTED') return 'connected';
    if (event.currentState === 'FAILED') return 'failed';
    if (event.currentState === 'CONNECTING') return 'connecting';
    if (event.currentState === 'DISCONNECTED' || event.currentState === 'SUSPENDED') return 'reconnecting';
    return 'disconnected';
  }

  getCallPort(): CallRtmPort {
    if (!this.client || !this.loginPromise || this.authenticatedLogin !== this.loginPromise) {
      throw new Error('RTM 尚未登录');
    }
    return this.port();
  }

  getTraces(): readonly TraceEntry[] { return this.traces.getEntries(); }
  subscribeTraces(listener: () => void): () => void { return this.traces.subscribe(listener); }
  clearTraces(): void { this.traces.clear(); }

  logout(): Promise<void> {
    this.loginPromise = undefined;
    this.authenticatedLogin = undefined;
    this.activeListeners = undefined;
    this.latestLinkState = undefined;
    const operation = this.lifecycleTail.then(async () => {
      const client = this.client;
      if (!client) return;
      this.detach(client);
      const at = this.now();
      const started = this.monotonicNow();
      try {
        await client.logout();
        this.traces.record({ at, kind: 'api', name: 'rtm.logout', durationMs: this.monotonicNow() - started });
      } catch (error) {
        this.traces.record({ at, kind: 'api', name: 'rtm.logout', durationMs: this.monotonicNow() - started, ...errorFields(error) });
        throw error;
      }
    });
    this.lifecycleTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private port(): CallRtmPort {
    return {
      publishToUser: async (targetUid, customType, message) => {
        const client = this.client;
        if (!client) throw new Error('RTM 尚未登录');
        const at = this.now();
        const started = this.monotonicNow();
        try {
          await client.publish(targetUid, message, { channelType: 'USER', customType, storeInHistory: false });
          this.traces.record({
            at, kind: 'api', name: 'rtm.publish', eventTag: 'USER',
            summary: `to ${targetUid} ${customType}${callIdDetail(message)}`, durationMs: this.monotonicNow() - started,
          });
        } catch (error) {
          this.traces.record({
            at, kind: 'api', name: 'rtm.publish', eventTag: 'USER',
            summary: `to ${targetUid} ${customType}${callIdDetail(message)}`, durationMs: this.monotonicNow() - started,
            ...errorFields(error),
          });
          throw error;
        }
      },
    };
  }

  private attach(client: CallRtmClient): void {
    const listeners: RegisteredListeners = {
      linkState: (event) => {
        this.traces.record({
          at: event.timestamp || this.now(), kind: 'event', name: 'linkState', eventTag: event.currentState,
          summary: `${event.previousState}→${event.currentState}`,
        });
        if (event.serviceType === 'STREAM') return;
        this.latestLinkState = event;
        this.activeListeners?.linkState?.(event);
      },
      message: (event) => {
        const baseSummary = `from ${event.publisher} ${event.customType}${callIdDetail(event.message)}`;
        const traceSeq = this.traces.record({
          at: this.now(), kind: 'event', name: 'message', eventTag: event.channelType,
          summary: baseSummary,
        });
        const result = this.activeListeners?.message?.(event);
        if (!result) return;
        void Promise.resolve(result).then((outcome) => {
          const status = outcome.consumed ? '已消费' : '已忽略';
          this.traces.update(traceSeq, { summary: `${baseSummary} · ${status}：${outcome.reason}` });
        }).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : '业务处理失败';
          this.traces.update(traceSeq, { summary: `${baseSummary} · 已忽略：${reason}` });
        });
      },
      token: event => this.activeListeners?.token?.(event),
    };
    this.listeners = listeners;
    client.addEventListener('linkState', listeners.linkState);
    client.addEventListener('message', listeners.message);
    client.addEventListener('token', listeners.token);
  }

  private detach(client: CallRtmClient): void {
    if (!this.listeners) return;
    client.removeEventListener('linkState', this.listeners.linkState);
    client.removeEventListener('message', this.listeners.message);
    client.removeEventListener('token', this.listeners.token);
    this.listeners = undefined;
  }
}
