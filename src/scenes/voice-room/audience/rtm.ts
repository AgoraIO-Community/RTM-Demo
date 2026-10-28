import type { AppRoomRtmPort } from "../app-rtm";

const MESSAGE_TTL_MS = 15_000;
const ROLE = "audience";

export interface ChannelMetadataResult {
  majorRevision: number;
  metadata: Record<string, { value: string; revision?: number }>;
}

export type VoiceRoomLinkState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export type TraceKind = "api" | "event";

export interface TraceEntry {
  seq: number;
  at: number;
  kind: TraceKind;
  uid: string;
  role: string;
  name: string;
  /** SDK 事件类型，或 publish API 的 `USER` / `MESSAGE` 类型。 */
  eventTag?: string;
  summary?: string;
  durationMs?: number;
  errorCode?: number;
  errorMessage?: string;
}

export interface RtmMessageContext {
  channelName: string;
  channelType: "MESSAGE" | "USER";
  publisher: string;
}

export interface RoomRtmEnvelope {
  schemaVersion: 1;
  messageId: string;
  type: string;
  roomId: string;
  targetUserId?: string;
  sentAt: number;
  expiresAt: number;
  payload: Record<string, unknown>;
}

export interface RtmEventConsumption {
  summary?: string;
  /** Defers business consumption until after the event trace is recorded. */
  consume?: () => void | Promise<void>;
}

export interface AudienceRtmEventObserver {
  /** Records one accepted SDK event in the Audience trace stream. */
  record(name: string, summary?: string, eventTag?: string): void;
  /** Reports an event-consumption error to the Audience business store. */
  reportError(error: unknown): void;
}

export interface AudienceRtmEventBinding {
  /** Binds the current Audience event listeners and returns their cleanup function. */
  bind(observer: AudienceRtmEventObserver): () => void;
}

export interface AudienceRoomRtmSession {
  /** Returns the already-logged-in page-level RTM operation port. */
  getRoomPort(): AppRoomRtmPort;
}

export interface AudienceRoomRtmOptions {
  roomId: string;
  userId: string;
  session: AudienceRoomRtmSession;
  events: AudienceRtmEventBinding;
  /** Resolves a UID for readable API trace summaries. */
  describeUser(userId: string): string | undefined;
  /** Receives normalized asynchronous event-consumption errors. */
  onError?(message: string): void;
  /** Supplies Unix timestamps for envelopes, trace ordering, and deterministic tests. */
  now?: () => number;
  /** Supplies a monotonic high-resolution clock for API durations. */
  monotonicNow?: () => number;
}

/** Returns true when a value is a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Creates a unique message ID for one outbound RTM envelope. */
function newMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Extracts a numeric SDK error code when the thrown value exposes one. */
function sdkErrorCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.errorCode ?? error.code;
  return typeof code === "number" ? code : undefined;
}

