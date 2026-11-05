import type { RTMEvents } from "agora-rtm";
import { describe, expect, it, vi } from "vitest";

import type {
  AppRoomRtmPort,
  AppRtmEventListeners,
} from "../../app-rtm";
import {
  createHostRoomRtm,
  type HostRoomRtmSession,
} from "../../host/rtm";
import { createHostOnRtmEvent } from "../../host/onRtmEvent";

function setup(roomId = "room-1") {
  const operations: string[] = [];
  const presenceStates: Record<string, string>[] = [];
  const published: Array<{ channelName: string; channelType: string; envelope: { type: string; payload: Record<string, unknown> } }> = [];
  let handlers: AppRtmEventListeners = {};
  const port: AppRoomRtmPort = {
    async subscribe(roomId) { operations.push(`subscribe:${roomId}`); },
    async unsubscribe(roomId) { operations.push(`unsubscribe:${roomId}`); },
    async publish(channelName, message, channelType) {
      const envelope = JSON.parse(message);
      operations.push(`publish:${channelType}:${channelName}:${envelope.type}`);
      published.push({ channelName, channelType, envelope });
    },
    async setPresenceState(roomId, state) {
      operations.push(`presence:${roomId}`);
      presenceStates.push(state);
    },
    async removePresenceState() {},
    async removeRoomMetadata(roomId) { operations.push(`remove:${roomId}`); },
    async setRoomMetadata(roomId, data, majorRevision) {
      operations.push(`metadata:${roomId}:${data.map(({ key }) => key).join(",")}:${majorRevision ?? "none"}`);
    },
  };
  const session: HostRoomRtmSession = {
    getRoomPort: () => port,
  };
  const eventSource = {
    bindRtmEvents(next: AppRtmEventListeners) {
      handlers = next;
      return () => { if (handlers === next) handlers = {}; };
    },
  };
  const names: Record<string, string> = { "host-1": "Host", "audience-2": "Alice_037" };
  const describeSeats = (seats: Record<string, { seatId: string; userId: string | null; displayName: string | null }>) =>
    Object.entries(seats).flatMap(([seatId, seat]) => seat.userId
      ? [`${Number(seatId.replace("seat-", "")) + 1}号麦 ${seat.displayName ?? names[seat.userId] ?? "暂无昵称"}`]
      : []).join(", ") || "麦位空";
  const metadata = vi.fn((result: { metadata: Record<string, { value: string }> }) => {
    const seats = result.metadata.seats?.value;
    return { summary: seats ? describeSeats(JSON.parse(seats)) : "麦位空" };
  });
  const message = vi.fn((
    envelope: { type: string; payload: Record<string, unknown> },
    context: { publisher: string },
  ) => ({
    summary: `${envelope.type} from ${names[context.publisher] ?? "暂无昵称"}${
      envelope.type === "chat.message" && typeof envelope.payload.value === "string"
        ? `: ${envelope.payload.value}`
        : ""
    }`,
  }));
  const presence = vi.fn((event: RTMEvents.PresenceEvent) => {
    const state = event.stateChanged ?? {};
    const displayName = state.displayName || names[event.publisher] || "暂无昵称";
    const details = state.muted === undefined ? "" : ` muted=${state.muted}`;
    return { summary: `${displayName}${details}` };
  });
  let now = 1_000;
  let monotonicNow = 10;
  const rtm = createHostRoomRtm({
    roomId,
    userId: "host-1",
    session,
    events: createHostOnRtmEvent({
      roomId,
      userId: "host-1",
      source: eventSource,
      listeners: {
        onLinkState: () => undefined,
        onPresence: presence,
        onMetadata: metadata,
        onMessage: message,
      },
      now: () => now,
    }),
    describeUser: (userId) => names[userId],
    describeSeats,
    now: () => now,
    monotonicNow: () => monotonicNow,
  });

  return {
    rtm,
    port,
    operations,
    presenceStates,
    published,
    metadata,
    message,
    setNow(value: number) { now = value; },
    setMonotonicNow(value: number) { monotonicNow = value; },
    emit<Event extends keyof AppRtmEventListeners>(
      name: Event,
      event: Parameters<NonNullable<AppRtmEventListeners[Event]>>[0],
    ) {
      const handler = handlers[name] as ((value: typeof event) => void) | undefined;
      handler?.(event);
    },
  };
}

