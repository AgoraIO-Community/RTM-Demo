import AgoraRTM from "agora-rtm";
import type { RTMConfig, RTMEvents } from "agora-rtm";
import type { TraceEntry } from "../../shared/timeline/traceStore";
import type { TokenProvider } from "../../shared/utils/token";

type AppEventName =
  | "linkState"
  | "message"
  | "presence"
  | "storage"
  | "token";

export type AppRtmLinkState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export type AppRtmEventListeners = Partial<{
  [EventName in AppEventName]: RTMEvents.RTMClientEventMap[EventName];
}>;

export interface AppRtmEventSource {
  /** Replaces the active role listeners and returns a generation-safe cleanup. */
  bindRtmEvents(listeners: AppRtmEventListeners): () => void;
}

export interface AppRtmClient {
  /** Registers one SDK event listener before login. */
  addEventListener<EventName extends keyof RTMEvents.RTMClientEventMap>(
    eventName: EventName,
    listener: RTMEvents.RTMClientEventMap[EventName],
  ): void;
  /** Removes one previously registered SDK event listener. */
  removeEventListener<EventName extends keyof RTMEvents.RTMClientEventMap>(
    eventName: EventName,
    listener: RTMEvents.RTMClientEventMap[EventName],
  ): void;
  /** Logs the application-scoped RTM client in. */
  login(options?: { token?: string }): Promise<unknown>;
  /** Logs the application-scoped RTM client out. */
  logout(): Promise<unknown>;
  /** Subscribes the client to one Message Channel. */
  subscribe(
    channelName: string,
    options?: {
      withMessage?: boolean;
      withPresence?: boolean;
      withMetadata?: boolean;
      withLock?: boolean;
    },
  ): Promise<unknown>;
  /** Unsubscribes the client from one Message Channel. */
  unsubscribe(channelName: string): Promise<unknown>;
  /** Publishes one USER or MESSAGE channel payload. */
  publish(
    channelName: string,
    message: string,
    options?: { channelType?: "MESSAGE" | "USER" },
  ): Promise<unknown>;
  presence: {
    /** Writes incremental Presence State for the current user. */
    setState(
      channelName: string,
      channelType: "MESSAGE",
      state: Record<string, string>,
    ): Promise<unknown>;
    /** Removes selected Presence State keys for the current user. */
    removeState(
      channelName: string,
      channelType: "MESSAGE",
      options: { states: string[] },
    ): Promise<unknown>;
  };
  storage: {
    /** Reads all Channel Metadata before subscribing for Demo-only admission. */
    getChannelMetadata(
      channelName: string,
      channelType: "MESSAGE",
    ): Promise<{
      majorRevision: number;
      totalCount: number;
      metadata: Record<string, { value: string; revision: number; authorUid?: string; updated?: number }>;
    }>;
    /** Writes one or more Channel Metadata entries. */
    setChannelMetadata(
      channelName: string,
      channelType: "MESSAGE",
      data: Array<{ key: string; value: string; revision?: number }>,
      options?: { majorRevision?: number },
    ): Promise<unknown>;
    /** Removes selected or all Channel Metadata, optionally guarded by its current revision. */
    removeChannelMetadata(
      channelName: string,
      channelType: "MESSAGE",
      options?: { majorRevision?: number },
    ): Promise<unknown>;
  };
}

/** Creates the production, E2E, or test RTM client owned by the application page. */
export type AppRtmClientFactory = (
  appId: string,
  userId: string,
  config: RTMConfig,
) => AppRtmClient;

