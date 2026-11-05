import type { RTMEvents } from "agora-rtm";

import type {
  AppRtmEventListeners,
  AppRtmEventSource,
} from "../app-rtm";
import type {
  AudienceRtmEventBinding,
  AudienceRtmEventObserver,
  ChannelMetadataResult,
  RoomRtmEnvelope,
  RtmEventConsumption,
  RtmMessageContext,
  VoiceRoomLinkState,
} from "./rtm";

const DEDUPE_LIMIT = 500;

export interface AudienceRtmEventListeners {
  /** Updates the Audience business store's normalized connection state. */
  onLinkState(state: VoiceRoomLinkState, reason?: string): void;
  /** Describes and defers consumption of one accepted Presence event. */
  onPresence(event: RTMEvents.PresenceEvent): RtmEventConsumption | void;
  /** Describes and defers consumption of one complete room metadata event. */
  onMetadata(result: ChannelMetadataResult, eventType: string): RtmEventConsumption | void;
  /** Describes and defers consumption of one validated room envelope. */
  onMessage(envelope: RoomRtmEnvelope, context: RtmMessageContext): RtmEventConsumption | void;
}

export interface AudienceOnRtmEventOptions {
  roomId: string;
  userId: string;
  source: AppRtmEventSource;
  listeners: AudienceRtmEventListeners;
  /** Supplies the current time for deterministic TTL validation. */
  now?: () => number;
}

/** Returns true when a parsed JSON value is a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when a protocol field is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Maps the SDK link-state event to the business-facing connection state. */
function mapLinkState(event: RTMEvents.LinkStateEvent): VoiceRoomLinkState {
  if (event.currentState === "CONNECTED") return "connected";
  if (event.currentState === "FAILED") return "failed";
  if (event.currentState === "IDLE") return "disconnected";
  if (event.currentState === "DISCONNECTED" || event.currentState === "SUSPENDED") {
    return "reconnecting";
  }
  return event.operation === "AUTO_RECONNECT" ? "reconnecting" : "connecting";
}

/** Binds Audience SDK events, validates protocol context, and invokes store listeners. */
export class AudienceOnRtmEvent implements AudienceRtmEventBinding {
  private readonly now: () => number;
  private readonly acceptedMessages = new Set<string>();

  /** Captures the Audience event source, store listeners, and TTL clock. */
  constructor(private readonly options: AudienceOnRtmEventOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Installs all Audience event listeners on the page-level event source. */
  bind(observer: AudienceRtmEventObserver): () => void {
    return this.options.source.bindRtmEvents(this.eventHandlers(observer));
  }

  /** Creates the complete SDK listener map for the current Audience room binding. */
  private eventHandlers(observer: AudienceRtmEventObserver): AppRtmEventListeners {
    return {
      /** Normalizes link state and forwards it to the Audience store. */
      linkState: (event) => {
        this.options.listeners.onLinkState(mapLinkState(event), event.reasonCode);
      },
      /** Records and consumes Presence events for the current room. */
      presence: (event) => {
        if (!this.isRoomEvent(event.channelName, event.channelType)) return;
        // 语聊房使用实时 Presence 事件和 SNAPSHOT，不需要 INTERVAL 汇总。
        if (event.eventType === "INTERVAL") return;
        const consumption = this.options.listeners.onPresence(event);
        observer.record("presence", consumption?.summary, event.eventType);
        this.consume(consumption, observer);
      },
      /** Records and consumes Channel Metadata events for the current room. */
      storage: (event) => {
        if (!this.isRoomEvent(event.channelName, event.channelType) || event.storageType !== "CHANNEL") return;
        const consumption = this.options.listeners.onMetadata(event.data, event.eventType);
        observer.record("storage", consumption?.summary, event.eventType);
        this.consume(consumption, observer);
      },
      /** Validates, records, and consumes room or targeted messages. */
      message: (event) => {
        if (typeof event.message !== "string") return;
        const context: RtmMessageContext = {
          channelName: event.channelName,
          channelType: event.channelType === "USER" ? "USER" : "MESSAGE",
          publisher: event.publisher,
        };
        if (!this.acceptContext(context)) return;
        const envelope = this.parseEnvelope(event.message, context);
        if (!envelope) return;
        const consumption = this.options.listeners.onMessage(envelope, context);
        if (envelope.type !== "member.kick" && envelope.type !== "member.ban") {
          observer.record("message", consumption?.summary, context.channelType);
        }
        this.consume(consumption, observer);
      },
      /** Records token events and reports WILL_EXPIRE to the store. */
      token: (event) => {
        observer.record("token", undefined, event.eventType);
        if (event.eventType === "WILL_EXPIRE") observer.reportError("RTM Token 即将过期");
      },
    };
  }

  /** Runs deferred business consumption and reports synchronous or async failures. */
  private consume(
    consumption: RtmEventConsumption | void,
    observer: AudienceRtmEventObserver,
  ): void {
    try {
      const result = consumption?.consume?.();
      if (result instanceof Promise) void result.catch((error) => observer.reportError(error));
    } catch (error) {
      observer.reportError(error);
    }
  }

  /** Parses and validates one inbound envelope, including room, target, TTL, and dedupe. */
  private parseEnvelope(
    serialized: string,
    context: RtmMessageContext,
  ): RoomRtmEnvelope | undefined {
    try {
      const value: unknown = JSON.parse(serialized);
      if (!isRecord(value) || value.schemaVersion !== 1 ||
        !isNonEmptyString(value.messageId) || !isNonEmptyString(value.type) ||
        value.roomId !== this.options.roomId || typeof value.sentAt !== "number" ||
        typeof value.expiresAt !== "number" || value.expiresAt <= this.now() ||
        !isRecord(value.payload)) return undefined;
      if (context.channelType === "USER" && value.targetUserId !== this.options.userId) return undefined;
      if (!this.acceptOnce(value.messageId)) return undefined;
      return value as unknown as RoomRtmEnvelope;
    } catch {
      return undefined;
    }
  }

  /** Accepts only this Audience's USER channel or the bound room MESSAGE channel. */
  private acceptContext(context: RtmMessageContext): boolean {
    return context.channelType === "USER"
      ? context.channelName === this.options.userId
      : context.channelName === this.options.roomId;
  }

  /** Accepts a message ID once while bounding the dedupe memory set. */
  private acceptOnce(messageId: string): boolean {
    if (this.acceptedMessages.has(messageId)) return false;
    this.acceptedMessages.add(messageId);
    if (this.acceptedMessages.size > DEDUPE_LIMIT) {
      const oldest = this.acceptedMessages.values().next().value;
      if (oldest) this.acceptedMessages.delete(oldest);
    }
    return true;
  }

  /** Returns true for MESSAGE-channel events emitted by the bound room. */
  private isRoomEvent(channelName: string, channelType: string): boolean {
    return channelType === "MESSAGE" && channelName === this.options.roomId;
  }
}

/** Creates the Audience event-binding module for one room role instance. */
export function createAudienceOnRtmEvent(options: AudienceOnRtmEventOptions): AudienceOnRtmEvent {
  return new AudienceOnRtmEvent(options);
}