function storageEvent(majorRevision: number): RTMEvents.StorageEvent {
  return {
    timestamp: majorRevision,
    channelName: "room-1",
    channelType: "MESSAGE",
    storageType: "CHANNEL",
    eventType: "SNAPSHOT",
    publisher: "",
    data: { majorRevision, totalCount: 0, metadata: {} },
  };
}

describe("房间数据清理", () => {
  it("等待在途写入完成再删除，并阻止解散后的写入及空快照初始化", async () => {
    const context = setup();
    let finish!: () => void;
    context.port.setRoomMetadata = async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      context.operations.push('write:done');
    };
    const writing = context.rtm.updateAnnouncement('最后一条公告');
    const cleaning = context.rtm.clearRoomData();
    const second = context.rtm.clearRoomData();
    expect(cleaning).toBe(second);
    expect(context.operations).not.toContain('remove:room-1');
    await expect(context.rtm.updateAnnouncement('迟到公告')).rejects.toThrow('已解散');
    await expect(context.rtm.initializeRoom([], 0, "Metadata=空")).rejects.toThrow('已解散');
    finish();
    await writing;
    await cleaning;
    expect(context.operations).toEqual(['write:done', 'remove:room-1']);
    expect(context.rtm.getTraces()).toContainEqual(expect.objectContaining({ name: 'storage.removeChannelMetadata' }));
  });
});

