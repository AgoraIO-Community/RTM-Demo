import type { RTMEvents } from "agora-rtm";

import { createRtcHelper, type RtcHelper } from "../../shared/rtc";
import {
  createAudienceRoomRtm,
  type AudienceRoomRtm,
  type RoomRtmEnvelope,
} from "./audience/rtm";
import { createAudienceOnRtmEvent } from "./audience/onRtmEvent";
import { DEFAULT_ANNOUNCEMENT, SEAT_COUNT } from "./config";
import {
  createHostRoomRtm,
  type ChannelMetadataResult,
  type HostRoomRtm,
  type RtmMessageContext,
  type TraceEntry,
  type VoiceRoomLinkState,
} from "./host/rtm";
import { createHostOnRtmEvent } from "./host/onRtmEvent";
import type { AppRtmSession } from "./app-rtm";

const SEAT_REQUEST_TIMEOUT_MS = 30_000;

export type SingleRoomRole = "host" | "audience";

export interface RoomSeat {
  seatId: string;
  userId: string | null;
  displayName: string | null;
}

export interface RoomSnapshot {
  majorRevision: number;
  hostUserId: string;
  announcement: string;
  seats: Record<string, RoomSeat>;
  forcedMutedUserIds: string[];
}

export interface SingleRoomRequest {
  id: string;
  userId: string;
  displayName: string;
  seatId: string;
  expiresAt: number;
  remainingSeconds: number;
}

export interface SingleRoomInteraction {
  id: string;
  type:
    | "chat"
    | "emoji"
    | "gift"
    | "system-member-joined"
    | "system-member-left"
    | "system-seat-joined"
    | "system-seat-left";
  senderId: string;
  displayName: string;
  value: string;
}

export interface SingleRoomView {
  role: SingleRoomRole;
  roomId: string;
  roomName: string;
  userId: string;
  displayName: string;
  linkState: VoiceRoomLinkState;
  subscribing: boolean;
  snapshot: RoomSnapshot;
  onlineUsers: readonly string[];
  memberNames: Readonly<Record<string, string>>;
  memberMuted: Readonly<Record<string, boolean>>;
  memberMicrophoneErrors: Readonly<Record<string, boolean>>;
  volumes: Readonly<Record<string, number>>;
  queue: readonly SingleRoomRequest[];
  interactions: readonly SingleRoomInteraction[];
  invitation: { id: string; seatId: string } | undefined;
  waitingSeatId: string | undefined;
  ownMuted: boolean;
  error: string | undefined;
  errorVersion: number;
  notice: string | undefined;
  noticeVersion: number;
  hostTemporarilyAway: boolean;
  endedReason: string | undefined;
  roomCleanupError: string | undefined;
  roomMetadataFresh: boolean;
  hasAuthoritativeSnapshot: boolean;
}

export interface SingleRoomClientOptions {
  appId: string;
  roomId: string;
  roomName: string;
  hostUserId: string;
  userId: string;
  displayName: string;
  role: SingleRoomRole;
  session: AppRtmSession;
  createRtc?: () => RtcHelper;
  onBanUser?: (userId: string) => void | Promise<void>;
  onSelfBanned?: () => void;
  onRoomDissolved?: () => void | Promise<void>;
  onRoomCleanup?: () => void | Promise<void>;
  cleanupRetryDelay?: () => Promise<void>;
  now?: () => number;
}

function newId(prefix: string): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function abbreviateUserId(userId: string): string {
  const normalized = userId.trim();
  if (normalized.length <= 10) return normalized;
  return `${normalized.slice(0, 5)}…${normalized.slice(-4)}`;
}

function emptySeats(): Record<string, RoomSeat> {
  return Object.fromEntries(Array.from({ length: SEAT_COUNT }, (_, index) => {
    const seatId = `seat-${index}`;
    return [seatId, { seatId, userId: null, displayName: null }];
  }));
}

export function createInitialRoomSnapshot(
  hostUserId: string,
  hostDisplayName: string | null,
  majorRevision = 0,
): RoomSnapshot {
  const seats = emptySeats();
  seats["seat-0"] = { seatId: "seat-0", userId: hostUserId, displayName: hostDisplayName };
  return {
    majorRevision,
    hostUserId,
    announcement: DEFAULT_ANNOUNCEMENT,
    seats,
    forcedMutedUserIds: [],
  };
}

function parseStringArray(raw: string): string[] | undefined {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) && parsed.every((value) => typeof value === "string")
    ? parsed
    : undefined;
}

function parseSeats(raw: string): Record<string, RoomSeat> | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const result: Record<string, RoomSeat> = {};
  for (const [seatId, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const seat = value as Partial<RoomSeat>;
    if (seat.seatId !== seatId ||
      (seat.userId !== null && typeof seat.userId !== "string") ||
      (seat.displayName !== null && typeof seat.displayName !== "string")) return undefined;
    result[seatId] = { seatId, userId: seat.userId, displayName: seat.displayName };
  }
  return result;
}

export function parseRoomSnapshot(result: ChannelMetadataResult): RoomSnapshot | undefined {
  try {
    const hostUserId = result.metadata.hostUserId?.value;
    const announcement = result.metadata.announcement?.value;
    const seats = result.metadata.seats && parseSeats(result.metadata.seats.value);
    const forcedMutedUserIds = result.metadata.forcedMutedUserIds &&
      parseStringArray(result.metadata.forcedMutedUserIds.value);
    if (!hostUserId || announcement === undefined || !seats || !forcedMutedUserIds) return undefined;
    return { majorRevision: result.majorRevision, hostUserId, announcement, seats, forcedMutedUserIds };
  } catch {
    return undefined;
  }
}

function serializeInitialRoom(snapshot: RoomSnapshot) {
  return [
    { key: "hostUserId", value: snapshot.hostUserId },
    { key: "announcement", value: snapshot.announcement },
    { key: "seats", value: JSON.stringify(snapshot.seats) },
    { key: "forcedMutedUserIds", value: JSON.stringify(snapshot.forcedMutedUserIds) },
  ];
}