/** Converts an unknown failure into the user-facing RTM error message. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    const detail = [error.reason, error.message]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .trim();
    if (detail) return detail;
  }
  return "RTM 操作失败";
}

/** Formats primitive object fields as a compact key=value trace summary. */
function keyValueSummary(state: Record<string, unknown>): string {
  return Object.entries(state)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

/** Formats every Presence write field, including displayName, for API traces. */
function presenceStateSummary(state: Record<string, unknown>): string {
  return keyValueSummary(state);
}

/** Abbreviates the voice-room channel while preserving its recognizable prefix and suffix. */
function describeChannel(channelName: string): string {
  if (!channelName.startsWith("voice-room-") || channelName.length <= 24) return channelName;
  return `voice-room-...-${channelName.slice(-4)}`;
}

/** Formats the seat carried by a message payload for readable API traces. */
function messagePayloadSummary(payload: Record<string, unknown>): string {
  if (typeof payload.seatId !== "string") return "";
  const index = Number(payload.seatId.replace("seat-", ""));
  return Number.isInteger(index) ? ` ${index + 1}号麦` : "";
}

/** Provides the Audience's atomic RTM operations without owning business state. */
export class AudienceRoomRtm {
  private readonly port: AppRoomRtmPort;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly traces: TraceEntry[] = [];
  private readonly traceListeners = new Set<() => void>();
  private traceSnapshot: readonly TraceEntry[] | undefined;
  private traceSeq = 0;
  private subscriptionGeneration = 0;
  private subscribed = false;
  private unbindEvents: (() => void) | undefined;

  /** Captures the logged-in port and the clock used by this Audience instance. */
  constructor(private readonly options: AudienceRoomRtmOptions) {
    this.port = options.session.getRoomPort();
    this.now = options.now ?? (() => Date.now());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  /** Binds Audience events and subscribes to room Message, Presence, and Metadata. */
  async subscribeRoom(): Promise<void> {
    if (this.subscribed) return;
    const generation = ++this.subscriptionGeneration;
    this.unbindEvents?.();
    this.unbindEvents = this.options.events.bind({
      record: (name, summary, eventTag) => this.recordEvent(name, summary, eventTag),
      reportError: (error) => this.reportError(error),
    });
    try {
      await this.track("rtm.subscribe", describeChannel(this.options.roomId), () =>
        this.port.subscribe(this.options.roomId, {
          withMessage: true,
          withPresence: true,
          withMetadata: true,
          withLock: false,
        }),
      );
      if (generation !== this.subscriptionGeneration) {
        await this.safeUnsubscribe();
        throw new Error("RTM 订阅已取消");
      }
      this.subscribed = true;
    } catch (error) {
      if (generation === this.subscriptionGeneration) {
        this.unbindEvents?.();
        this.unbindEvents = undefined;
      }
      throw error;
    }
  }

  /** Unsubscribes the room and detaches the current Audience event binding. */
  async unsubscribeRoom(): Promise<void> {
    const hadSubscription = this.subscribed;
    this.subscriptionGeneration += 1;
    this.subscribed = false;
    try {
      if (hadSubscription) {
        await this.track("rtm.unsubscribe", describeChannel(this.options.roomId), () =>
          this.port.unsubscribe(this.options.roomId),
        );
      }
    } finally {
      this.unbindEvents?.();
      this.unbindEvents = undefined;
    }
  }

  /** Publishes the Audience nickname to Presence without a pre-seat muted value. */
  async initializeMemberState(displayName: string): Promise<void> {
    await this.setPresenceState({ displayName });
  }

  /** Marks the seated Audience microphone as voluntarily muted in Presence. */
  async muteMicrophone(): Promise<void> {
    await this.setPresenceState({ muted: "true" });
  }

  /** Marks the seated Audience microphone as voluntarily unmuted in Presence. */
  async unmuteMicrophone(): Promise<void> {
    await this.setPresenceState({ muted: "false" });
  }

  /** Reports a confirmed local microphone-capture failure through Presence. */
  async reportMicrophoneError(): Promise<void> {
    await this.setPresenceState({ microphoneError: "true" });
  }

  /** Clears the Audience microphone-capture error after recovery. */
  async clearMicrophoneError(): Promise<void> {
    await this.setPresenceState({ microphoneError: "false" });
  }

  /** Removes seat-only Presence fields after the Audience leaves a seat. */
  async clearSeatMediaState(): Promise<void> {
    await this.removePresenceState(["muted", "microphoneError"]);
  }

  /** Sends a targeted seat.request message to the Host. */
  async requestSeat(
    hostUserId: string,
    request: { requestId: string; seatId: string },
  ): Promise<void> {
    await this.publishToUser(hostUserId, "seat.request", request);
  }

  /** Tells the Host that this Audience accepted a seat invitation. */
  async acceptSeatInvitation(
    hostUserId: string,
    invitationId: string,
    seatId: string,
  ): Promise<void> {
    await this.publishToUser(hostUserId, "seat.invitation.accepted", {
      invitationId,
      seatId,
    });
  }

  /** Tells the Host that this Audience rejected a seat invitation. */
  async rejectSeatInvitation(hostUserId: string, invitationId: string): Promise<void> {
    await this.publishToUser(hostUserId, "seat.invitation.rejected", { invitationId });
  }

  /** Tells the Host that this Audience is leaving its assigned seat. */
  async leaveSeat(hostUserId: string, seatId: string): Promise<void> {
    await this.publishToUser(hostUserId, "seat.left", { seatId });
  }

  /** Broadcasts one plain-text chat message to the room channel. */
  async sendChatMessage(text: string): Promise<void> {
    await this.publishToRoom("chat.message", { value: text });
  }

  /** Broadcasts the fixed gift interaction to the room channel. */
  async sendGiftMessage(): Promise<void> {
    await this.publishToRoom("gift.sent", { value: "🎁" });
  }

  /** Broadcasts the fixed heart reaction to the room channel. */
  async sendHeartMessage(): Promise<void> {
    await this.publishToRoom("emoji.reaction", { value: "❤️" });
  }

  /** Returns the memoized read-only snapshot of Audience RTM traces. */
  getTraces(): readonly TraceEntry[] {
    this.traceSnapshot ??= this.traces.map((entry) => ({ ...entry }));
    return this.traceSnapshot;
  }

  /** Subscribes to Audience trace changes and returns an unsubscribe function. */
  subscribeTraces(listener: () => void): () => void {
    this.traceListeners.add(listener);
    return () => this.traceListeners.delete(listener);
  }

  /** Clears Audience traces only when the user explicitly requests it. */
  clearTraces(): void {
    this.traces.length = 0;
    this.notifyTraces();
  }

  /** Performs one incremental Presence state write with API tracing. */
  private async setPresenceState(state: Record<string, string>): Promise<void> {
    await this.track("presence.setState", `${describeChannel(this.options.roomId)}: ${presenceStateSummary(state)}`, () =>
      this.port.setPresenceState(this.options.roomId, state),
    );
  }

  /** Removes selected Presence keys with API tracing. */
  private async removePresenceState(keys: readonly string[]): Promise<void> {
    await this.track("presence.removeState", `${describeChannel(this.options.roomId)}: ${keys.join(", ")}`, () =>
      this.port.removePresenceState(this.options.roomId, keys),
    );
  }

  /** Wraps and publishes one targeted USER-channel message. */
  private async publishToUser(
    userId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const envelope = this.createEnvelope(type, payload, userId);
    await this.track(
      "rtm.publish",
      `to ${this.describeUser(userId)} ${type}${messagePayloadSummary(payload)}`,
      () => this.port.publish(userId, JSON.stringify(envelope), "USER"),
      "USER",
    );
  }

  /** Wraps and publishes one room MESSAGE-channel broadcast. */
  private async publishToRoom(type: string, payload: Record<string, unknown>): Promise<void> {
    const envelope = this.createEnvelope(type, payload);
    await this.track(
      "rtm.publish",
      `${describeChannel(this.options.roomId)}: to ALL ${type}`,
      () => this.port.publish(this.options.roomId, JSON.stringify(envelope), "MESSAGE"),
      "MESSAGE",
    );
  }

  /** Builds the versioned, targeted, and expiring wire envelope for an outbound message. */
  private createEnvelope(
    type: string,
    payload: Record<string, unknown>,
    targetUserId?: string,
  ): RoomRtmEnvelope {
    const sentAt = this.now();
    return {
      schemaVersion: 1,
      messageId: newMessageId(),
      type,
      roomId: this.options.roomId,
      ...(targetUserId ? { targetUserId } : {}),
      sentAt,
      expiresAt: sentAt + MESSAGE_TTL_MS,
      payload,
    };
  }

  /** Returns the readable Audience trace label for a UID. */
  private describeUser(userId: string): string {
    return this.options.describeUser(userId) ?? "暂无昵称";
  }

  /** Best-effort cleanup for a subscribe operation invalidated by a newer generation. */
  private async safeUnsubscribe(): Promise<void> {
    try {
      await this.port.unsubscribe(this.options.roomId);
    } catch {
      // 取消过期订阅只是回收，不覆盖取消语义。
    }
  }

  /** Normalizes and forwards an asynchronous event-consumption error. */
  private reportError(error: unknown): void {
    this.options.onError?.(errorMessage(error));
  }

  /** Executes one RTM API call and records its duration or failure. */
  private async track<T>(name: string, summary: string, operation: () => Promise<T>, eventTag?: string): Promise<T> {
    const startedAt = this.now();
    const startedMonotonic = this.monotonicNow();
    try {
      const result = await operation();
      this.recordTrace({
        at: startedAt,
        kind: "api",
        name,
        eventTag,
        summary,
        durationMs: Math.max(0, this.monotonicNow() - startedMonotonic),
      });
      return result;
    } catch (error) {
      this.recordTrace({
        at: startedAt,
        kind: "api",
        name,
        eventTag,
        summary,
        durationMs: Math.max(0, this.monotonicNow() - startedMonotonic),
        errorCode: sdkErrorCode(error),
        errorMessage: errorMessage(error),
      });
      this.reportError(error);
      throw error;
    }
  }

  /** Records one accepted SDK event from the Audience event binding. */
  private recordEvent(name: string, summary?: string, eventTag?: string): void {
    this.recordTrace({ at: this.now(), kind: "event", name, summary, eventTag });
  }

  /** Appends one fully attributed entry to the Audience trace stream. */
  private recordTrace(input: Omit<TraceEntry, "seq" | "uid" | "role">): void {
    this.traces.push({ ...input, seq: ++this.traceSeq, uid: this.options.userId, role: ROLE });
    this.notifyTraces();
  }

  /** Invalidates the trace snapshot and notifies all trace subscribers. */
  private notifyTraces(): void {
    this.traceSnapshot = undefined;
    for (const listener of this.traceListeners) listener();
  }
}

/** Creates one Audience RTM operation module for a room role instance. */
export function createAudienceRoomRtm(options: AudienceRoomRtmOptions): AudienceRoomRtm {
  return new AudienceRoomRtm(options);
}