describe("HostRoomRtm", () => {
  it("使用单调高精度时钟计算 API durationMs", async () => {
    const context = setup();

    const subscribing = context.rtm.subscribeRoom();
    context.setMonotonicNow(22.75);
    await subscribing;

    expect(context.rtm.getTraces()).toContainEqual(
      expect.objectContaining({ name: "rtm.subscribe", at: 1_000, durationMs: 12.75 }),
    );
  });

  it("Channel API 使用频道短标识，publish 展示目标、范围与业务参数", async () => {
    const context = setup("voice-room-e1fa5e28-7306-4686-a206-ec118b17d2e9");

    await context.rtm.subscribeRoom();
    await context.rtm.initializeMemberState("Host");
    await context.rtm.initializeRoom(
      [{ key: "hostUserId", value: "host-1" }],
      1,
      "hostUserId=Host, announcement=空, seats=1号麦 Host, 2号麦 空, forcedMutedUserIds=空",
    );
    await context.rtm.inviteToSeat("audience-2", "invitation-1", "seat-1");
    await context.rtm.sendHeartMessage();
    await context.rtm.clearRoomData();
    await context.rtm.unsubscribeRoom();

    expect(context.rtm.getTraces()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "rtm.subscribe", summary: "voice-room-...-d2e9" }),
      expect.objectContaining({ name: "presence.setState", summary: "voice-room-...-d2e9: displayName=Host, muted=false" }),
      expect.objectContaining({
        name: "storage.setChannelMetadata",
        summary: "voice-room-...-d2e9: hostUserId=Host, announcement=空, seats=1号麦 Host, 2号麦 空, forcedMutedUserIds=空",
      }),
      expect.objectContaining({ name: "rtm.publish", eventTag: "USER", summary: "to Alice_037 seat.invited 2号麦" }),
      expect.objectContaining({ name: "rtm.publish", eventTag: "MESSAGE", summary: "voice-room-...-d2e9: to ALL emoji.reaction" }),
      expect.objectContaining({ name: "storage.removeChannelMetadata", summary: "voice-room-...-d2e9: 清理已解散房间数据" }),
      expect.objectContaining({ name: "rtm.unsubscribe", summary: "voice-room-...-d2e9" }),
    ]));
  });

  it("subscribeRoom 只等待 SDK subscribe，不等 Presence 或 Storage 首快照", async () => {
    const context = setup();

    await expect(context.rtm.subscribeRoom()).resolves.toBeUndefined();

    expect(context.operations).toEqual(["subscribe:room-1"]);
    expect(context.metadata).not.toHaveBeenCalled();
  });

  it("转发房间 Storage 全量事件，并保留空快照 majorRevision", async () => {
    const context = setup();
    await context.rtm.subscribeRoom();

    context.emit("storage", storageEvent(7));
    await Promise.resolve();

    expect(context.metadata).toHaveBeenCalledWith(
      expect.objectContaining({ majorRevision: 7, metadata: {} }),
      "SNAPSHOT",
    );
  });

  it("用一次 majorRevision 写初始 metadata，普通更新不附加 Lock", async () => {
    const context = setup();

    await context.rtm.initializeRoom([
      { key: "hostUserId", value: "host-1" },
      { key: "announcement", value: "欢迎" },
    ], 3, "hostUserId=Host, announcement=欢迎");
    await context.rtm.updateAnnouncement("新公告");

    expect(context.operations).toEqual([
      "metadata:room-1:hostUserId,announcement:3",
      "metadata:room-1:announcement:none",
    ]);
  });

  it("信封保留 TTL、来源与目标校验，并对 messageId 去重", async () => {
    const context = setup();
    await context.rtm.subscribeRoom();
    const envelope = {
      schemaVersion: 1 as const,
      messageId: "msg-1",
      type: "seat.request",
      roomId: "room-1",
      targetUserId: "host-1",
      sentAt: 900,
      expiresAt: 2_000,
      payload: { seatId: "seat-1" },
    };
    const event: RTMEvents.MessageEvent = {
      timestamp: 1_000,
      channelType: "USER",
      channelName: "host-1",
      topicName: "",
      messageType: "STRING",
      customType: "",
      message: JSON.stringify(envelope),
      publisher: "audience-1",
    };

    context.emit("message", event);
    context.emit("message", event);
    await Promise.resolve();
    context.setNow(2_001);
    context.emit("message", { ...event, message: JSON.stringify({ ...envelope, messageId: "msg-2" }) });

    expect(context.message).toHaveBeenCalledTimes(1);
    expect(context.message).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({ channelType: "USER", publisher: "audience-1" }),
    );
  });

  it("Host 每个用户动作都通过独立 RTM 语义函数执行", async () => {
    const context = setup();
    const seats = {
      "seat-1": { seatId: "seat-1", userId: "audience-2", displayName: "Alice_037" },
    };

    await context.rtm.approveSeatRequest({
      seats,
    });
    await context.rtm.rejectSeatRequest("audience-3", "request-2", "seat-2");
    await context.rtm.inviteToSeat("audience-4", "invitation-1", "seat-3");
    await context.rtm.kickMember("audience-5");
    await context.rtm.banMember("audience-6");
    await context.rtm.dissolveRoom();
    await context.rtm.sendChatMessage("hello");
    await context.rtm.sendGiftMessage();
    await context.rtm.sendHeartMessage();
    await context.rtm.muteMicrophone();
    await context.rtm.unmuteMicrophone();
    await context.rtm.reportMicrophoneError();
    await context.rtm.clearMicrophoneError();

    expect(context.operations).toEqual([
      "metadata:room-1:seats:none",
      "publish:USER:audience-3:seat.rejected",
      "publish:USER:audience-4:seat.invited",
      "publish:USER:audience-5:member.kick",
      "publish:USER:audience-6:member.ban",
      "publish:MESSAGE:room-1:room.dissolved",
      "publish:MESSAGE:room-1:chat.message",
      "publish:MESSAGE:room-1:gift.sent",
      "publish:MESSAGE:room-1:emoji.reaction",
      "presence:room-1",
      "presence:room-1",
      "presence:room-1",
      "presence:room-1",
    ]);
    expect(context.presenceStates.slice(-4)).toEqual([
      { muted: "true" },
      { muted: "false" },
      { microphoneError: "true" },
      { microphoneError: "false" },
    ]);
    expect(context.published.some(({ envelope }) => envelope.type === "seat.approved")).toBe(false);
    expect(context.published.find(({ envelope }) => envelope.type === "chat.message")?.envelope.payload)
      .toEqual({ value: "hello" });
  });

  it("取消订阅后解绑当前角色事件，不操作页面登录", async () => {
    const context = setup();
    await context.rtm.subscribeRoom();

    await context.rtm.unsubscribeRoom();
    context.emit("storage", storageEvent(8));

    expect(context.operations).toEqual(["subscribe:room-1", "unsubscribe:room-1"]);
    expect(context.metadata).not.toHaveBeenCalled();
  });

  it("trace 展示 key/value、麦位 nickname、频道和消息发送方，不展示 revision", async () => {
    const context = setup();
    await context.rtm.subscribeRoom();
    await context.rtm.initializeMemberState("Host");
    await context.rtm.initializeRoom([{ key: "hostUserId", value: "host-1" }], 1, "hostUserId=Host");
    const seats = {
      "seat-0": { seatId: "seat-0", userId: "host-1", displayName: "Host" },
      "seat-1": { seatId: "seat-1", userId: "audience-2", displayName: "Alice_037" },
    };
    await context.rtm.updateSeats(seats);
    context.emit("presence", {
      timestamp: 2,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "REMOTE_STATE_CHANGED",
      publisher: "audience-2",
      stateChanged: { displayName: "Alice_037", muted: "true" },
    } as unknown as RTMEvents.PresenceEvent);
    context.emit("storage", {
      ...storageEvent(2),
      data: { majorRevision: 2, totalCount: 1, metadata: { seats: { value: JSON.stringify(seats), revision: 2 } } },
    } as unknown as RTMEvents.StorageEvent);
    const message = {
      schemaVersion: 1,
      messageId: "msg-visible",
      type: "chat.message",
      roomId: "room-1",
      sentAt: 900,
      expiresAt: 2_000,
      payload: { value: "hello" },
    };
    context.emit("message", {
      timestamp: 3,
      channelType: "MESSAGE",
      channelName: "room-1",
      topicName: "",
      messageType: "STRING",
      customType: "",
      message: JSON.stringify(message),
      publisher: "audience-2",
    });

    const traces = context.rtm.getTraces();
    const summaries = traces.map(({ summary }) => summary);
    expect(summaries).toEqual(expect.arrayContaining([
      "room-1: displayName=Host, muted=false",
      "room-1: hostUserId=Host",
      "room-1: seats=1号麦 Host, 2号麦 Alice_037",
      "Alice_037 muted=true",
      "1号麦 Host, 2号麦 Alice_037",
      "chat.message from Alice_037: hello",
    ]));
    expect(traces.find(({ name }) => name === "presence")?.eventTag).toBe("REMOTE_STATE_CHANGED");
    expect(traces.find(({ name }) => name === "storage")?.eventTag).toBe("SNAPSHOT");
    expect(traces.find(({ name }) => name === "message")?.eventTag).toBe("MESSAGE");
    expect(traces.find(({ name }) => name === "presence.setState")?.summary).toContain("room-1");
    expect(traces.find(({ name }) => name === "storage")?.summary).not.toContain("revision");
  });

  it("Presence JOIN 没有 nickname 时 trace 展示暂无昵称", async () => {
    const context = setup();
    await context.rtm.subscribeRoom();
    context.emit("presence", {
      timestamp: 2,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "REMOTE_JOIN",
      publisher: "audience-unknown",
      stateChanged: {},
    } as unknown as RTMEvents.PresenceEvent);

    expect(context.rtm.getTraces().find(({ name }) => name === "presence")).toMatchObject({
      eventTag: "REMOTE_JOIN",
      summary: "暂无昵称",
    });
  });
});