export class SingleRoomClient {
  private readonly hostRtm: HostRoomRtm | undefined;
  private readonly audienceRtm: AudienceRoomRtm | undefined;
  private readonly rtc: RtcHelper;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private readonly pendingJoinedUsers = new Set<string>();
  private snapshot: RoomSnapshot;
  private hasAuthoritativeSnapshot = false;
  private subscribePromise?: Promise<void>;
  private leavePromise?: Promise<void>;
  private seatsMutationTail: Promise<void> = Promise.resolve();
  private forcedMuteMutationTail: Promise<void> = Promise.resolve();
  private readonly pendingHostMutations = new Set<Promise<void>>();
  private mediaSyncPromise?: Promise<void>;
  private mediaSyncRequested = false;
  private onlineUsers: readonly string[] = [];
  private memberNames: Readonly<Record<string, string>>;
  private memberMuted: Readonly<Record<string, boolean>>;
  private memberMicrophoneErrors: Readonly<Record<string, boolean>>;
  private volumes: Readonly<Record<string, number>> = {};
  private queue: SingleRoomRequest[] = [];
  private interactions: SingleRoomInteraction[] = [];
  private invitation: { id: string; seatId: string } | undefined;
  private waitingSeatId: string | undefined;
  private ownMuted = false;
  private requestTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly seatRequestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private queueTicker: ReturnType<typeof setInterval> | undefined;
  private linkState: VoiceRoomLinkState = "disconnected";
  private subscribing = false;
  private error: string | undefined;
  private errorVersion = 0;
  private notice: string | undefined;
  private noticeVersion = 0;
  private hostTemporarilyAway = false;
  private endedReason: string | undefined;
  private roomDissolved = false;
  private roomCleanupError: string | undefined;
  private actualRoomCleanupPending = false;
  private directoryCleanupPending = false;
  private roomMetadataFresh = true;
  private readonly pendingGovernance = new Map<string, "member.kick" | "member.ban">();
  private dissolvePromise?: Promise<void>;
  private publishedSeatId: string | undefined;
  private rtcJoined = false;
  private runtimeStarted = false;
  private rtcJoinTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private viewSnapshot: SingleRoomView | undefined;
  private initializationRevision: number | undefined;

  constructor(private readonly options: SingleRoomClientOptions) {
    this.now = options.now ?? (() => Date.now());
    this.linkState = options.session.getCurrentLinkState?.() ?? "disconnected";
    this.snapshot = createInitialRoomSnapshot(
      options.hostUserId,
      options.role === "host" ? options.displayName : null,
    );
    this.memberNames = {};
    this.memberMuted = {};
    this.memberMicrophoneErrors = {};
    this.hostTemporarilyAway = options.role === "audience";
    this.rtc = options.createRtc?.() ?? createRtcHelper();
    this.rtc.registerEvents({
      connection: (state, reason) => { if (state === "failed") this.fail(reason ?? "RTC 连接失败"); },
      remoteAudioPublished: () => undefined,
      remoteAudioUnpublished: () => undefined,
      remoteVideoTrack: () => undefined,
      remoteVideoUnpublished: () => undefined,
      volume: (levels) => { this.volumes = levels; this.publish(); },
    });
    const listeners = {
      onLinkState: (state: VoiceRoomLinkState) => {
        this.linkState = state;
        if (this.options.role === "audience" && state !== "connected") this.roomMetadataFresh = false;
        this.publish();
      },
      onPresence: (event: RTMEvents.PresenceEvent) => ({
        summary: this.describePresenceEvent(event),
        consume: () => this.handlePresenceEvent(event),
      }),
      onMetadata: (result: ChannelMetadataResult, eventType: string) => ({
        summary: this.describeRoomMetadata(result),
        consume: () => this.handleRoomMetadataChanged(result, eventType),
      }),
      onMessage: (envelope: RoomRtmEnvelope, context: RtmMessageContext) => ({
        summary: this.describeMessageEvent(envelope, context),
        consume: () => this.handleMessageEvent(envelope, context),
      }),
    };
    if (options.role === "host") {
      const events = createHostOnRtmEvent({
        roomId: options.roomId,
        userId: options.userId,
        source: options.session,
        listeners,
        now: this.now,
      });
      this.hostRtm = createHostRoomRtm({
        roomId: options.roomId,
        userId: options.userId,
        session: options.session,
        events,
        describeUser: (userId) => this.getMemberDisplayName(userId),
        describeSeats: (seats) => this.describeSeats(seats),
        onError: (message) => this.fail(message),
        now: this.now,
      });
    } else {
      const events = createAudienceOnRtmEvent({
        roomId: options.roomId,
        userId: options.userId,
        source: options.session,
        listeners,
        now: this.now,
      });
      this.audienceRtm = createAudienceRoomRtm({
        roomId: options.roomId,
        userId: options.userId,
        session: options.session,
        events,
        describeUser: (userId) => this.getMemberDisplayName(userId),
        onError: (message) => this.fail(message),
        now: this.now,
      });
    }
  }