export interface AppRoomRtmPort {
  /** Subscribes a role to room Message, Presence, and Metadata events. */
  subscribe(
    roomId: string,
    options: {
      withMessage: true;
      withPresence: true;
      withMetadata: true;
      withLock: false;
    },
  ): Promise<unknown>;
  /** Unsubscribes the active role from its room. */
  unsubscribe(roomId: string): Promise<unknown>;
  /** Publishes a serialized role message through the application client. */
  publish(
    channelName: string,
    message: string,
    channelType: "MESSAGE" | "USER",
  ): Promise<unknown>;
  /** Writes incremental Presence State through the application client. */
  setPresenceState(
    roomId: string,
    state: Record<string, string>,
  ): Promise<unknown>;
  /** Removes selected Presence State keys through the application client. */
  removePresenceState(roomId: string, keys: readonly string[]): Promise<unknown>;
  /** Writes authoritative room metadata through the application client. */
  setRoomMetadata(
    roomId: string,
    data: Array<{ key: string; value: string; revision?: number }>,
    majorRevision?: number,
  ): Promise<unknown>;
  /** Clears the actual room metadata after the room has ended. */
  removeRoomMetadata(roomId: string): Promise<unknown>;
}

export interface AppRtmSessionOptions {
  token?: string;
  getToken?: TokenProvider;
  createClient?: AppRtmClientFactory;
  /** Supplies a monotonic high-resolution clock for the login API duration. */
  monotonicNow?: () => number;
}

type RegisteredListeners = {
  [EventName in AppEventName]: RTMEvents.RTMClientEventMap[EventName];
};

/** Creates the real SDK client owned by the application page. */
const defaultClientFactory: AppRtmClientFactory = (
  appId,
  userId,
  config,
) => new AgoraRTM.RTM(appId, userId, config) as unknown as AppRtmClient;

/** Owns the single RTM client for the lifetime of the voice-room application page. */
export class AppRtmSession {
  private readonly createClient: AppRtmClientFactory;
  private readonly token: string | undefined;
  private readonly getToken: TokenProvider | undefined;
  private readonly monotonicNow: () => number;
  private client: AppRtmClient | undefined;
  private listeners: RegisteredListeners | undefined;
  private loginPromise: Promise<AppRoomRtmPort> | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private activeListeners: AppRtmEventListeners | undefined;
  private latestLinkStateEvent: RTMEvents.LinkStateEvent | undefined;
  private handlerGeneration = 0;
  private readonly traces: TraceEntry[] = [];
  private readonly traceListeners = new Set<() => void>();
  private traceSnapshot: readonly TraceEntry[] | undefined;
  private traceSeq = 0;

  private readonly roomPort: AppRoomRtmPort = {
    /** Delegates one room subscription to the owned SDK client. */
    subscribe: (roomId, options) => this.requireClient().subscribe(roomId, options),
    /** Delegates one room unsubscribe to the owned SDK client. */
    unsubscribe: (roomId) => this.requireClient().unsubscribe(roomId),
    /** Delegates one serialized role publish to the owned SDK client. */
    publish: (channelName, message, channelType) =>
      this.requireClient().publish(channelName, message, { channelType }),
    /** Delegates an incremental Presence write to the owned SDK client. */
    setPresenceState: (roomId, state) =>
      this.requireClient().presence.setState(roomId, "MESSAGE", state),
    /** Delegates a Presence key removal to the owned SDK client. */
    removePresenceState: (roomId, keys) =>
      this.requireClient().presence.removeState(roomId, "MESSAGE", { states: [...keys] }),
    /** Delegates cleanup without opening another RTM client or subscription. */
    removeRoomMetadata: roomId => this.requireClient().storage.removeChannelMetadata(roomId, "MESSAGE"),
    /** Delegates a Channel Metadata write to the owned SDK client. */
    setRoomMetadata: (roomId, data, majorRevision) =>
      this.requireClient().storage.setChannelMetadata(
        roomId,
        "MESSAGE",
        data,
        majorRevision === undefined ? undefined : { majorRevision },
      ),
  };

