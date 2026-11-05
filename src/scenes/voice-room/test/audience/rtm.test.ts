import type { RTMEvents } from "agora-rtm";
import { describe, expect, it, vi } from "vitest";

import type {
  AppRoomRtmPort,
  AppRtmEventListeners,
} from "../../app-rtm";
import {
  createAudienceRoomRtm,
  type AudienceRoomRtmSession,
} from "../../audience/rtm";
import { createAudienceOnRtmEvent } from "../../audience/onRtmEvent";

function setup(roomId = "room-1") {
  const operations: string[] = [];
  const presenceStates: Record<string, string>[] = [];
  const presenceRemovals: string[][] = [];
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
    async removePresenceState(roomId, keys) {
      operations.push(`presence:remove:${roomId}`);
      presenceRemovals.push([...keys]);
    },
    async removeRoomMetadata() { throw new Error("Audience 不应删除 Storage"); },
    async setRoomMetadata() { throw new Error("Audience 不应写 Storage"); },
  };
  const session: AudienceRoomRtmSession = {
    getRoomPort: () => port,
  };
  const eventSource = {
    bindRtmEvents(next: AppRtmEventListeners) {
      handlers = next;
      return () => { if (handlers === next) handlers = {}; };
    },
  };
  const presence = vi.fn();
  const metadata = vi.fn();
  const names: Record<string, string> = { "audience-1": "Alice_037", "host-1": "Host" };
  let monotonicNow = 10;
  const rtm = createAudienceRoomRtm({
    roomId,
    userId: "audience-1",
    session,
    events: createAudienceOnRtmEvent({
      roomId,
      userId: "audience-1",
      source: eventSource,
      listeners: {
        onLinkState: () => undefined,
        onPresence: presence,
        onMetadata: metadata,
        onMessage: (envelope, context) => {
          const content = envelope.type === "chat.message" && typeof envelope.payload.value === "string"
            ? `: ${envelope.payload.value}`
            : "";
          return { summary: `${envelope.type} from ${names[context.publisher] ?? "暂无昵称"}${content}` };
        },
      },
      now: () => 1_000,
    }),
    describeUser: (userId) => names[userId],
    now: () => 1_000,
    monotonicNow: () => monotonicNow,
  });

  return {
    rtm,
    operations,
    presenceStates,
    presenceRemovals,
    published,
    presence,
    metadata,
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

describe("AudienceRoomRtm", () => {
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
    await context.rtm.initializeMemberState("Alice_037");
    await context.rtm.requestSeat("host-1", { requestId: "request-1", seatId: "seat-1" });
    await context.rtm.sendGiftMessage();
    await context.rtm.clearSeatMediaState();
    await context.rtm.unsubscribeRoom();

    expect(context.rtm.getTraces()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "rtm.subscribe", summary: "voice-room-...-d2e9" }),
      expect.objectContaining({ name: "presence.setState", summary: "voice-room-...-d2e9: displayName=Alice_037" }),
      expect.objectContaining({ name: "rtm.publish", eventTag: "USER", summary: "to Host seat.request 2号麦" }),
      expect.objectContaining({ name: "rtm.publish", eventTag: "MESSAGE", summary: "voice-room-...-d2e9: to ALL gift.sent" }),
      expect.objectContaining({ name: "presence.removeState", summary: "voice-room-...-d2e9: muted, microphoneError" }),
      expect.objectContaining({ name: "rtm.unsubscribe", summary: "voice-room-...-d2e9" }),
    ]));
  });

  it("subscribeRoom resolve 不等待 Presence 或 Storage，也不补读 metadata", async () => {
    const context = setup();

    await context.rtm.subscribeRoom();

    expect(context.operations).toEqual(["subscribe:room-1"]);
    expect(context.metadata).not.toHaveBeenCalled();
  });

  it("订阅后只用 Presence 事件推送成员状态", async () => {
    const context = setup();
    await context.rtm.subscribeRoom();
    const event = {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "SNAPSHOT",
      publisher: "",
      states: [],
      snapshot: [],
      interval: null,
    } as unknown as RTMEvents.PresenceEvent;

    context.emit("presence", event);

    expect(context.presence).toHaveBeenCalledWith(event);
    expect(context.operations).toEqual(["subscribe:room-1"]);
  });

  it("对外接口没有 Storage 写入，仍可发布 USER/房间消息和 Presence State", async () => {
    const context = setup();

    await context.rtm.requestSeat("host-1", { requestId: "request-1", seatId: "seat-1" });
    await context.rtm.acceptSeatInvitation("host-1", "invitation-1", "seat-2");
    await context.rtm.rejectSeatInvitation("host-1", "invitation-2");
    await context.rtm.leaveSeat("host-1", "seat-2");
    await context.rtm.sendChatMessage("hello");
    await context.rtm.sendGiftMessage();
    await context.rtm.sendHeartMessage();
    await context.rtm.muteMicrophone();
    await context.rtm.unmuteMicrophone();
    await context.rtm.reportMicrophoneError();
    await context.rtm.clearMicrophoneError();
    await context.rtm.clearSeatMediaState();

    expect(context.operations).toEqual([
      "publish:USER:host-1:seat.request",
      "publish:USER:host-1:seat.invitation.accepted",
      "publish:USER:host-1:seat.invitation.rejected",
      "publish:USER:host-1:seat.left",
      "publish:MESSAGE:room-1:chat.message",
      "publish:MESSAGE:room-1:gift.sent",
      "publish:MESSAGE:room-1:emoji.reaction",
      "presence:room-1",
      "presence:room-1",
      "presence:room-1",
      "presence:room-1",
      "presence:remove:room-1",
    ]);
    expect(context.presenceStates.slice(-2)).toEqual([
      { microphoneError: "true" },
      { microphoneError: "false" },
    ]);
    expect(context.presenceRemovals).toEqual([["muted", "microphoneError"]]);
    expect("setRoomMetadata" in context.rtm).toBe(false);
    expect(context.published.find(({ envelope }) => envelope.type === "seat.request")?.envelope.payload)
      .toEqual({ requestId: "request-1", seatId: "seat-1" });
    expect(context.published.find(({ envelope }) => envelope.type === "seat.invitation.accepted")?.envelope.payload)
      .toEqual({ invitationId: "invitation-1", seatId: "seat-2" });
    expect(context.published.find(({ envelope }) => envelope.type === "chat.message")?.envelope.payload)
      .toEqual({ value: "hello" });
  });

  it("取消订阅后不再消费房间事件", async () => {
    const context = setup();
    await context.rtm.subscribeRoom();
    await context.rtm.unsubscribeRoom();

    context.emit("presence", { channelName: "room-1" } as RTMEvents.PresenceEvent);

    expect(context.presence).not.toHaveBeenCalled();
    expect(context.operations).toEqual(["subscribe:room-1", "unsubscribe:room-1"]);
  });

  it("Audience trace 用 nickname 标识 Presence state 与消息发送方", async () => {
    const context = setup();
    await context.rtm.subscribeRoom();
    await context.rtm.muteMicrophone();
    await context.rtm.sendGiftMessage();

    expect(context.rtm.getTraces().map(({ summary }) => summary)).toEqual(expect.arrayContaining([
      "room-1: muted=true",
      "room-1: to ALL gift.sent",
    ]));
  });

  it("仅初始化 displayName 时 API trace 仍展示详情", async () => {
    const context = setup();

    await context.rtm.initializeMemberState("Alice_037");

    expect(context.rtm.getTraces()).toContainEqual(
      expect.objectContaining({
        name: "presence.setState",
        summary: "room-1: displayName=Alice_037",
      }),
    );
  });
});