  getView(): SingleRoomView {
    this.viewSnapshot ??= {
      role: this.options.role,
      roomId: this.options.roomId,
      roomName: this.options.roomName,
      userId: this.options.userId,
      displayName: this.options.displayName,
      linkState: this.linkState,
      subscribing: this.subscribing,
      snapshot: this.snapshot,
      onlineUsers: this.onlineUsers,
      memberNames: this.memberNames,
      memberMuted: this.memberMuted,
      memberMicrophoneErrors: this.memberMicrophoneErrors,
      volumes: this.volumes,
      queue: this.queue,
      interactions: this.interactions,
      invitation: this.invitation,
      waitingSeatId: this.waitingSeatId,
      ownMuted: this.ownMuted,
      error: this.error,
      errorVersion: this.errorVersion,
      notice: this.notice,
      noticeVersion: this.noticeVersion,
      hostTemporarilyAway: this.hostTemporarilyAway,
      endedReason: this.endedReason,
      roomCleanupError: this.roomCleanupError,
      roomMetadataFresh: this.roomMetadataFresh,
      hasAuthoritativeSnapshot: this.hasAuthoritativeSnapshot,
    };
    return this.viewSnapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getTraces(): readonly TraceEntry[] { return this.rtm().getTraces(); }
  subscribeTraces(listener: () => void): () => void { return this.rtm().subscribeTraces(listener); }
  clearTraces(): void { this.rtm().clearTraces(); }

  getNickNameByUid(userId: string): string | undefined {
    return this.memberNames[userId];
  }

  getMemberDisplayName(userId: string): string {
    return this.getNickNameByUid(userId)
      ?? (userId === this.options.hostUserId ? "Host" : abbreviateUserId(userId));
  }

  async subscribeRoom(): Promise<void> {
    if (this.leavePromise) await this.leavePromise;
    this.leavePromise = undefined;
    this.stopped = false;
    this.subscribing = true;
    this.publish();
    try {
      this.subscribePromise = this.rtm().subscribeRoom();
      await this.subscribePromise;
    } finally {
      this.subscribing = false;
      this.publish();
    }
  }

  async initializeMemberState(): Promise<void> {
    await this.rtm().initializeMemberState(this.options.displayName);
    if (this.stopped) throw new Error('加入房间已取消');
    this.memberNames = { ...this.memberNames, [this.options.userId]: this.options.displayName };
    if (this.options.role === "host") {
      this.memberMuted = { ...this.memberMuted, [this.options.userId]: false };
    }
    this.publish();
  }

  startRoomRuntime(): void {
    if (this.runtimeStarted || this.stopped) return;
    this.runtimeStarted = true;
    // RTC SDK initialization may do synchronous work before returning its Promise.
    // Defer it to the next task so the subscribed room state can render first.
    this.rtcJoinTimer = setTimeout(() => {
      this.rtcJoinTimer = undefined;
      if (!this.stopped) void this.joinRtcInBackground();
    }, 0);
  }

  async enterRoom(): Promise<void> {
    await this.initializeMemberState();
    await this.subscribeRoom();
    this.startRoomRuntime();
  }

  leaveRoom(reason?: string): Promise<void> {
    if (this.leavePromise) return this.leavePromise;
    this.stopped = true;
    this.mediaSyncRequested = false;
    // Assign before notifying observers, so reentrant callers share this cleanup.
    this.leavePromise = Promise.resolve().then(() => this.finishLeavingRoom());
    if (this.rtcJoinTimer) clearTimeout(this.rtcJoinTimer);
    this.rtcJoinTimer = undefined;
    this.clearRequestTimer();
    this.clearHostQueueTimers();
    if (reason) {
      this.endedReason = reason;
      this.roomMetadataFresh = true;
    }
    this.publish();
    return this.leavePromise;
  }

  private async finishLeavingRoom(): Promise<void> {
    try { await this.subscribePromise; } catch { /* Clean a partially subscribed room. */ }
    try { await this.rtc.leave(); } catch { /* 清理失败不覆盖退出语义。 */ }
    this.rtcJoined = false;
    this.runtimeStarted = false;
    this.publishedSeatId = undefined;
    await this.waitForHostMutations();
    await this.rtm().unsubscribeRoom();
    this.snapshot = createInitialRoomSnapshot(
      this.options.hostUserId,
      this.options.role === "host" ? this.options.displayName : null,
    );
    this.hasAuthoritativeSnapshot = false;
    this.onlineUsers = [];
    this.pendingJoinedUsers.clear();
    this.memberNames = {};
    this.memberMuted = {};
    this.memberMicrophoneErrors = {};
    this.hostTemporarilyAway = this.options.role === "audience";
    this.pendingGovernance.clear();
    this.publish();
  }

  private async joinRtcInBackground(): Promise<void> {
    try {
      await this.rtc.join({
        appId: this.options.appId,
        roomId: this.options.roomId,
        userId: this.options.userId,
      });
      if (this.stopped) {
        try { await this.rtc.leave(); } catch { /* Best-effort cleanup after an early leave. */ }
        return;
      }
      this.rtcJoined = true;
      await this.syncOwnMedia();
    } catch (error) {
      if (!this.stopped) {
        this.fail(`RTC 入房失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
    }
  }

  async requestSeat(seatId: string): Promise<void> {
    this.requireAudience();
    if (this.hostTemporarilyAway) throw new Error("房主暂时离开，无法处理上麦申请");
    if (this.waitingSeatId) return;
    this.waitingSeatId = seatId;
    this.publish();
    try {
      await this.audienceRtm!.requestSeat(this.hostUserId(), {
        requestId: newId("req"), seatId,
      });
    } catch {
      if (this.waitingSeatId === seatId) this.waitingSeatId = undefined;
      this.fail(`${this.getNickNameByUid(this.hostUserId()) ?? "Host"} 不在线`);
      return;
    }
    this.requestTimer = setTimeout(() => {
      if (!this.waitingSeatId) return;
      this.waitingSeatId = undefined;
      this.fail("上麦申请未被处理");
    }, SEAT_REQUEST_TIMEOUT_MS);
  }

  async approveSeatRequest(requestId: string): Promise<void> {
    return this.mutateRoomState("seats", async () => {
      const request = this.queue.find((item) => item.id === requestId);
      if (!request) throw new Error("排麦申请不存在");
      const snapshot = this.requireSnapshot();
      if (Object.values(snapshot.seats).some((seat) => seat.userId === request.userId)) throw new Error("该用户已在麦位上");
      const seat = snapshot.seats[request.seatId];
      if (!seat || seat.userId) throw new Error("麦位已被占用");
      const seats = { ...snapshot.seats, [request.seatId]: {
        seatId: request.seatId, userId: request.userId, displayName: request.displayName,
      } };
      await this.hostRtm!.approveSeatRequest({ seats });
      this.applyRoomPatch({ seats });
      this.setQueue(this.queue.filter((item) => item.id !== requestId && item.seatId !== request.seatId));
      this.publish();
    });
  }

  async rejectSeatRequest(requestId: string): Promise<void> {
    this.requireHost();
    const request = this.queue.find((item) => item.id === requestId);
    if (!request) return;
    this.setQueue(this.queue.filter((item) => item.id !== requestId));
    this.publish();
    await this.hostRtm!.rejectSeatRequest(request.userId, requestId, request.seatId);
  }

  async invite(userId: string, seatId: string): Promise<void> {
    this.requireHost();
    const displayName = this.getMemberDisplayName(userId);
    try {
      await this.hostRtm!.inviteToSeat(userId, newId("inv"), seatId);
    } catch {
      this.fail(`${displayName} 不在线`);
    }
  }

  async acceptInvitation(): Promise<void> {
    this.requireAudience();
    if (!this.invitation) return;
    await this.audienceRtm!.acceptSeatInvitation(
      this.hostUserId(),
      this.invitation.id,
      this.invitation.seatId,
    );
    this.invitation = undefined;
    this.publish();
  }

  async rejectInvitation(): Promise<void> {
    this.requireAudience();
    if (!this.invitation) return;
    await this.audienceRtm!.rejectSeatInvitation(this.hostUserId(), this.invitation.id);
    this.invitation = undefined;
    this.publish();
  }

  async leaveSeat(): Promise<void> {
    this.requireAudience();
    const seat = this.ownSeat();
    if (seat) await this.audienceRtm!.leaveSeat(this.hostUserId(), seat.seatId);
  }

  async forceMute(userId: string, muted: boolean): Promise<void> {
    return this.mutateRoomState("forcedMutedUserIds", async () => {
      const snapshot = this.requireSnapshot();
      const forcedMutedUserIds = muted
        ? [...new Set([...snapshot.forcedMutedUserIds, userId])]
        : snapshot.forcedMutedUserIds.filter((id) => id !== userId);
      await this.hostRtm!.updateForcedMutedUsers(forcedMutedUserIds);
      this.applyRoomPatch({ forcedMutedUserIds });
    });
  }

  async forceLeave(userId: string): Promise<void> {
    return this.mutateRoomState("seats", async () => {
      const snapshot = this.requireSnapshot();
      const seat = Object.values(snapshot.seats).find((candidate) => candidate.userId === userId);
      if (!seat) return;
      const seats = { ...snapshot.seats, [seat.seatId]: { seatId: seat.seatId, userId: null, displayName: null } };
      await this.hostRtm!.updateSeats(seats);
      this.applyRoomPatch({ seats });
    });
  }

  async kickMember(userId: string): Promise<void> {
    this.requireHost();
    await Promise.allSettled([this.forceLeave(userId), this.sendGovernance(userId, "member.kick")]);
  }

  async banMember(userId: string): Promise<void> {
    this.requireHost();
    const results = await Promise.allSettled([
      Promise.resolve(this.options.onBanUser?.(userId)),
      this.forceLeave(userId),
      this.sendGovernance(userId, "member.ban"),
    ]);
    const directoryFailure = results[0].status === "rejected" ? results[0].reason : undefined;
    if (directoryFailure) throw directoryFailure;
  }

  private async sendGovernance(userId: string, type: "member.kick" | "member.ban"): Promise<void> {
    try {
      if (type === "member.ban") await this.hostRtm!.banMember(userId);
      else await this.hostRtm!.kickMember(userId);
      if (this.pendingGovernance.get(userId) === type) this.pendingGovernance.delete(userId);
    } catch {
      if (type === "member.ban" || !this.pendingGovernance.has(userId)) this.pendingGovernance.set(userId, type);
      this.fail(type === "member.ban"
        ? "封禁已生效，P2P 通知失败，请稍后再试"
        : "踢出通知失败，请稍后再试");
    }
  }

  dissolveRoom(): Promise<void> {
    if (this.dissolvePromise) return this.dissolvePromise;
    this.requireHost();
    this.dissolvePromise = this.endHostRoom().finally(() => { this.dissolvePromise = undefined; });
    return this.dissolvePromise;
  }

  private async endHostRoom(): Promise<void> {
    await this.options.onRoomDissolved?.();
    this.roomDissolved = true;
    this.actualRoomCleanupPending = true;
    this.directoryCleanupPending = !!this.options.onRoomCleanup;
    await this.waitForHostMutations();
    try {
      await this.hostRtm!.dissolveRoom();
    } finally {
      // A failed notification must not skip data cleanup or keep an ended room open.
      try { await this.retryActualRoomCleanup(); } catch { /* Exposed separately; the room remains ended. */ }
      await this.leaveRoom("房间已解散");
      try { await this.retryDirectoryCleanup(); } catch { /* Exposed by roomCleanupError below. */ }
      this.refreshRoomCleanupError();
    }
  }

  async retryRoomCleanup(): Promise<void> {
    if (this.options.role !== 'host' || !this.roomDissolved) throw new Error('只能清理已确认解散的房间');
    let lastError: unknown;
    try { await this.retryActualRoomCleanup(); } catch (error) { lastError = error; }
    try { await this.retryDirectoryCleanup(); } catch (error) { lastError = error; }
    this.refreshRoomCleanupError();
    if (lastError) throw lastError;
  }

  private async retryActualRoomCleanup(): Promise<void> {
    if (!this.actualRoomCleanupPending) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.hostRtm!.clearRoomData();
        this.actualRoomCleanupPending = false;
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await (this.options.cleanupRetryDelay?.() ?? new Promise(resolve => setTimeout(resolve, 300)));
        }
      }
    }
    throw lastError;
  }

  private async retryDirectoryCleanup(): Promise<void> {
    if (!this.directoryCleanupPending) return;
    await this.options.onRoomCleanup?.();
    this.directoryCleanupPending = false;
  }

  private refreshRoomCleanupError(): void {
    this.roomCleanupError = this.actualRoomCleanupPending || this.directoryCleanupPending
      ? '房间已解散，数据清理未完成'
      : undefined;
    this.publish();
  }

  async updateAnnouncement(announcement: string): Promise<void> {
    const value = announcement.trim();
    if (!value) throw new Error("房间公告不能为空");
    return this.runHostMutation(async () => {
      await this.hostRtm!.updateAnnouncement(value);
      this.applyRoomPatch({ announcement: value });
    });
  }

  async setOwnMuted(muted: boolean): Promise<void> {
    if (this.stopped || !this.ownSeat()) throw new Error("当前不在麦位上");
    this.ownMuted = muted;
    this.publish();
    if (this.rtcJoined) await this.syncOwnMedia();
  }

  /** Serialize read-modify-write operations only with others targeting the same aggregate key. */
  private mutateRoomState(key: "seats" | "forcedMutedUserIds", operation: () => Promise<void>): Promise<void> {
    this.requireHost();
    const tail = key === "seats" ? this.seatsMutationTail : this.forcedMuteMutationTail;
    const result = tail.then(() => {
      this.requireHost();
      return operation();
    });
    const settled = result.catch(() => {});
    if (key === "seats") this.seatsMutationTail = settled;
    else this.forcedMuteMutationTail = settled;
    return this.trackHostMutation(result);
  }

  private runHostMutation(operation: () => Promise<void>): Promise<void> {
    this.requireHost();
    return this.trackHostMutation(Promise.resolve().then(() => {
      this.requireHost();
      return operation();
    }));
  }

  private trackHostMutation(operation: Promise<void>): Promise<void> {
    this.pendingHostMutations.add(operation);
    void operation.finally(() => this.pendingHostMutations.delete(operation)).catch(() => {});
    return operation;
  }

  private async waitForHostMutations(): Promise<void> {
    await Promise.allSettled([...this.pendingHostMutations]);
  }

  private applyRoomPatch(patch: Partial<Pick<RoomSnapshot, "seats" | "announcement" | "forcedMutedUserIds">>): void {
    if (this.stopped || this.roomDissolved) return;
    this.applyRoomSnapshot({ ...this.requireSnapshot(), ...patch });
  }

  async sendInteraction(type: "chat.message" | "emoji.reaction" | "gift.sent", value: string): Promise<void> {
    const normalized = value.trim();
    if (!normalized) return;
    if (type === "chat.message") await this.rtm().sendChatMessage(normalized);
    else if (type === "gift.sent") await this.rtm().sendGiftMessage();
    else await this.rtm().sendHeartMessage();
  }

  private async handleRoomMetadataChanged(result: ChannelMetadataResult, eventType: string): Promise<void> {
    if (this.stopped || this.roomDissolved || (this.hasAuthoritativeSnapshot && result.majorRevision < this.snapshot.majorRevision)) return;
    if (this.options.role === "host" && eventType === "SNAPSHOT" && Object.keys(result.metadata).length === 0) {
      if (this.initializationRevision === result.majorRevision) return;
      this.initializationRevision = result.majorRevision;
      const initial = createInitialRoomSnapshot(this.options.userId, this.options.displayName, result.majorRevision);
      try {
        await this.hostRtm!.initializeRoom(
          serializeInitialRoom(initial),
          result.majorRevision,
          this.describeRoomSnapshot(initial),
        );
        if (!this.stopped && !this.hasAuthoritativeSnapshot) this.applyRoomSnapshot(initial, true);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : "房间初始化失败");
      }
      return;
    }
    if (this.options.role === "audience" && Object.keys(result.metadata).length === 0) {
      await this.onRoomDissolved();
      return;
    }
    const next = parseRoomSnapshot(result);
    if (!next) return;
    if (next.hostUserId !== this.options.hostUserId) {
      this.fail("房主身份与房间状态不一致");
      return;
    }
    this.applyRoomSnapshot(next, true);
    if (this.options.role === "audience") {
      this.roomMetadataFresh = true;
      this.publish();
    }
  }

  private handlePresenceEvent(event: RTMEvents.PresenceEvent): void {
    if (event.eventType === "SNAPSHOT") this.handlePresenceSnapshot(event);
    else if (event.eventType === "REMOTE_JOIN") this.onMemberJoined(event.publisher, event.stateChanged);
    else if (event.eventType === "REMOTE_LEAVE" || event.eventType === "REMOTE_TIMEOUT") {
      this.onMemberLeft(event.publisher);
    } else if (event.eventType === "REMOTE_STATE_CHANGED") {
      this.onMemberStateChanged(event.publisher, event.stateChanged);
    } else if (event.eventType === "INTERVAL") {
      this.handlePresenceInterval(event.interval);
    }
    this.publish();
  }

  private describePresenceEvent(event: RTMEvents.PresenceEvent): string {
    if (event.eventType === "SNAPSHOT") {
      const names = (event.snapshot ?? []).flatMap(({ userId, states }) => {
        const displayName = states.displayName;
        if (typeof displayName === "string" && displayName.trim()) return [displayName];
        return this.getNickNameByUid(userId) ?? [];
      });
      return names.join(", ") || "暂无昵称";
    }

    const state = event.stateChanged ?? {};
    const displayName = typeof state.displayName === "string" && state.displayName.trim()
      ? state.displayName
      : this.getMemberDisplayName(event.publisher);
    if (event.eventType !== "REMOTE_STATE_CHANGED") {
      const abbreviatedUid = abbreviateUserId(event.publisher);
      return displayName === abbreviatedUid ? abbreviatedUid : `${displayName} (${abbreviatedUid})`;
    }
    const abbreviatedUid = abbreviateUserId(event.publisher);
    const member = displayName === abbreviatedUid ? abbreviatedUid : `${displayName} (${abbreviatedUid})`;
    const details: string[] = [];
    const muted = state.muted;
    if (muted === "true" || muted === "false") {
      if (this.memberMuted[event.publisher] !== (muted === "true")) details.push(`muted=${muted}`);
    } else if (this.memberMuted[event.publisher] !== undefined) {
      details.push("muted=已删除");
    }
    const microphoneError = state.microphoneError;
    if (microphoneError === "true" || microphoneError === "false") {
      if (this.memberMicrophoneErrors[event.publisher] !== (microphoneError === "true")) {
        details.push(`microphoneError=${microphoneError}`);
      }
    } else if (this.memberMicrophoneErrors[event.publisher] !== undefined) {
      details.push("microphoneError=已删除");
    }
    for (const [key, value] of Object.entries(state)) {
      if (key === "displayName" || key === "muted" || key === "microphoneError") continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        details.push(`${key}=${String(value)}`);
      }
    }
    return [member, details.join(", ")].filter(Boolean).join(" ");
  }

  private describeMessageEvent(envelope: RoomRtmEnvelope, context: RtmMessageContext): string {
    const sender = this.getMemberDisplayName(context.publisher);
    const seat = typeof envelope.payload.seatId === "string"
      ? Number(envelope.payload.seatId.replace("seat-", ""))
      : undefined;
    const seatSummary = seat !== undefined && Number.isInteger(seat) ? ` ${seat + 1}号麦` : "";
    const content = envelope.type === "chat.message" && typeof envelope.payload.value === "string"
      ? `: ${envelope.payload.value}`
      : "";
    return `${envelope.type}${seatSummary} from ${sender}${content}`;
  }

  private describeRoomMetadata(result: ChannelMetadataResult): string | undefined {
    if (Object.keys(result.metadata).length === 0 && (this.hasAuthoritativeSnapshot || this.roomDissolved)) return "房间数据已清理";
    const latest = parseRoomSnapshot(result);
    if (!latest) return "Metadata=空";

    return this.describeRoomSnapshot(latest);
  }

  private describeRoomSnapshot(snapshot: RoomSnapshot): string {
    const forcedMutedUsers = snapshot.forcedMutedUserIds.map((userId) => this.getMemberDisplayName(userId));
    return [
      `hostUserId=${this.getMemberDisplayName(snapshot.hostUserId)}`,
      `announcement=${snapshot.announcement || "空"}`,
      `seats=${this.describeAllSeats(snapshot.seats)}`,
      `forcedMutedUserIds=${forcedMutedUsers.join(", ") || "空"}`,
    ].join(", ");
  }

  private describeAllSeats(seats: Record<string, RoomSeat>): string {
    return Object.keys(seats)
      .sort((left, right) => Number(left.replace("seat-", "")) - Number(right.replace("seat-", "")))
      .map((seatId) => {
        const seat = seats[seatId];
        const seatNumber = Number(seatId.replace("seat-", "")) + 1;
        return `${seatNumber}号麦 ${seat.userId ? this.getMemberDisplayName(seat.userId) : "空"}`;
      })
      .join(", ");
  }

  private describeSeats(seats: Record<string, RoomSeat>): string {
    const currentSeats = this.snapshot?.seats;
    const seatIds = new Set([
      ...Object.keys(currentSeats ?? {}),
      ...Object.keys(seats),
    ]);
    const changes = [...seatIds].flatMap((seatId) => {
      const current = currentSeats?.[seatId];
      const latest = seats[seatId];
      if (current?.userId === latest?.userId) return [];
      const seatNumber = Number(seatId.replace("seat-", "")) + 1;
      if (!latest?.userId) return current?.userId ? [`${seatNumber}号麦 空`] : [];
      const displayName = this.getMemberDisplayName(latest.userId);
      return [`${seatNumber}号麦 ${displayName}`];
    });
    return changes.join(", ") || "无变化";
  }

  private handlePresenceSnapshot(event: RTMEvents.PresenceEvent): void {
    this.pendingJoinedUsers.clear();
    this.onlineUsers = (event.snapshot ?? []).map(({ userId }) => userId);
    this.memberNames = Object.fromEntries((event.snapshot ?? []).flatMap(({ userId, states }) => {
      const displayName = states.displayName;
      if (typeof displayName === "string" && displayName.trim()) return [[userId, displayName]];
      return [];
    }));
    this.memberMuted = Object.fromEntries((event.snapshot ?? []).flatMap(({ userId, states }) =>
      states.muted === "true" || states.muted === "false"
        ? [[userId, states.muted === "true"]]
        : [],
    ));
    this.memberMicrophoneErrors = Object.fromEntries((event.snapshot ?? []).flatMap(({ userId, states }) =>
      states.microphoneError === "true" || states.microphoneError === "false"
        ? [[userId, states.microphoneError === "true"]]
        : [],
    ));
    const ownMuted = (event.snapshot ?? []).find(({ userId }) => userId === this.options.userId)?.states.muted;
    this.ownMuted = ownMuted === "true";
    this.refreshHostAvailability();
  }

  private onMemberJoined(userId: string, state: Readonly<Record<string, string>> | null): void {
    this.onlineUsers = [...new Set([...this.onlineUsers, userId])];
    const displayName = state?.displayName;
    const isHost = userId === this.snapshot?.hostUserId;
    if (isHost) this.hostTemporarilyAway = false;
    if (typeof displayName === "string" && displayName.trim()) {
      this.memberNames = { ...this.memberNames, [userId]: displayName };
      this.appendSystemInteraction(
        "system-member-joined",
        isHost ? `${displayName} 回到了房间` : `${displayName} 加入了房间`,
      );
    } else this.pendingJoinedUsers.add(userId);
    const muted = state?.muted;
    if (muted === "true" || muted === "false") {
      this.memberMuted = { ...this.memberMuted, [userId]: muted === "true" };
    }
    const microphoneError = state?.microphoneError;
    if (microphoneError === "true" || microphoneError === "false") {
      this.memberMicrophoneErrors = { ...this.memberMicrophoneErrors, [userId]: microphoneError === "true" };
    }
    const pending = this.options.role === "host" ? this.pendingGovernance.get(userId) : undefined;
    if (pending) void this.sendGovernance(userId, pending);
  }

  private onMemberLeft(userId: string): void {
    this.onlineUsers = this.onlineUsers.filter((current) => current !== userId);
    const displayName = this.getMemberDisplayName(userId);
    const isHost = userId === this.snapshot?.hostUserId;
    if (isHost) this.hostTemporarilyAway = true;
    this.appendSystemInteraction(
      "system-member-left",
      isHost ? `${displayName} 暂时离开了房间` : `${displayName} 离开了房间`,
    );
    this.pendingJoinedUsers.delete(userId);
    const { [userId]: _removed, ...remainingNames } = this.memberNames;
    this.memberNames = remainingNames;
    const { [userId]: _removedMuted, ...remainingMuted } = this.memberMuted;
    this.memberMuted = remainingMuted;
    const { [userId]: _removedMicrophoneError, ...remainingMicrophoneErrors } = this.memberMicrophoneErrors;
    this.memberMicrophoneErrors = remainingMicrophoneErrors;
    if (this.options.role === "host") this.setQueue(this.queue.filter((request) => request.userId !== userId));
    if (this.options.role === "host" && !isHost) void this.forceLeave(userId).catch(() => undefined);
  }

  private onMemberStateChanged(userId: string, state: Readonly<Record<string, string>> | null): void {
    const displayName = state?.displayName;
    if (typeof displayName === "string" && displayName.trim()) {
      this.memberNames = { ...this.memberNames, [userId]: displayName };
      if (this.pendingJoinedUsers.delete(userId)) {
        this.appendSystemInteraction("system-member-joined", `${displayName} 加入了房间`);
      }
    }
    const muted = state?.muted;
    if (muted === "true" || muted === "false") {
      const isMuted = muted === "true";
      this.memberMuted = { ...this.memberMuted, [userId]: isMuted };
      if (userId === this.options.userId) this.ownMuted = isMuted;
    } else {
      const { [userId]: _removedMuted, ...remainingMuted } = this.memberMuted;
      this.memberMuted = remainingMuted;
      if (userId === this.options.userId) this.ownMuted = false;
    }
    const microphoneError = state?.microphoneError;
    if (microphoneError === "true" || microphoneError === "false") {
      this.memberMicrophoneErrors = {
        ...this.memberMicrophoneErrors,
        [userId]: microphoneError === "true",
      };
    } else {
      const { [userId]: _removedMicrophoneError, ...remainingMicrophoneErrors } = this.memberMicrophoneErrors;
      this.memberMicrophoneErrors = remainingMicrophoneErrors;
    }
  }

  private handlePresenceInterval(interval: RTMEvents.IntervalDetail | null): void {
    interval?.join.users.forEach((userId) => this.onMemberJoined(userId, null));
    interval?.leave.users.forEach((userId) => this.onMemberLeft(userId));
    interval?.timeout.users.forEach((userId) => this.onMemberLeft(userId));
  }
  private async handleMessageEvent(envelope: RoomRtmEnvelope, context: RtmMessageContext): Promise<void> {
    if (context.channelType === "MESSAGE") {
      if (envelope.type === "room.dissolved") await this.onRoomDissolved();
      else if (envelope.type === "chat.message") this.onChatMessage(envelope, context);
      else if (envelope.type === "gift.sent") this.onGiftMessage(envelope, context);
      else if (envelope.type === "emoji.reaction") this.onHeartMessage(envelope, context);
      return;
    }

    if (this.options.role === "host") {
      if (envelope.type === "seat.request") this.onSeatRequest(envelope, context);
      else if (envelope.type === "seat.invitation.accepted") await this.onSeatInvitationAccepted(envelope, context);
      else if (envelope.type === "seat.invitation.rejected") this.onSeatInvitationRejected(context);
      else if (envelope.type === "seat.left") await this.onSeatLeft(context);
      return;
    }

    if (envelope.type === "seat.rejected") this.onSeatRejected();
    else if (envelope.type === "seat.invited") this.onSeatInvited(envelope);
    else if (envelope.type === "member.kick") await this.onMemberKicked();
    else if (envelope.type === "member.ban") await this.onMemberBanned();
  }

  private onSeatRequest(envelope: RoomRtmEnvelope, context: RtmMessageContext): void {
    const receivedAt = Date.now();
    const request = {
      id: String(envelope.payload.requestId ?? envelope.messageId),
      userId: context.publisher,
      displayName: this.getMemberDisplayName(context.publisher),
      seatId: String(envelope.payload.seatId ?? ""),
      expiresAt: receivedAt + SEAT_REQUEST_TIMEOUT_MS,
      remainingSeconds: SEAT_REQUEST_TIMEOUT_MS / 1_000,
    };
    if (this.queue.some(({ id }) => id === request.id)) return;
    this.setQueue([...this.queue, request]);
    this.seatRequestTimers.set(request.id, setTimeout(() => {
      this.setQueue(this.queue.filter(({ id }) => id !== request.id));
      this.publish();
    }, SEAT_REQUEST_TIMEOUT_MS));
    this.ensureQueueTicker();
    this.notify(`${request.displayName} 申请 ${Number(request.seatId.replace("seat-", "")) + 1} 号麦位`);
  }

  private async onSeatInvitationAccepted(envelope: RoomRtmEnvelope, context: RtmMessageContext): Promise<void> {
    return this.mutateRoomState("seats", async () => {
      const snapshot = this.requireSnapshot();
      const seatId = String(envelope.payload.seatId ?? "");
      const seat = snapshot.seats[seatId];
      if (!seat || seat.userId || Object.values(snapshot.seats).some(item => item.userId === context.publisher)) return;
      const seats = { ...snapshot.seats, [seatId]: {
        seatId,
        userId: context.publisher,
        displayName: this.getMemberDisplayName(context.publisher),
      } };
      await this.hostRtm!.updateSeats(seats);
      this.applyRoomPatch({ seats });
    });
  }

  private onSeatInvitationRejected(context: RtmMessageContext): void {
    this.fail(`${this.getMemberDisplayName(context.publisher)} 拒绝了上麦邀请`);
  }

  private async onSeatLeft(context: RtmMessageContext): Promise<void> {
    await this.forceLeave(context.publisher);
  }

  private onSeatRejected(): void {
    this.waitingSeatId = undefined;
    this.clearRequestTimer();
    this.fail("上麦申请被拒绝");
  }

  private onSeatInvited(envelope: RoomRtmEnvelope): void {
    this.invitation = {
      id: String(envelope.payload.invitationId ?? ""),
      seatId: String(envelope.payload.seatId ?? ""),
    };
    this.publish();
  }

  private async onMemberKicked(): Promise<void> {
    await this.leaveRoom("你已被房主踢出");
  }

  private async onMemberBanned(): Promise<void> {
    this.options.onSelfBanned?.();
    await this.leaveRoom("你已被该房间封禁");
  }

  private async onRoomDissolved(): Promise<void> {
    await this.options.onRoomDissolved?.();
    await this.leaveRoom("房间已解散");
  }

  private onChatMessage(envelope: RoomRtmEnvelope, context: RtmMessageContext): void {
    this.appendIncomingInteraction("chat", envelope, context);
  }

  private onGiftMessage(envelope: RoomRtmEnvelope, context: RtmMessageContext): void {
    this.appendIncomingInteraction("gift", envelope, context);
  }

  private onHeartMessage(envelope: RoomRtmEnvelope, context: RtmMessageContext): void {
    this.appendIncomingInteraction("emoji", envelope, context);
  }

  private appendIncomingInteraction(
    type: "chat" | "gift" | "emoji",
    envelope: RoomRtmEnvelope,
    context: RtmMessageContext,
  ): void {
    const value = typeof envelope.payload.value === "string" ? envelope.payload.value : "";
    if (!value) return;
    this.interactions = [...this.interactions, {
      id: envelope.messageId,
      type,
      senderId: context.publisher,
      displayName: this.getMemberDisplayName(context.publisher),
      value,
    }];
    this.publish();
  }
  private applyRoomSnapshot(snapshot: RoomSnapshot, authoritative = false): void {
    if (!this.handleHostChanged(snapshot.hostUserId)) return;
    const announceSeatChanges = !authoritative || this.hasAuthoritativeSnapshot;
    if (authoritative) this.hasAuthoritativeSnapshot = true;
    this.snapshot = { ...this.snapshot, majorRevision: snapshot.majorRevision };
    this.handleAnnouncementChanged(snapshot.announcement);
    this.handleForcedMutedUsersChanged(snapshot.forcedMutedUserIds);
    this.handleSeatsChanged(snapshot.seats, announceSeatChanges);
    this.publish();
  }

  private handleSeatsChanged(
    seats: Record<string, RoomSeat>,
    announceChanges = true,
  ): void {
    const currentSeats = this.snapshot.seats;
    if (this.options.role === "audience") {
      const waitingSeat = this.waitingSeatId ? seats[this.waitingSeatId] : undefined;
      if (waitingSeat?.userId && waitingSeat.userId !== this.options.userId) {
        this.waitingSeatId = undefined;
        this.clearRequestTimer();
        this.fail("上麦申请被拒绝");
      }
      const invitedSeat = this.invitation ? seats[this.invitation.seatId] : undefined;
      if (invitedSeat?.userId) this.invitation = undefined;
    }
    if (announceChanges) {
      const seatIds = new Set([...Object.keys(currentSeats), ...Object.keys(seats)]);
      for (const seatId of seatIds) {
        const before = currentSeats[seatId];
        const after = seats[seatId];
        if (before?.userId === after?.userId) continue;
        const seatNumber = Number(seatId.replace("seat-", "")) + 1;
        if (before?.userId) {
          const displayName = this.getMemberDisplayName(before.userId);
          this.appendSystemInteraction("system-seat-left", `${displayName} 下了 ${seatNumber} 号麦`);
        }
        if (after?.userId) {
          const displayName = this.getMemberDisplayName(after.userId);
          this.appendSystemInteraction("system-seat-joined", `${displayName} 上了 ${seatNumber} 号麦`);
        }
      }
    }
    this.snapshot = { ...this.requireSnapshot(), seats };
    if (this.options.role === "host") {
      const occupied = new Set(Object.values(seats).filter(({ userId }) => userId).map(({ seatId }) => seatId));
      this.setQueue(this.queue.filter(({ seatId }) => !occupied.has(seatId)));
    }
    if (this.rtcJoined) void this.syncOwnMedia();
  }

  private handleAnnouncementChanged(text: string): void {
    this.snapshot = { ...this.requireSnapshot(), announcement: text };
  }

  private handleForcedMutedUsersChanged(userIds: string[]): void {
    this.snapshot = { ...this.requireSnapshot(), forcedMutedUserIds: userIds };
  }

  private handleHostChanged(hostUserId: string): boolean {
    if (this.options.role === "host" && hostUserId !== this.options.userId) {
      this.fail("房主身份与房间状态不一致");
      return false;
    }
    this.snapshot = { ...this.snapshot, hostUserId };
    this.refreshHostAvailability(hostUserId);
    return true;
  }

  private refreshHostAvailability(hostUserId = this.snapshot.hostUserId): void {
    if (!hostUserId || this.options.role === "host") {
      this.hostTemporarilyAway = false;
      return;
    }
    this.hostTemporarilyAway = !this.onlineUsers.includes(hostUserId);
  }

  /** Coalesce SDK events into one media transition at a time. */
  private syncOwnMedia(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.mediaSyncRequested = true;
    if (!this.mediaSyncPromise) {
      this.mediaSyncPromise = Promise.resolve().then(async () => {
        while (this.mediaSyncRequested && !this.stopped) {
          this.mediaSyncRequested = false;
          await this.reconcileOwnMedia();
        }
      }).catch(error => {
        if (!this.stopped) this.fail(`麦克风状态同步失败：${error instanceof Error ? error.message : "未知错误"}`);
      }).finally(() => {
        this.mediaSyncPromise = undefined;
        if (this.mediaSyncRequested && !this.stopped) void this.syncOwnMedia();
      });
    }
    return this.mediaSyncPromise;
  }

  private async reconcileOwnMedia(): Promise<void> {
    const seat = this.ownSeat();
    if (!seat) {
      this.waitingSeatId = undefined;
      this.clearRequestTimer();
      if (this.publishedSeatId) {
        await this.rtc.unpublishMicrophone();
        this.publishedSeatId = undefined;
      }
      if (!this.stopped && this.options.role === "audience") await this.clearOwnSeatMediaState();
      return;
    }
    const stillSeated = () => !this.stopped && this.ownSeat()?.seatId === seat.seatId;
    this.waitingSeatId = undefined;
    this.clearRequestTimer();
    if (this.publishedSeatId !== seat.seatId) {
      try {
        await this.rtc.publishMicrophone();
        if (!stillSeated()) {
          await this.rtc.unpublishMicrophone();
          this.publishedSeatId = undefined;
          return;
        }
        this.publishedSeatId = seat.seatId;
      } catch (error) {
        if (!stillSeated()) return;
        const captureHealthy = this.rtc.isMicrophoneCaptureHealthy();
        if (captureHealthy) await this.clearOwnMicrophoneError();
        else await this.reportOwnMicrophoneError();
        if (stillSeated()) this.fail(captureHealthy
          ? `音频发布失败，本地麦克风采集正常，麦位已保留：${error instanceof Error ? error.message : "未知错误"}`
          : `麦克风采集失败，麦位已保留：${error instanceof Error ? error.message : "未知错误"}`);
        return;
      }
    }
    await this.rtc.setMicrophoneMuted(this.ownMuted || this.snapshot.forcedMutedUserIds.includes(this.options.userId));
    if (!stillSeated()) return;
    const muted = this.ownMuted;
    if (this.memberMuted[this.options.userId] !== muted) {
      if (muted) await this.rtm().muteMicrophone();
      else await this.rtm().unmuteMicrophone();
      if (this.stopped) return;
      this.memberMuted = { ...this.memberMuted, [this.options.userId]: muted };
      this.publish();
    }
    if (stillSeated()) await this.clearOwnMicrophoneError();
  }

  private async reportOwnMicrophoneError(): Promise<void> {
    this.memberMicrophoneErrors = { ...this.memberMicrophoneErrors, [this.options.userId]: true };
    this.publish();
    try {
      await this.rtm().reportMicrophoneError();
    } catch (error) {
      this.fail(`麦克风异常状态同步失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  private async clearOwnMicrophoneError(): Promise<void> {
    if (!this.memberMicrophoneErrors[this.options.userId]) return;
    try {
      await this.rtm().clearMicrophoneError();
      this.memberMicrophoneErrors = { ...this.memberMicrophoneErrors, [this.options.userId]: false };
      this.publish();
    } catch (error) {
      this.fail(`麦克风恢复状态同步失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  private async clearOwnSeatMediaState(): Promise<void> {
    const hasMuted = this.memberMuted[this.options.userId] !== undefined;
    const hasMicrophoneError = this.memberMicrophoneErrors[this.options.userId] !== undefined;
    if (!hasMuted && !hasMicrophoneError) return;
    try {
      await this.audienceRtm!.clearSeatMediaState();
      const { [this.options.userId]: _removedMuted, ...remainingMuted } = this.memberMuted;
      const { [this.options.userId]: _removedMicrophoneError, ...remainingMicrophoneErrors } =
        this.memberMicrophoneErrors;
      this.memberMuted = remainingMuted;
      this.memberMicrophoneErrors = remainingMicrophoneErrors;
      this.ownMuted = false;
      this.publish();
    } catch (error) {
      this.fail(`离麦状态清理失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  private rtm(): HostRoomRtm | AudienceRoomRtm {
    return this.hostRtm ?? this.audienceRtm!;
  }

  private requireSnapshot(): RoomSnapshot {
    return this.snapshot;
  }

  private ownSeat(): RoomSeat | undefined {
    return Object.values(this.snapshot.seats).find(({ userId }) => userId === this.options.userId);
  }

  private hostUserId(): string {
    return this.requireSnapshot().hostUserId;
  }

  private requireHost(): void {
    if (this.stopped || this.roomDissolved) throw new Error("房间已结束");
    if (this.options.role !== "host") throw new Error("只有房主可以执行此操作");
  }

  private requireAudience(): void {
    if (this.options.role !== "audience") throw new Error("当前操作仅限听众");
  }

  private clearRequestTimer(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = undefined;
  }

  private setQueue(next: SingleRoomRequest[]): void {
    const retained = new Set(next.map(({ id }) => id));
    for (const [requestId, timer] of this.seatRequestTimers) {
      if (retained.has(requestId)) continue;
      clearTimeout(timer);
      this.seatRequestTimers.delete(requestId);
    }
    this.queue = next;
    if (this.queue.length === 0 && this.queueTicker) {
      clearInterval(this.queueTicker);
      this.queueTicker = undefined;
    }
  }

  private ensureQueueTicker(): void {
    if (this.queueTicker) return;
    this.queueTicker = setInterval(() => {
      const now = Date.now();
      this.queue = this.queue.map((request) => ({
        ...request,
        remainingSeconds: Math.max(0, Math.ceil((request.expiresAt - now) / 1_000)),
      }));
      this.publish();
    }, 1_000);
  }

  private clearHostQueueTimers(): void {
    for (const timer of this.seatRequestTimers.values()) clearTimeout(timer);
    this.seatRequestTimers.clear();
    if (this.queueTicker) clearInterval(this.queueTicker);
    this.queueTicker = undefined;
    this.queue = [];
  }

  private fail(message: string): void {
    this.error = message;
    this.errorVersion += 1;
    this.publish();
  }

  private notify(message: string): void {
    this.notice = message;
    this.noticeVersion += 1;
    this.publish();
  }

  private appendSystemInteraction(
    type: Extract<SingleRoomInteraction["type"], `system-${string}`>,
    value: string,
  ): void {
    this.interactions = [...this.interactions, {
      id: newId("system"),
      type,
      senderId: "system",
      displayName: "系统",
      value,
    }];
  }

  private publish(): void {
    this.viewSnapshot = undefined;
    for (const listener of this.listeners) listener();
  }
}