  /** Creates the application-lifetime RTM owner for one page UID. */
  constructor(
    private readonly appId: string,
    readonly userId: string,
    options: AppRtmSessionOptions = {},
  ) {
    this.createClient = options.createClient ?? defaultClientFactory;
    this.token = options.token;
    this.getToken = options.getToken;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  /** Registers SDK listeners, logs in once, and returns the reusable room port. */
  login(): Promise<AppRoomRtmPort> {
    if (this.loginPromise) return this.loginPromise;

    let pending!: Promise<AppRoomRtmPort>;
    pending = this.lifecycleTail.then(async () => {
      const startedAt = Date.now();
      const startedMonotonic = this.monotonicNow();
      let client: AppRtmClient | undefined;
      try {
        // RTM 2.3 remembers constructed appId + UID even after logout; retries reuse the client.
        client = this.client ?? this.createClient(this.appId, this.userId, {
          logLevel: "debug",
          useStringUserId: true,
          presenceTimeout: 5,
        });
        this.client = client;
        this.latestLinkStateEvent = undefined;
        this.attachListeners(client);
        const token = this.getToken
          ? await this.getToken({ service: "rtm", appId: this.appId, userId: this.userId }) : this.token;
        await client.login(token == null ? {} : { token });
        this.recordLoginTrace(startedAt, startedMonotonic);
        return this.roomPort;
      } catch (error: unknown) {
        this.recordLoginTrace(startedAt, startedMonotonic, error);
        if (client) {
          if (this.client === client) {
            this.detachListeners(client);
            this.latestLinkStateEvent = undefined;
          }
          try {
            await client.logout();
          } catch {
            // 登录失败后的清理不得覆盖最初错误。
          }
        }
        if (this.loginPromise === pending) this.loginPromise = undefined;
        throw error;
      }
    });
    this.loginPromise = pending;
    this.lifecycleTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  /** Returns the reusable room port after application login has started. */
  getRoomPort(): AppRoomRtmPort {
    if (!this.client || !this.loginPromise) {
      throw new Error("RTM 尚未登录");
    }
    return this.roomPort;
  }

  /** Metadata-only directory seam. The same owned SDK client also serves the actual room. */
  getDirectoryPort() {
    return {
      read: (nameKey: string) => this.requireClient().storage.getChannelMetadata(nameKey, 'MESSAGE'),
      write: (nameKey: string, value: string, majorRevision: number) => this.requireClient().storage.setChannelMetadata(
        nameKey, 'MESSAGE', [{ key: 'entry', value }], { majorRevision },
      ),
      remove: (nameKey: string, majorRevision: number) => this.requireClient().storage.removeChannelMetadata(
        nameKey, 'MESSAGE', { majorRevision },
      ),
    };
  }

  /** Maps the latest SDK link-state event to the application connection state. */
  getCurrentLinkState(): AppRtmLinkState {
    const event = this.latestLinkStateEvent;
    if (!event) return "disconnected";
    if (event.currentState === "CONNECTED") return "connected";
    if (event.currentState === "FAILED") return "failed";
    if (event.currentState === "IDLE") return "disconnected";
    if (event.currentState === "DISCONNECTED" || event.currentState === "SUSPENDED") {
      return "reconnecting";
    }
    return event.operation === "AUTO_RECONNECT" ? "reconnecting" : "connecting";
  }

  /** Returns the memoized read-only application trace snapshot. */
  getTraces(): readonly TraceEntry[] {
    this.traceSnapshot ??= this.traces.map((entry) => ({ ...entry }));
    return this.traceSnapshot;
  }

  /** Subscribes to application trace changes and returns a cleanup function. */
  subscribeTraces(listener: () => void): () => void {
    this.traceListeners.add(listener);
    return () => this.traceListeners.delete(listener);
  }

  /** Clears application traces only after an explicit user action. */
  clearTraces(): void {
    this.traces.length = 0;
    this.notifyTraces();
  }

  /** Switches SDK event delivery to the current Host or Audience binding. */
  bindRtmEvents(listeners: AppRtmEventListeners): () => void {
    const generation = ++this.handlerGeneration;
    this.activeListeners = listeners;
    return () => {
      if (this.handlerGeneration !== generation) return;
      this.activeListeners = undefined;
    };
  }

  /** Removes SDK listeners and logs out when the application page unmounts. */
  async logout(): Promise<void> {
    this.loginPromise = undefined;
    this.activeListeners = undefined;
    this.latestLinkStateEvent = undefined;
    this.handlerGeneration += 1;
    const operation = this.lifecycleTail.then(async () => {
      const client = this.client;
      if (!client) return;
      this.detachListeners(client);
      await client.logout();
    });
    this.lifecycleTail = operation.then(() => undefined, () => undefined);
    await operation;
  }

  /** Returns the owned client or throws when application login has not started. */
  private requireClient(): AppRtmClient {
    if (!this.client) throw new Error("RTM 尚未登录");
    return this.client;
  }

  /** Records one application login API trace using wall and monotonic clocks. */
  private recordLoginTrace(
    startedAt: number,
    startedMonotonic: number,
    error?: unknown,
  ): void {
    const candidate = error as { errorCode?: unknown; code?: unknown; message?: unknown } | undefined;
    const code = candidate?.errorCode ?? candidate?.code;
    this.traces.push({
      seq: ++this.traceSeq,
      at: startedAt,
      kind: "api",
      uid: this.userId,
      role: "app",
      name: "rtm.login",
      durationMs: Math.max(0, this.monotonicNow() - startedMonotonic),
      ...(typeof code === "number" ? { errorCode: code } : {}),
      ...(error ? { errorMessage: error instanceof Error ? error.message : "RTM 登录失败" } : {}),
    });
    this.notifyTraces();
  }

  /** Invalidates the application trace snapshot and notifies subscribers. */
  private notifyTraces(): void {
    this.traceSnapshot = undefined;
    for (const listener of this.traceListeners) listener();
  }

  /** Records one page-lifetime SDK link-state event. */
  private recordLinkStateTrace(event: RTMEvents.LinkStateEvent): void {
    const reasonCode = String(event.reasonCode ?? "").trim();
    this.traces.push({
      seq: ++this.traceSeq,
      at: event.timestamp || Date.now(),
      kind: "event",
      uid: this.userId,
      role: "app",
      name: "linkState",
      eventTag: event.currentState,
      summary: `${event.previousState}→${event.currentState}${reasonCode ? ` · ${reasonCode}` : ""}`,
    });
    this.notifyTraces();
  }

  /** Registers all SDK listeners before application login. */
  private attachListeners(client: AppRtmClient): void {
    const listeners: RegisteredListeners = {
      /** Records link state before forwarding it to the active role. */
      linkState: (event) => {
        this.latestLinkStateEvent = event;
        this.recordLinkStateTrace(event);
        this.activeListeners?.linkState?.(event);
      },
      /** Forwards messages to the active role binding. */
      message: (event) => this.activeListeners?.message?.(event),
      /** Forwards Presence events to the active role binding. */
      presence: (event) => this.activeListeners?.presence?.(event),
      /** Forwards Storage events to the active role binding. */
      storage: (event) => {
        this.activeListeners?.storage?.(event);
      },
      /** Forwards token events to the active role binding. */
      token: (event) => this.activeListeners?.token?.(event),
    };
    this.listeners = listeners;
    client.addEventListener("linkState", listeners.linkState);
    client.addEventListener("message", listeners.message);
    client.addEventListener("presence", listeners.presence);
    client.addEventListener("storage", listeners.storage);
    client.addEventListener("token", listeners.token);
  }

  /** Removes all SDK listeners during final application logout or failed login cleanup. */
  private detachListeners(client: AppRtmClient): void {
    const listeners = this.listeners;
    if (!listeners) return;
    client.removeEventListener("linkState", listeners.linkState);
    client.removeEventListener("message", listeners.message);
    client.removeEventListener("presence", listeners.presence);
    client.removeEventListener("storage", listeners.storage);
    client.removeEventListener("token", listeners.token);
    this.listeners = undefined;
  }
}
