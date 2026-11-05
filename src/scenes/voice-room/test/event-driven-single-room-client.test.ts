import type { RTMEvents } from "agora-rtm";
import { describe, expect, it, vi } from "vitest";

import type { RtcHelper } from "../../../shared/rtc";
import type {
  AppRoomRtmPort,
  AppRtmEventListeners,
  AppRtmClient,
} from "../app-rtm";
import { AppRtmSession } from "../app-rtm";
import {
  SingleRoomClient,
  abbreviateUserId,
  createInitialRoomSnapshot,
} from "../event-driven-single-room-client";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(role: "host" | "audience", options: {
  failPublish?: boolean;
  captureHealthy?: boolean;
  onBanUser?: (userId: string) => void;
  onRoomDissolved?: () => void;
  onRoomCleanup?: () => void | Promise<void>;
  cleanupRetryDelay?: () => Promise<void>;
  now?: () => number;
  holdSeatRequestPublish?: boolean;
  holdRtcJoin?: boolean;
  failUserMessageType?: string;
  displayName?: string;
} = {}) {
  const operations: string[] = [];
  const presenceStates: Record<string, string>[] = [];
  const presenceRemovals: string[][] = [];
  let failPublish = options.failPublish ?? false;
  let captureHealthy = options.captureHealthy ?? true;
  let handlers: AppRtmEventListeners = {};
  const subscription = deferred();
  const seatRequestPublish = deferred();
  const rtcJoin = deferred();
  const port: AppRoomRtmPort = {
    async subscribe(roomId) { operations.push(`rtm:subscribe:${roomId}`); await subscription.promise; },
    async unsubscribe(roomId) { operations.push(`rtm:unsubscribe:${roomId}`); },
    async publish(channelName, message, channelType) {
      const type = JSON.parse(message).type;
      operations.push(`rtm:publish:${channelType}:${channelName}:${type}`);
      if (channelType === "USER" && options.failUserMessageType === type) {
        throw Object.assign(new Error("USER_OFFLINE"), { errorCode: -11033 });
      }
      if (options.holdSeatRequestPublish && type === "seat.request") await seatRequestPublish.promise;
    },
    async setPresenceState(roomId, state) {
      operations.push(`presence:set:${roomId}:${state.displayName ?? ""}:${state.muted ?? ""}`);
      presenceStates.push(state);
    },
    async removePresenceState(roomId, keys) {
      operations.push(`presence:remove:${roomId}:${keys.join(",")}`);
      presenceRemovals.push([...keys]);
    },
    async removeRoomMetadata(roomId) { operations.push(`storage:remove:${roomId}`); },
    async setRoomMetadata(roomId, data, majorRevision) {
      operations.push(`storage:set:${roomId}:${data.map(({ key }) => key).join(",")}:${majorRevision ?? "none"}`);
    },
  };
  const session = {
    getRoomPort: () => port,
    bindRtmEvents(next: AppRtmEventListeners) {
      handlers = next;
      return () => { if (handlers === next) handlers = {}; };
    },
  } as AppRtmSession;
  const rtc: RtcHelper = {
    registerEvents() {},
    async join() {
      operations.push("rtc:join");
      if (options.holdRtcJoin) await rtcJoin.promise;
    },
    async leave() { operations.push("rtc:leave"); },
    async publishMicrophone() {
      operations.push("rtc:publishMicrophone");
      if (failPublish) throw new Error("设备被占用");
    },
    async unpublishMicrophone() { operations.push("rtc:unpublishMicrophone"); },
    async setMicrophoneMuted(muted) { operations.push(`rtc:mute:${muted}`); },
    isMicrophoneCaptureHealthy() { return captureHealthy; },
    async publishCamera() {},
    async unpublishCamera() {},
    async setCameraMuted() {},
    getLocalVideoTrack: () => undefined,
  };
  const client = new SingleRoomClient({
    appId: "app",
    roomId: "room-1",
    roomName: "测试房间",
    hostUserId: "host-1",
    userId: role === "host" ? "host-1" : "audience-1",
    displayName: options.displayName ?? (role === "host" ? "Host" : "Audience"),
    role,
    session,
    createRtc: () => rtc,
    onBanUser: options.onBanUser,
    onRoomDissolved: options.onRoomDissolved,
    onRoomCleanup: options.onRoomCleanup,
    cleanupRetryDelay: options.cleanupRetryDelay,
    now: options.now,
  });
  return {
    client,
    port,
    rtc,
    operations,
    presenceStates,
    presenceRemovals,
    setPublishFailure(value: boolean) { failPublish = value; },
    setCaptureHealthy(value: boolean) { captureHealthy = value; },
    resolveSeatRequestPublish: seatRequestPublish.resolve,
    resolveSubscribe: subscription.resolve,
    resolveRtcJoin: rtcJoin.resolve,
    emit<Event extends keyof AppRtmEventListeners>(
      name: Event,
      event: Parameters<NonNullable<AppRtmEventListeners[Event]>>[0],
    ) {
      const handler = handlers[name] as ((value: typeof event) => void) | undefined;
      handler?.(event);
    },
  };
}

function storageEvent(
  majorRevision: number,
  metadata: Record<string, { value: string }>,
  eventType: "SNAPSHOT" | "UPDATE" = "SNAPSHOT",
): RTMEvents.StorageEvent {
  return {
    timestamp: majorRevision,
    channelName: "room-1",
    channelType: "MESSAGE",
    storageType: "CHANNEL",
    eventType,
    publisher: "",
    data: { majorRevision, totalCount: Object.keys(metadata).length, metadata },
  } as unknown as RTMEvents.StorageEvent;
}

function metadata(snapshot = createInitialRoomSnapshot("host-1", "Host", 5)) {
  return {
    hostUserId: { value: snapshot.hostUserId },
    announcement: { value: snapshot.announcement },
    seats: { value: JSON.stringify(snapshot.seats) },
    forcedMutedUserIds: { value: JSON.stringify(snapshot.forcedMutedUserIds) },
  };
}

describe("Presence nickname 展示", () => {
  it("Presence 没有 nickname 时只展示省略后的 UID", () => {
    expect(abbreviateUserId("audience-user-1234567890")).toBe("audie…7890");
    expect(abbreviateUserId("host-1")).toBe("host-1");
  });

  it.each(['host', 'audience'] as const)("%s 没有本端事件时仅在 Presence 成功后显示昵称，聊天信封不携带昵称", async role => {
    const context = setup(role, { displayName: '小明 👩‍💻' });
    const initialization = deferred();
    const presence = vi.spyOn(context.port, 'setPresenceState').mockReturnValueOnce(initialization.promise);
    const publish = vi.spyOn(context.port, 'publish');
    const changed = vi.fn();
    const unsubscribe = context.client.subscribe(changed);
    const userId = role === 'host' ? 'host-1' : 'audience-1';
    try {
      const entering = context.client.enterRoom();
      expect(presence).toHaveBeenCalledWith('room-1', role === 'host'
        ? { displayName: '小明 👩‍💻', muted: 'false' }
        : { displayName: '小明 👩‍💻' });
      expect(context.operations.some(operation => operation.startsWith('rtm:subscribe'))).toBe(false);
      initialization.resolve();
      await vi.waitFor(() => expect(context.operations).toContain('rtm:subscribe:room-1'));
      context.resolveSubscribe();
      await entering;
      context.emit('presence', {
        timestamp: 1, channelName: 'room-1', channelType: 'MESSAGE', eventType: 'SNAPSHOT', publisher: '', interval: null,
        snapshot: [
          { userId, states: { displayName: '小明 👩‍💻' }, statesCount: 1 },
          { userId: 'remote-user', states: { displayName: '远端昵称' }, statesCount: 1 },
        ],
      } as unknown as RTMEvents.PresenceEvent);
      expect(context.client.getNickNameByUid(userId)).toBe('小明 👩‍💻');
      expect(changed).toHaveBeenCalled();
      expect(context.client.getView().memberNames).toEqual({ [userId]: '小明 👩‍💻', 'remote-user': '远端昵称' });
      expect(context.client.getView().onlineUsers).toEqual([userId, 'remote-user']);
      await context.client.sendInteraction('chat.message', '你好');
      const [channel, message, channelType] = publish.mock.calls.at(-1)!;
      const envelope = JSON.parse(message);
      expect([channel, channelType]).toEqual(['room-1', 'MESSAGE']);
      expect(envelope.payload).toEqual({ value: '你好' });
      expect(envelope).not.toHaveProperty('nickname');
      expect(context.client.getView()).toMatchObject({ userId, displayName: '小明 👩‍💻' });
    } finally { initialization.resolve(); unsubscribe(); await context.client.leaveRoom(); }
  });

  it.each(['host', 'audience'] as const)('%s 初始化 Presence 失败不会写入本端昵称', async role => {
    const context = setup(role, { displayName: '失败时不显示' });
    vi.spyOn(context.port, 'setPresenceState').mockRejectedValueOnce(new Error('初始化请求失败'));
    const userId = role === 'host' ? 'host-1' : 'audience-1';
    try {
      await expect(context.client.enterRoom()).rejects.toThrow('初始化请求失败');
      expect(context.operations.some(operation => operation.startsWith('rtm:subscribe'))).toBe(false);
      expect(context.client.getNickNameByUid(userId)).toBeUndefined();
      expect(context.client.getMemberDisplayName(userId)).toBe(role === 'host' ? 'Host' : userId);
    } finally { await context.client.leaveRoom(); }
  });

  it('Audience 缺少 Host Presence nickname 时仍把房主展示为 Host', () => {
    const context = setup('audience');

    expect(context.client.getNickNameByUid('host-1')).toBeUndefined();
    expect(context.client.getMemberDisplayName('host-1')).toBe('Host');
  });

  it.each(['host', 'audience'] as const)('%s 离房后迟到的 Presence 成功不恢复昵称或发布视图', async role => {
    const context = setup(role, { displayName: '迟到昵称' });
    const initialization = deferred();
    vi.spyOn(context.port, 'setPresenceState').mockReturnValueOnce(initialization.promise);
    const changed = vi.fn();
    const unsubscribe = context.client.subscribe(changed);
    try {
      const entering = context.client.enterRoom();
      await context.client.leaveRoom();
      changed.mockClear();
      initialization.resolve();
      await expect(entering).rejects.toThrow('加入房间已取消');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(context.client.getView().memberNames).toEqual({});
      expect(context.client.getView().onlineUsers).toEqual([]);
      expect(changed).not.toHaveBeenCalled();
    } finally { initialization.resolve(); unsubscribe(); await context.client.leaveRoom(); }
  });

  it('同名成员的排麦和聊天保留独立 UID，邀请、强制静音及封禁只命中目标', async () => {
    const onBanUser = vi.fn();
    const context = setup('host', { onBanUser });
    try {
      const entering = context.client.enterRoom();
      context.resolveSubscribe();
      await entering;
      context.emit('storage', storageEvent(1, metadata()));
      context.emit('presence', {
        timestamp: 1, channelName: 'room-1', channelType: 'MESSAGE', eventType: 'SNAPSHOT', publisher: '', interval: null,
        snapshot: ['audience-2', 'audience-3'].map(userId => ({ userId, states: { displayName: '小明' }, statesCount: 1 })),
      } as unknown as RTMEvents.PresenceEvent);
      const sentAt = Date.now();
      for (const [index, publisher] of ['audience-2', 'audience-3'].entries()) {
        for (const type of ['seat.request', 'chat.message']) {
          context.emit('message', {
            timestamp: sentAt, channelType: type === 'seat.request' ? 'USER' : 'MESSAGE',
            channelName: type === 'seat.request' ? 'host-1' : 'room-1', publisher,
            topicName: '', messageType: 'STRING', customType: '',
            message: JSON.stringify({ schemaVersion: 1, messageId: `${publisher}-${type}`, type, roomId: 'room-1',
              ...(type === 'seat.request' ? { targetUserId: 'host-1' } : {}), sentAt, expiresAt: sentAt + 15_000,
              payload: type === 'seat.request' ? { requestId: `request-${index}`, seatId: `seat-${index + 1}` } : { value: `消息 ${index}` } }),
          });
        }
      }
      await vi.waitFor(() => expect(context.client.getView().queue).toHaveLength(2));
      expect(context.client.getView().queue.map(({ userId, displayName }) => ({ userId, displayName }))).toEqual([
        { userId: 'audience-2', displayName: '小明' }, { userId: 'audience-3', displayName: '小明' },
      ]);
      expect(context.client.getView().interactions.filter(item => item.type === 'chat').map(({ senderId, displayName }) => ({ senderId, displayName }))).toEqual([
        { senderId: 'audience-2', displayName: '小明' }, { senderId: 'audience-3', displayName: '小明' },
      ]);
      await context.client.invite('audience-2', 'seat-1');
      expect(context.operations).toContain('rtm:publish:USER:audience-2:seat.invited');
      await context.client.approveSeatRequest('request-1');
      expect(context.client.getView().snapshot.seats['seat-2'].userId).toBe('audience-3');
      expect(context.client.getView().snapshot.seats['seat-1'].userId).toBeNull();
      await context.client.approveSeatRequest('request-0');
      await context.client.forceMute('audience-3', true);
      expect(context.client.getView().snapshot.forcedMutedUserIds).toEqual(['audience-3']);
      await context.client.banMember('audience-3');
      expect(onBanUser).toHaveBeenCalledExactlyOnceWith('audience-3');
      expect(context.operations).toContain('rtm:publish:USER:audience-3:member.ban');
      expect(context.operations).not.toContain('rtm:publish:USER:audience-2:member.ban');
      expect(context.client.getView().snapshot.seats['seat-1'].userId).toBe('audience-2');
      expect(context.client.getView().snapshot.seats['seat-2'].userId).toBeNull();
      expect(context.client.getMemberDisplayName('audience-2')).toBe('小明');
      expect(context.client.getMemberDisplayName('audience-3')).toBe('小明');
    } finally { await context.client.leaveRoom(); }
  });
});

describe("事件驱动 SingleRoomClient", () => {
  it("页面登录早于角色绑定时，UI 继承 connected 但不伪造历史 linkState trace", async () => {
    const sdkListeners = new Map<string, Set<(event: never) => void>>();
    const emit = (name: string, event: unknown) => {
      for (const listener of sdkListeners.get(name) ?? []) listener(event as never);
    };
    const sdkClient: AppRtmClient = {
      addEventListener(name, listener) {
        const listeners = sdkListeners.get(name) ?? new Set();
        listeners.add(listener as (event: never) => void);
        sdkListeners.set(name, listeners);
      },
      removeEventListener(name, listener) {
        sdkListeners.get(name)?.delete(listener as (event: never) => void);
      },
      async login() {
        emit("linkState", {
          timestamp: 1,
          previousState: "CONNECTING",
          currentState: "CONNECTED",
          operation: "LOGIN",
          reasonCode: "LOGIN_SUCCESS",
          reason: "",
          affectedChannels: [],
          unrestoredChannels: [],
          isResumed: false,
          serviceType: "RTM",
        });
      },
      async logout() {},
      async subscribe() {},
      async unsubscribe() {},
      async publish() {},
      presence: {
        async setState() {},
        async removeState() {},
      },
      storage: {
        async getChannelMetadata() { return { majorRevision: 0, totalCount: 0, metadata: {} }; },
        async setChannelMetadata() {},
        async removeChannelMetadata() {},
      },
    };
    const session = new AppRtmSession("app", "audience-1", {
      createClient: () => sdkClient,
    });
    await session.login();
    const noopRtc: RtcHelper = {
      registerEvents() {},
      async join() {},
      async leave() {},
      async publishMicrophone() {},
      async unpublishMicrophone() {},
      async setMicrophoneMuted() {},
      isMicrophoneCaptureHealthy: () => true,
      async publishCamera() {},
      async unpublishCamera() {},
      async setCameraMuted() {},
      getLocalVideoTrack: () => undefined,
    };
    const client = new SingleRoomClient({
      appId: "app",
      roomId: "room-1",
      roomName: "测试房间",
      hostUserId: "host-1",
      userId: "audience-1",
      displayName: "Audience",
      role: "audience",
      session,
      createRtc: () => noopRtc,
    });

    await client.enterRoom();

    expect(client.getView().linkState).toBe("connected");
    expect(client.getTraces().some((entry) => entry.name === "linkState")).toBe(false);

    emit("linkState", {
      timestamp: 2,
      previousState: "CONNECTED",
      currentState: "DISCONNECTED",
      operation: "AUTO_RECONNECT",
      reasonCode: "INTERRUPTED",
      reason: "",
      affectedChannels: ["room-1"],
      unrestoredChannels: [],
      isResumed: false,
      serviceType: "RTM",
    });

    expect(client.getView().linkState).toBe("reconnecting");
    expect(client.getTraces().some((entry) => entry.name === "linkState")).toBe(false);
    expect(session.getTraces()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "event", name: "linkState", role: "app" }),
    ]));
  });

  it("订阅完成即结束 pending，并以初始 store 渲染，不等待 Presence、Storage 或 RTC", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    expect(context.operations).toEqual(["presence:set:room-1:Audience:"]);
    await vi.waitFor(() => expect(context.client.getView().subscribing).toBe(true));
    expect(context.client.getView().snapshot.hostUserId).toBe("host-1");

    context.resolveSubscribe();
    await entering;

    expect(context.client.getView().subscribing).toBe(false);
    expect(context.client.getView().snapshot).toMatchObject({
      majorRevision: 0,
      hostUserId: "host-1",
      announcement: "",
    });
    expect(context.operations).toEqual([
      "presence:set:room-1:Audience:",
      "rtm:subscribe:room-1",
    ]);
    await vi.waitFor(() => expect(context.operations).toContain("rtc:join"));
  });

  it("RTC join pending 不阻塞 enterRoom 完成", async () => {
    const context = setup("host", { holdRtcJoin: true });
    const entering = context.client.enterRoom();

    context.resolveSubscribe();
    await expect(entering).resolves.toBeUndefined();

    expect(context.operations).not.toContain("rtc:join");
    expect(context.client.getView().subscribing).toBe(false);
    expect(context.client.getView().snapshot.hostUserId).toBe("host-1");

    await vi.waitFor(() => expect(context.operations).toContain("rtc:join"));
    context.resolveRtcJoin();
    await Promise.resolve();
  });

  it("Host 空 SNAPSHOT 只用本次 majorRevision 初始化四个 key", async () => {
    const context = setup("host");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;

    context.emit("storage", storageEvent(3, {}));
    await vi.waitFor(() => {
      expect(context.client.getView().snapshot?.hostUserId).toBe("host-1");
    });

    expect(context.operations).toContain(
      "storage:set:room-1:hostUserId,announcement,seats,forcedMutedUserIds:3",
    );
  });

  it("Storage 全量事件原子建立快照，低 majorRevision 事件被忽略", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const latest = createInitialRoomSnapshot("host-1", "Host", 7);
    latest.announcement = "最新公告";

    context.emit("storage", storageEvent(7, metadata(latest), "UPDATE"));
    context.emit("storage", storageEvent(6, metadata({ ...latest, majorRevision: 6, announcement: "旧公告" })));

    expect(context.client.getView().snapshot?.announcement).toBe("最新公告");
    expect(context.operations.some((operation) => operation.includes("storage:get"))).toBe(false);
  });

  it("Presence State 维护 UID 到 nickname 映射，离开后删除", async () => {
    const context = setup("host");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;

    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "SNAPSHOT",
      publisher: "",
      snapshot: [
        { userId: "host-1", states: { displayName: "Host" }, statesCount: 1 },
        { userId: "audience-2", states: { displayName: "Alice_037", muted: "true", microphoneError: "false" }, statesCount: 3 },
      ],
      interval: null,
    } as unknown as RTMEvents.PresenceEvent);

    expect(context.client.getView().memberNames).toMatchObject({
      "host-1": "Host",
      "audience-2": "Alice_037",
    });
    expect(context.client.getView().memberMuted["audience-2"]).toBe(true);
    expect(context.client.getView().memberMicrophoneErrors["audience-2"]).toBe(false);

    context.emit("presence", {
      timestamp: 2,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "REMOTE_STATE_CHANGED",
      publisher: "audience-2",
      stateChanged: { displayName: "Alice_037", muted: "true", microphoneError: "true" },
    } as unknown as RTMEvents.PresenceEvent);

    expect(context.client.getTraces().filter(({ name }) => name === "presence").at(-1)?.summary)
      .toBe("Alice_037 (audience-2) microphoneError=true");
    expect(context.client.getView().memberMicrophoneErrors["audience-2"]).toBe(true);

    context.emit("presence", {
      timestamp: 3,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "REMOTE_LEAVE",
      publisher: "audience-2",
    } as RTMEvents.PresenceEvent);

    expect(context.client.getView().memberNames["audience-2"]).toBeUndefined();
    expect(context.client.getView().memberMuted["audience-2"]).toBeUndefined();
    expect(context.client.getView().memberMicrophoneErrors["audience-2"]).toBeUndefined();
  });

  it("REMOTE_STATE_CHANGED 仅携带 displayName 时仍保留事件详情", async () => {
    const context = setup("host");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;

    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "REMOTE_STATE_CHANGED",
      publisher: "audience-2",
      stateChanged: { displayName: "Emma_301" },
    } as unknown as RTMEvents.PresenceEvent);

    expect(context.client.getTraces().filter(({ name }) => name === "presence").at(-1)?.summary)
      .toBe("Emma_301 (audience-2)");
  });

  it.each(["REMOTE_JOIN", "REMOTE_LEAVE", "REMOTE_TIMEOUT"] as const)("%s trace 同时展示昵称和缩写 UID", async eventType => {
    const context = setup("host");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;

    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType,
      publisher: "audience-user-1234567890",
      stateChanged: eventType === "REMOTE_JOIN" ? { displayName: "小明" } : {},
    } as unknown as RTMEvents.PresenceEvent);

    expect(context.client.getTraces().filter(({ name }) => name === "presence").at(-1)?.summary)
      .toBe(eventType === "REMOTE_JOIN" ? "小明 (audie…7890)" : "audie…7890");
  });

  it("Presence INTERVAL 不生成 trace 也不消费业务状态", async () => {
    const context = setup("host");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const before = context.client.getTraces().length;

    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "INTERVAL",
      publisher: "",
      interval: { join: [], leave: [], timeout: [], stateChanged: [] },
    } as unknown as RTMEvents.PresenceEvent);

    expect(context.client.getTraces()).toHaveLength(before);
  });

  it("Presence SNAPSHOT 为缺失字段应用默认值并清除旧状态", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;

    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "REMOTE_STATE_CHANGED",
      publisher: "audience-1",
      stateChanged: { displayName: "旧昵称", muted: "true", microphoneError: "true" },
    } as unknown as RTMEvents.PresenceEvent);
    expect(context.client.getView().ownMuted).toBe(true);

    context.emit("presence", {
      timestamp: 2,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "SNAPSHOT",
      publisher: "",
      snapshot: [{ userId: "audience-1", states: {}, statesCount: 0 }],
      interval: null,
    } as unknown as RTMEvents.PresenceEvent);

    expect(context.client.getNickNameByUid("audience-1")).toBeUndefined();
    expect(context.client.getMemberDisplayName("audience-1")).toBe("audience-1");
    expect(context.client.getView().ownMuted).toBe(false);
    expect(context.client.getView().memberMuted["audience-1"]).toBeUndefined();
    expect(context.client.getView().memberMicrophoneErrors["audience-1"]).toBeUndefined();
  });

  it("P2P 与公屏消息不携带 nickname，接收方通过 getNickNameByUid 解析", async () => {
    const context = setup("host");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "SNAPSHOT",
      publisher: "",
      snapshot: [
        { userId: "host-1", states: { displayName: "Host" }, statesCount: 1 },
        { userId: "audience-2", states: { displayName: "Alice_037" }, statesCount: 1 },
      ],
      interval: null,
    } as unknown as RTMEvents.PresenceEvent);
    const sentAt = Date.now();
    const envelope = (messageId: string, type: string, payload: Record<string, unknown>, targetUserId?: string) => JSON.stringify({
      schemaVersion: 1,
      messageId,
      type,
      roomId: "room-1",
      ...(targetUserId ? { targetUserId } : {}),
      sentAt,
      expiresAt: sentAt + 15_000,
      payload,
    });
    context.emit("message", {
      timestamp: 2,
      channelType: "USER",
      channelName: "host-1",
      topicName: "",
      messageType: "STRING",
      customType: "",
      message: envelope("request-message", "seat.request", { requestId: "request-1", seatId: "seat-1" }, "host-1"),
      publisher: "audience-2",
    });
    expect(context.client.getTraces().filter(({ name }) => name === "message").at(-1)?.summary)
      .toBe("seat.request 2号麦 from Alice_037");
    context.emit("message", {
      timestamp: 3,
      channelType: "MESSAGE",
      channelName: "room-1",
      topicName: "",
      messageType: "STRING",
      customType: "",
      message: envelope("chat-message", "chat.message", { value: "hello" }),
      publisher: "audience-2",
    });
    await Promise.resolve();

    expect(context.client.getNickNameByUid("audience-2")).toBe("Alice_037");
    await vi.waitFor(() => expect(context.client.getView().queue[0]?.displayName).toBe("Alice_037"));
    expect(context.client.getView().interactions.at(-1)).toMatchObject({
      type: "chat",
      displayName: "Alice_037",
      value: "hello",
    });
    expect(context.client.getTraces().filter(({ name }) => name === "message").at(-1)?.summary)
      .toBe("chat.message from Alice_037: hello");
    expect(context.client.getView().notice).toBe("Alice_037 申请 2 号麦位");
  });

  it("Host 排麦申请显示 30 秒倒计时并在到期后自动清空", async () => {
    vi.useFakeTimers();
    try {
      const context = setup("host");
      const entering = context.client.enterRoom();
      context.resolveSubscribe();
      await entering;
      const now = Date.now();
      context.emit("message", {
        timestamp: now,
        channelName: "host-1",
        channelType: "USER",
        publisher: "audience-2",
        messageType: "STRING",
        message: JSON.stringify({
          schemaVersion: 1,
          messageId: "seat-request-timeout",
          type: "seat.request",
          roomId: "room-1",
          targetUserId: "host-1",
          sentAt: now,
          expiresAt: now + 15_000,
          payload: { requestId: "request-timeout", seatId: "seat-1" },
        }),
      } as unknown as RTMEvents.MessageEvent);

      expect(context.client.getView().queue[0]?.remainingSeconds).toBe(30);
      vi.advanceTimersByTime(1_000);
      expect(context.client.getView().queue[0]?.remainingSeconds).toBe(29);
      vi.advanceTimersByTime(29_000);
      expect(context.client.getView().queue).toEqual([]);
      await context.client.leaveRoom();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Audience 快速连续点击时在第一次 publish 完成前就锁定等待态，只发送一次申请", async () => {
    const context = setup("audience", { holdSeatRequestPublish: true });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    context.emit("storage", storageEvent(1, metadata(createInitialRoomSnapshot("host-1", "Host", 1))));
    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "SNAPSHOT",
      publisher: "",
      snapshot: [
        { userId: "host-1", states: { displayName: "Host" }, statesCount: 1 },
        { userId: "audience-1", states: { displayName: "Audience" }, statesCount: 1 },
      ],
      interval: null,
    } as unknown as RTMEvents.PresenceEvent);

    const first = context.client.requestSeat("seat-1");
    const second = context.client.requestSeat("seat-1");

    expect(context.client.getView().waitingSeatId).toBe("seat-1");
    expect(context.operations.filter((operation) => operation.endsWith(":seat.request"))).toHaveLength(1);
    expect(context.operations).toContain("rtm:publish:USER:host-1:seat.request");
    expect(context.operations).not.toContain("rtm:publish:MESSAGE:room-1:seat.request");

    context.resolveSeatRequestPublish();
    await Promise.all([first, second]);
    await context.client.leaveRoom();
  });

  it("Audience 上麦申请点对点发送失败时提示 Host 不在线并解除等待态", async () => {
    const context = setup("audience", { failUserMessageType: "seat.request" });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    context.emit("storage", storageEvent(1, metadata(createInitialRoomSnapshot("host-1", "Host", 1))));
    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "SNAPSHOT",
      publisher: "",
      snapshot: [
        { userId: "host-1", states: { displayName: "Host" }, statesCount: 1 },
        { userId: "audience-1", states: { displayName: "Audience" }, statesCount: 1 },
      ],
      interval: null,
    } as unknown as RTMEvents.PresenceEvent);

    await context.client.requestSeat("seat-1");

    expect(context.operations).toContain("rtm:publish:USER:host-1:seat.request");
    expect(context.client.getView().waitingSeatId).toBeUndefined();
    expect(context.client.getView().error).toBe("Host 不在线");
    await context.client.leaveRoom();
  });

  it("Host 上麦邀请点对点发送失败时提示目标观众不在线", async () => {
    const context = setup("host", { failUserMessageType: "seat.invited" });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "REMOTE_JOIN",
      publisher: "audience-2",
      stateChanged: { displayName: "Emma_301" },
    } as unknown as RTMEvents.PresenceEvent);

    await context.client.invite("audience-2", "seat-1");

    expect(context.operations).toContain("rtm:publish:USER:audience-2:seat.invited");
    expect(context.client.getView().error).toBe("Emma_301 不在线");
    await context.client.leaveRoom();
  });

  it("申请中的麦位被其他成员占用时自动判定申请被拒绝", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const initial = createInitialRoomSnapshot("host-1", "Host", 1);
    context.emit("storage", storageEvent(1, metadata(initial)));
    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "SNAPSHOT",
      publisher: "",
      snapshot: [
        { userId: "host-1", states: { displayName: "Host" }, statesCount: 1 },
        { userId: "audience-1", states: { displayName: "Audience" }, statesCount: 1 },
      ],
      interval: null,
    } as unknown as RTMEvents.PresenceEvent);
    await context.client.requestSeat("seat-1");
    expect(context.client.getView().waitingSeatId).toBe("seat-1");

    const occupied = createInitialRoomSnapshot("host-1", "Host", 2);
    occupied.seats["seat-1"] = {
      seatId: "seat-1",
      userId: "audience-2",
      displayName: "Other",
    };
    context.emit("storage", storageEvent(2, metadata(occupied), "UPDATE"));

    expect(context.client.getView().waitingSeatId).toBeUndefined();
    expect(context.client.getView().error).toBe("上麦申请被拒绝");
    await context.client.leaveRoom();
  });

  it("受邀麦位被其他成员占用时自动清除待处理邀请", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const initial = createInitialRoomSnapshot("host-1", "Host", 1);
    context.emit("storage", storageEvent(1, metadata(initial)));
    const now = Date.now();
    context.emit("message", {
      timestamp: now,
      channelName: "audience-1",
      channelType: "USER",
      publisher: "host-1",
      messageType: "STRING",
      message: JSON.stringify({
        schemaVersion: 1,
        messageId: "seat-invited-1",
        type: "seat.invited",
        roomId: "room-1",
        targetUserId: "audience-1",
        sentAt: now,
        expiresAt: now + 15_000,
        payload: { invitationId: "invitation-1", seatId: "seat-1" },
      }),
    } as unknown as RTMEvents.MessageEvent);
    await vi.waitFor(() => expect(context.client.getView().invitation?.seatId).toBe("seat-1"));

    const occupied = createInitialRoomSnapshot("host-1", "Host", 2);
    occupied.seats["seat-1"] = {
      seatId: "seat-1",
      userId: "audience-2",
      displayName: "Other",
    };
    context.emit("storage", storageEvent(2, metadata(occupied), "UPDATE"));

    expect(context.client.getView().invitation).toBeUndefined();
    await context.client.leaveRoom();
  });

  it("成员加入与离开会生成不同类型的公屏系统消息", async () => {
    const context = setup("host");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;

    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "REMOTE_JOIN",
      publisher: "audience-2",
      stateChanged: { displayName: "Alice_037", muted: "false" },
    } as unknown as RTMEvents.PresenceEvent);
    context.emit("presence", {
      timestamp: 2,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "REMOTE_LEAVE",
      publisher: "audience-2",
      stateChanged: {},
    } as unknown as RTMEvents.PresenceEvent);

    expect(context.client.getView().interactions.slice(-2)).toMatchObject([
      { type: "system-member-joined", value: "Alice_037 加入了房间" },
      { type: "system-member-left", value: "Alice_037 离开了房间" },
    ]);
  });

  it("Audience 发现 Host 离开时只标记暂时离开，成员会话继续", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    context.emit("storage", storageEvent(1, metadata(createInitialRoomSnapshot("host-1", "Host", 1))));
    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "SNAPSHOT",
      publisher: "",
      snapshot: [
        { userId: "host-1", states: { displayName: "Host" }, statesCount: 1 },
        { userId: "audience-1", states: { displayName: "Audience" }, statesCount: 1 },
      ],
      interval: null,
    } as unknown as RTMEvents.PresenceEvent);
    context.emit("presence", {
      timestamp: 2,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "REMOTE_LEAVE",
      publisher: "host-1",
    } as RTMEvents.PresenceEvent);

    expect(context.client.getView().hostTemporarilyAway).toBe(true);
    expect(context.client.getView().endedReason).toBeUndefined();
    expect(context.operations).not.toContain("rtm:unsubscribe:room-1");
    expect(context.client.getView().interactions.at(-1)?.value).toBe("Host 暂时离开了房间");
    await expect(context.client.requestSeat("seat-1"))
      .rejects.toThrow("房主暂时离开，无法处理上麦申请");
    expect(context.operations).not.toContain("rtm:publish:USER:host-1:seat.request");
  });

  it("麦位归属变化会生成上麦与下麦系统消息", async () => {
    const context = setup("host");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const initial = createInitialRoomSnapshot("host-1", "Host", 1);
    context.emit("storage", storageEvent(1, metadata(initial)));
    expect(context.client.getView().interactions.some(({ value }) => value === "Host 上了 1 号麦")).toBe(false);
    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "SNAPSHOT",
      publisher: "",
      snapshot: [
        { userId: "host-1", states: { displayName: "Host" }, statesCount: 1 },
        { userId: "audience-2", states: { displayName: "Presence_777" }, statesCount: 1 },
      ],
      interval: null,
    } as unknown as RTMEvents.PresenceEvent);
    const occupied = createInitialRoomSnapshot("host-1", "Host", 2);
    occupied.seats["seat-1"] = { seatId: "seat-1", userId: "audience-2", displayName: "Storage_999" };
    context.emit("storage", storageEvent(2, metadata(occupied)));
    expect(context.client.getTraces().filter(({ name }) => name === "storage").at(-1)?.summary)
      .toBe("hostUserId=Host, announcement=空, seats=1号麦 Host, 2号麦 Presence_777, 3号麦 空, 4号麦 空, 5号麦 空, 6号麦 空, 7号麦 空, 8号麦 空, forcedMutedUserIds=空");
    const left = createInitialRoomSnapshot("host-1", "Host", 3);
    context.emit("storage", storageEvent(3, metadata(left)));
    expect(context.client.getTraces().filter(({ name }) => name === "storage").at(-1)?.summary)
      .toBe("hostUserId=Host, announcement=空, seats=1号麦 Host, 2号麦 空, 3号麦 空, 4号麦 空, 5号麦 空, 6号麦 空, 7号麦 空, 8号麦 空, forcedMutedUserIds=空");

    expect(context.client.getView().interactions.slice(-2)).toMatchObject([
      { type: "system-seat-joined", value: "Presence_777 上了 2 号麦" },
      { type: "system-seat-left", value: "Presence_777 下了 2 号麦" },
    ]);
  });

  it("Audience 首次权威快照不把已在麦位的 Host 作为新上麦消息", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;

    context.emit("storage", storageEvent(1, metadata(createInitialRoomSnapshot("host-1", "Host", 1))));

    expect(context.client.getView().interactions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "system-seat-joined", value: "Host 上了 1 号麦" }),
    ]));
  });

  it("Storage SNAPSHOT 和 UPDATE trace 都展示完整 Metadata", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const initial = createInitialRoomSnapshot("host-1", "Host", 1);
    context.emit("storage", storageEvent(1, metadata(initial)));
    const announcementChanged = { ...initial, majorRevision: 2, announcement: "今晚自由上麦" };
    context.emit("storage", storageEvent(2, metadata(announcementChanged), "UPDATE"));

    const storageTraces = context.client.getTraces().filter(({ name }) => name === "storage");
    const initialSummary = "hostUserId=Host, announcement=空, seats=1号麦 Host, 2号麦 空, 3号麦 空, 4号麦 空, 5号麦 空, 6号麦 空, 7号麦 空, 8号麦 空, forcedMutedUserIds=空";
    expect(storageTraces.at(-2)?.summary).toBe(initialSummary);
    expect(storageTraces.at(-1)?.summary).toBe(initialSummary.replace("announcement=空", "announcement=今晚自由上麦"));
  });

  it("updateSeats API trace 只展示本次发生变化的麦位", async () => {
    const context = setup("host");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const occupied = createInitialRoomSnapshot("host-1", "Host", 1);
    occupied.seats["seat-1"] = { seatId: "seat-1", userId: "audience-2", displayName: "Alice_037" };
    context.emit("storage", storageEvent(1, metadata(occupied)));

    await context.client.forceLeave("audience-2");

    const apiTrace = context.client.getTraces().filter(({ name }) => name === "storage.setChannelMetadata").at(-1);
    expect(apiTrace?.summary).toBe("room-1: seats=2号麦 空");
    expect(apiTrace?.summary).not.toContain("1号麦 Host");
  });

  it("麦上 Audience 可自主闭麦和开麦，Presence State 保留 displayName", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const occupied = createInitialRoomSnapshot("host-1", "Host", 2);
    occupied.seats["seat-1"] = { seatId: "seat-1", userId: "audience-1", displayName: "Audience" };
    context.emit("storage", storageEvent(2, metadata(occupied)));
    await vi.waitFor(() => expect(context.operations).toContain("rtc:publishMicrophone"));

    await context.client.setOwnMuted(true);
    expect(context.client.getView().ownMuted).toBe(true);
    expect(context.client.getView().memberMuted["audience-1"]).toBe(true);
    expect(context.operations).toContain("presence:set:room-1::true");
    expect(context.operations).toContain("rtc:mute:true");

    await context.client.setOwnMuted(false);
    expect(context.client.getView().ownMuted).toBe(false);
    expect(context.client.getView().memberMuted["audience-1"]).toBe(false);
    expect(context.operations).toContain("presence:set:room-1::false");
    expect(context.operations).toContain("rtc:mute:false");
  });

  it("Host 在 1 号麦发布麦克风并可自主闭麦、开麦", async () => {
    const context = setup("host");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    context.emit("storage", storageEvent(1, metadata(createInitialRoomSnapshot("host-1", "Host", 1))));
    await vi.waitFor(() => expect(context.operations).toContain("rtc:publishMicrophone"));

    await context.client.setOwnMuted(true);
    await context.client.setOwnMuted(false);

    expect(context.presenceStates).toEqual(expect.arrayContaining([
      { displayName: "Host", muted: "false" },
      { muted: "true" },
      { muted: "false" },
    ]));
    expect(context.operations).toContain("rtc:mute:true");
    expect(context.operations).toContain("rtc:mute:false");
  });

  it("Host 麦克风发布失败时同步 microphoneError Presence State", async () => {
    const context = setup("host", { failPublish: true, captureHealthy: false });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    context.emit("storage", storageEvent(1, metadata(createInitialRoomSnapshot("host-1", "Host", 1))));

    await vi.waitFor(() => expect(context.client.getView().memberMicrophoneErrors["host-1"]).toBe(true));
    expect(context.presenceStates).toContainEqual({ microphoneError: "true" });
  });

  it("banMember 先通知入房控制器更新共享目录封禁列表", async () => {
    const onBanUser = vi.fn();
    const context = setup("host", { onBanUser });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const initial = createInitialRoomSnapshot("host-1", "Host", 1);
    context.emit("storage", storageEvent(1, metadata(initial)));

    await context.client.banMember("audience-2");

    expect(onBanUser).toHaveBeenCalledWith("audience-2");
    expect(context.operations).toContain("rtm:publish:USER:audience-2:member.ban");
  });

  it("本地 AudioTrack 采集正常时，RTC publish 失败不标记麦克风硬件异常", async () => {
    const context = setup("audience", { failPublish: true });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const snapshot = createInitialRoomSnapshot("host-1", "Host", 4);
    snapshot.seats["seat-1"] = { seatId: "seat-1", userId: "audience-1", displayName: "Audience" };

    context.emit("storage", storageEvent(4, metadata(snapshot)));
    await vi.waitFor(() => expect(context.client.getView().error).toContain("麦位已保留"));

    expect(context.client.getView().snapshot?.seats["seat-1"].userId).toBe("audience-1");
    expect(context.client.getView().memberMicrophoneErrors["audience-1"]).toBeUndefined();
    expect(context.presenceStates).not.toContainEqual({ microphoneError: "true" });
    expect(context.operations.some((operation) => operation.startsWith("storage:set"))).toBe(false);
  });

  it("本地 AudioTrack 无法采集时才同步 microphoneError，并在恢复后清除", async () => {
    const context = setup("audience", { failPublish: true, captureHealthy: false });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const snapshot = createInitialRoomSnapshot("host-1", "Host", 4);
    snapshot.seats["seat-1"] = { seatId: "seat-1", userId: "audience-1", displayName: "Audience" };

    context.emit("storage", storageEvent(4, metadata(snapshot)));
    await vi.waitFor(() => expect(context.client.getView().memberMicrophoneErrors["audience-1"]).toBe(true));
    expect(context.presenceStates).toContainEqual({ microphoneError: "true" });

    context.setPublishFailure(false);
    context.setCaptureHealthy(true);
    context.emit("storage", storageEvent(5, metadata({ ...snapshot, majorRevision: 5, announcement: "触发媒体重试" }), "UPDATE"));
    await vi.waitFor(() => expect(context.operations.filter((operation) => operation === "rtc:publishMicrophone")).toHaveLength(2));
    await vi.waitFor(() => expect(context.client.getView().memberMicrophoneErrors["audience-1"]).toBe(false));
    expect(context.presenceStates).toContainEqual({ microphoneError: "false" });
  });

  it("主动或被迫下麦后删除本端 muted 与 microphoneError Presence State", async () => {
    const context = setup("audience", { failPublish: true, captureHealthy: false });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const occupied = createInitialRoomSnapshot("host-1", "Host", 1);
    occupied.seats["seat-1"] = { seatId: "seat-1", userId: "audience-1", displayName: "Audience" };
    context.emit("storage", storageEvent(1, metadata(occupied)));
    await vi.waitFor(() => expect(context.presenceStates).toContainEqual({ microphoneError: "true" }));

    const left = createInitialRoomSnapshot("host-1", "Host", 2);
    context.emit("storage", storageEvent(2, metadata(left), "UPDATE"));

    await vi.waitFor(() => {
      expect(context.presenceRemovals).toContainEqual(["muted", "microphoneError"]);
      expect(context.client.getView().memberMuted["audience-1"]).toBeUndefined();
      expect(context.client.getView().memberMicrophoneErrors["audience-1"]).toBeUndefined();
    });
  });

  it("Host 收到 seat.left 后按 message、Storage API、Storage UPDATE 的顺序记录数据流", async () => {
    let traceTime = 1_000;
    const context = setup("host", { now: () => ++traceTime });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const occupied = createInitialRoomSnapshot("host-1", "Host", 1);
    occupied.seats["seat-1"] = { seatId: "seat-1", userId: "audience-2", displayName: "Emma_301" };
    context.emit("storage", storageEvent(1, metadata(occupied)));
    context.emit("presence", {
      timestamp: 1,
      channelName: "room-1",
      channelType: "MESSAGE",
      eventType: "SNAPSHOT",
      publisher: "",
      snapshot: [
        { userId: "host-1", states: { displayName: "Host" }, statesCount: 1 },
        { userId: "audience-2", states: { displayName: "Emma_301" }, statesCount: 1 },
      ],
      interval: null,
    } as unknown as RTMEvents.PresenceEvent);
    context.client.clearTraces();

    const now = Date.now();
    context.emit("message", {
      timestamp: now,
      channelName: "host-1",
      channelType: "USER",
      publisher: "audience-2",
      messageType: "STRING",
      message: JSON.stringify({
        schemaVersion: 1,
        messageId: "seat-left-1",
        type: "seat.left",
        roomId: "room-1",
        targetUserId: "host-1",
        sentAt: now,
        expiresAt: now + 15_000,
        payload: { seatId: "seat-1" },
      }),
    } as unknown as RTMEvents.MessageEvent);
    await vi.waitFor(() => expect(context.operations).toContain("storage:set:room-1:seats:none"));
    await vi.waitFor(() => expect(context.client.getView().snapshot?.seats["seat-1"].userId).toBeNull());
    const left = createInitialRoomSnapshot("host-1", "Host", 2);
    context.emit("storage", storageEvent(2, metadata(left), "UPDATE"));

    const flow = [...context.client.getTraces()]
      .sort((leftTrace, rightTrace) => leftTrace.at - rightTrace.at || leftTrace.seq - rightTrace.seq)
      .filter(({ name }) => name === "message" || name === "storage.setChannelMetadata" || name === "storage");
    expect(flow.map(({ name }) => name)).toEqual(["message", "storage.setChannelMetadata", "storage"]);
    expect(flow.map(({ summary }) => summary)).toEqual([
      "seat.left 2号麦 from Emma_301",
      "room-1: seats=2号麦 空",
      "hostUserId=Host, announcement=空, seats=1号麦 Host, 2号麦 空, 3号麦 空, 4号麦 空, 5号麦 空, 6号麦 空, 7号麦 空, 8号麦 空, forcedMutedUserIds=空",
    ]);
  });

  it("退出先 RTC leave，再 RTM unsubscribe，不 logout", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;

    await context.client.leaveRoom();

    expect(context.operations.slice(-2)).toEqual(["rtc:leave", "rtm:unsubscribe:room-1"]);
    expect(context.operations.some((operation) => operation.includes("logout"))).toBe(false);
  });

  it("Host 解散先广播 room.dissolved，再让自己 unsubscribe", async () => {
    const onRoomDissolved = vi.fn();
    const context = setup("host", { onRoomDissolved });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;

    await context.client.dissolveRoom();

    expect(onRoomDissolved).toHaveBeenCalledTimes(1);
    expect(context.operations).toEqual(expect.arrayContaining([
      "rtm:publish:MESSAGE:room-1:room.dissolved",
      "rtc:leave",
      "rtm:unsubscribe:room-1",
    ]));
    expect(context.operations.indexOf("rtm:publish:MESSAGE:room-1:room.dissolved"))
      .toBeLessThan(context.operations.indexOf("rtm:unsubscribe:room-1"));
    expect(context.client.getTraces().some(({ name }) => name === "rtm.unsubscribe")).toBe(true);
  });

  it("Host 清理实际房间 Metadata 失败时每隔 300ms 最多尝试三次", async () => {
    const delay = vi.fn(async () => {});
    const context = setup("host", { cleanupRetryDelay: delay });
    const remove = vi.spyOn(context.port, "removeRoomMetadata").mockRejectedValue(new Error("清理失败"));
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;

    await context.client.dissolveRoom();

    expect(remove).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(context.client.getView().roomCleanupError).toBe("房间已解散，数据清理未完成");
  });

  it('Host 解散后的目录删除失败会保留清理入口，重试时只补做未完成的目录删除', async () => {
    const onRoomCleanup = vi.fn()
      .mockRejectedValueOnce(new Error('目录删除失败'))
      .mockResolvedValueOnce(undefined);
    const context = setup('host', { onRoomCleanup });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;

    await context.client.dissolveRoom();

    expect(onRoomCleanup).toHaveBeenCalledTimes(1);
    expect(context.client.getView().roomCleanupError).toBe('房间已解散，数据清理未完成');
    const actualRoomRemovals = context.operations.filter(operation => operation === 'storage:remove:room-1').length;

    await context.client.retryRoomCleanup();

    expect(onRoomCleanup).toHaveBeenCalledTimes(2);
    expect(context.operations.filter(operation => operation === 'storage:remove:room-1')).toHaveLength(actualRoomRemovals);
    expect(context.client.getView().roomCleanupError).toBeUndefined();
  });

  it.each([
    ["member.kick", "你已被房主踢出"],
    ["member.ban", "你已被该房间封禁"],
    ["room.dissolved", "房间已解散"],
  ])("Audience 收到 %s 后展示 unsubscribe trace", async (type, endedReason) => {
    const onRoomDissolved = vi.fn();
    const context = setup("audience", { onRoomDissolved });
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const now = Date.now();
    context.emit("message", {
      timestamp: now,
      channelName: type === "room.dissolved" ? "room-1" : "audience-1",
      channelType: type === "room.dissolved" ? "MESSAGE" : "USER",
      publisher: "host-1",
      messageType: "STRING",
      message: JSON.stringify({
        schemaVersion: 1,
        messageId: `governance-${type}`,
        type,
        roomId: "room-1",
        ...(type === "room.dissolved" ? {} : { targetUserId: "audience-1" }),
        sentAt: now,
        expiresAt: now + 15_000,
        payload: {},
      }),
    } as unknown as RTMEvents.MessageEvent);

    await vi.waitFor(() => {
      expect(context.client.getView().endedReason).toBe(endedReason);
      expect(context.client.getTraces().some(({ name }) => name === "rtm.unsubscribe")).toBe(true);
    });
    if (type === "room.dissolved") expect(onRoomDissolved).toHaveBeenCalledTimes(1);
  });

  it("Audience 断线后必须等实际房间 Metadata 才解除重连遮罩", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    expect(context.client.getView().roomMetadataFresh).toBe(true);

    context.emit("linkState", {
      currentState: "DISCONNECTED", previousState: "CONNECTED", operation: "AUTO_RECONNECT",
    } as RTMEvents.LinkStateEvent);
    expect(context.client.getView().roomMetadataFresh).toBe(false);

    context.emit("linkState", {
      currentState: "CONNECTED", previousState: "DISCONNECTED", operation: "AUTO_RECONNECT",
    } as RTMEvents.LinkStateEvent);
    expect(context.client.getView().roomMetadataFresh).toBe(false);

    context.emit("storage", storageEvent(6, metadata()));
    await vi.waitFor(() => expect(context.client.getView().roomMetadataFresh).toBe(true));
  });

  it("Audience 重连后收到空实际房间 Metadata 时按解散退出", async () => {
    const context = setup("audience");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    context.emit("linkState", {
      currentState: "DISCONNECTED", previousState: "CONNECTED", operation: "AUTO_RECONNECT",
    } as RTMEvents.LinkStateEvent);
    context.emit("storage", storageEvent(7, {}));
    context.emit("linkState", {
      currentState: "CONNECTED", previousState: "CONNECTING", operation: "AUTO_RECONNECT",
    } as RTMEvents.LinkStateEvent);

    await vi.waitFor(() => {
      expect(context.client.getView().endedReason).toBe("房间已解散");
      expect(context.client.getView().roomMetadataFresh).toBe(true);
    });
    expect(context.operations).toContain("rtm:unsubscribe:room-1");
  });

  it.each(["member.kick", "member.ban"] as const)("%s P2P 失败后在目标 REMOTE_JOIN 时自动重发且不进入数据流", async type => {
    const context = setup("host");
    const entering = context.client.enterRoom();
    context.resolveSubscribe();
    await entering;
    const originalPublish = context.port.publish.bind(context.port);
    const publish = vi.spyOn(context.port, "publish")
      .mockRejectedValueOnce(new Error("USER_OFFLINE"))
      .mockImplementation(originalPublish);

    if (type === "member.ban") await context.client.banMember("audience-2");
    else await context.client.kickMember("audience-2");
    expect(context.client.getTraces().some(({ summary }) => summary?.includes(type))).toBe(false);

    context.emit("presence", {
      timestamp: 1, channelName: "room-1", channelType: "MESSAGE", eventType: "REMOTE_JOIN",
      publisher: "audience-2", stateChanged: { displayName: "听众" }, snapshot: [], interval: null,
    } as unknown as RTMEvents.PresenceEvent);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(context.client.getTraces().some(({ summary }) => summary?.includes(type))).toBe(false);
  });
});


describe("异步操作交叠回归", () => {
  it("announcement 写入不会阻塞 seats 写入", async () => {
    const context = setup("host");
    const subscribing = context.client.subscribeRoom(); context.resolveSubscribe(); await subscribing;
    const initial = createInitialRoomSnapshot("host-1", "Host", 1);
    initial.seats["seat-1"] = { seatId: "seat-1", userId: "a", displayName: "A" };
    context.emit("storage", storageEvent(1, metadata(initial)));
    const announcementPending = deferred();
    const writes: string[][] = [];
    context.port.setRoomMetadata = async (_roomId, data) => {
      writes.push(data.map(item => item.key));
      if (data.some(item => item.key === "announcement")) await announcementPending.promise;
    };

    const announcement = context.client.updateAnnouncement("并行公告");
    const leave = context.client.forceLeave("a");
    try {
      await vi.waitFor(() => expect(writes).toEqual([["announcement"], ["seats"]]));
    } finally {
      announcementPending.resolve();
      await Promise.allSettled([announcement, leave]);
      await context.client.leaveRoom();
    }
  });

  it("并发下麦在执行时读取最新麦位，第二次写入不恢复第一位成员", async () => {
    const context = setup("host");
    const subscribing = context.client.subscribeRoom(); context.resolveSubscribe(); await subscribing;
    const initial = createInitialRoomSnapshot("host-1", "Host", 1);
    initial.seats["seat-1"] = { seatId: "seat-1", userId: "a", displayName: "A" };
    initial.seats["seat-2"] = { seatId: "seat-2", userId: "b", displayName: "B" };
    context.emit("storage", storageEvent(1, metadata(initial)));
    const first = deferred();
    const writes: Parameters<AppRoomRtmPort["setRoomMetadata"]>[1][] = [];
    context.port.setRoomMetadata = async (_roomId, data) => { writes.push(data); if (writes.length === 1) await first.promise; };
    const a = context.client.forceLeave("a"), b = context.client.forceLeave("b");
    try {
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      first.resolve(); await Promise.all([a, b]);
      const seats = JSON.parse(writes[1].find(item => item.key === "seats")!.value);
      expect(seats["seat-1"].userId).toBeNull();
      expect(seats["seat-2"].userId).toBeNull();
      expect(context.client.getView().snapshot.seats).toEqual(seats);
    } finally { first.resolve(); await Promise.allSettled([a, b]); await context.client.leaveRoom(); }
  });

  it("状态写入失败不堵塞队列，延迟成功也不覆盖期间收到的新公告", async () => {
    const context = setup("host");
    const subscribing = context.client.subscribeRoom(); context.resolveSubscribe(); await subscribing;
    const initial = createInitialRoomSnapshot("host-1", "Host", 1);
    initial.seats["seat-1"] = { seatId: "seat-1", userId: "a", displayName: "A" };
    context.emit("storage", storageEvent(1, metadata(initial)));
    const pending = deferred();
    context.port.setRoomMetadata = vi.fn().mockRejectedValueOnce(new Error("写入失败"))
      .mockImplementationOnce(async () => pending.promise).mockResolvedValue(undefined);
    await expect(context.client.forceMute("a", true)).rejects.toThrow("写入失败");
    const removing = context.client.forceLeave("a");
    await vi.waitFor(() => expect(context.port.setRoomMetadata).toHaveBeenCalledTimes(2));
    context.emit("storage", storageEvent(2, metadata({ ...initial, majorRevision: 2, announcement: "新公告" }), "UPDATE"));
    pending.resolve(); await removing;
    await context.client.forceMute("a", true);
    expect(context.client.getView().snapshot.announcement).toBe("新公告");
    expect(context.client.getView().snapshot.seats["seat-1"].userId).toBeNull();
    expect(context.client.getView().snapshot.forcedMutedUserIds).toEqual(["a"]);
    await context.client.leaveRoom();
  });

  it("退出后不执行队列中尚未开始的写入", async () => {
    const context = setup("host");
    const subscribing = context.client.subscribeRoom(); context.resolveSubscribe(); await subscribing;
    const pending = deferred();
    context.port.setRoomMetadata = vi.fn(async () => pending.promise);
    const updating = context.client.updateAnnouncement("第一条");
    await vi.waitFor(() => expect(context.port.setRoomMetadata).toHaveBeenCalledTimes(1));
    const next = context.client.updateAnnouncement("不应写入");
    const rejected = expect(next).rejects.toThrow("房间已结束");
    context.rtc.leave = vi.fn(async () => {});
    const leaving = context.client.leaveRoom();
    await vi.waitFor(() => expect(context.rtc.leave).toHaveBeenCalledTimes(1));
    pending.resolve();
    await Promise.all([updating, rejected, leaving]);
    expect(context.port.setRoomMetadata).toHaveBeenCalledTimes(1);
  });

  it("重复离房都等待同一份 RTC 与 RTM 清理", async () => {
    const context = setup("host");
    const subscribing = context.client.subscribeRoom(); context.resolveSubscribe(); await subscribing;
    const pending = deferred();
    context.rtc.leave = vi.fn(async () => pending.promise);
    const first = context.client.leaveRoom("超时");
    let secondCompleted = false;
    const second = context.client.leaveRoom().then(() => { secondCompleted = true; });
    try {
      await vi.waitFor(() => expect(context.rtc.leave).toHaveBeenCalledTimes(1));
      expect(secondCompleted).toBe(false);
      expect(context.operations).not.toContain("rtm:unsubscribe:room-1");
    } finally { pending.resolve(); await Promise.all([first, second]); }
    expect(context.operations.filter(item => item === "rtm:unsubscribe:room-1")).toHaveLength(1);
  });

  it("发布尚未完成时撤麦会撤销迟到发布，且不重新写入媒体 Presence", async () => {
    const context = setup("audience");
    const publishing = deferred();
    context.rtc.publishMicrophone = vi.fn(async () => publishing.promise);
    context.rtc.unpublishMicrophone = vi.fn(async () => {});
    const entering = context.client.enterRoom(); context.resolveSubscribe(); await entering;
    const occupied = createInitialRoomSnapshot("host-1", "Host", 1);
    occupied.seats["seat-1"] = { seatId: "seat-1", userId: "audience-1", displayName: "A" };
    context.emit("storage", storageEvent(1, metadata(occupied)));
    await vi.waitFor(() => expect(context.rtc.publishMicrophone).toHaveBeenCalledTimes(1));
    context.emit("storage", storageEvent(2, metadata(createInitialRoomSnapshot("host-1", "Host", 2)), "UPDATE"));
    publishing.resolve();
    await vi.waitFor(() => expect(context.rtc.unpublishMicrophone).toHaveBeenCalledTimes(1));
    expect(context.client.getView().memberMuted["audience-1"]).toBeUndefined();
    expect(context.presenceStates.filter(state => state.muted !== undefined)).toEqual([]);
    await context.client.leaveRoom();
  });

  it("发布等待中的多次 Storage 更新不会并发发布，静音按最新状态执行", async () => {
    const context = setup("audience");
    const publishing = deferred();
    context.rtc.publishMicrophone = vi.fn(async () => publishing.promise);
    const entering = context.client.enterRoom(); context.resolveSubscribe(); await entering;
    const occupied = createInitialRoomSnapshot("host-1", "Host", 1);
    occupied.seats["seat-1"] = { seatId: "seat-1", userId: "audience-1", displayName: "A" };
    context.emit("storage", storageEvent(1, metadata(occupied)));
    await vi.waitFor(() => expect(context.rtc.publishMicrophone).toHaveBeenCalledTimes(1));
    context.emit("storage", storageEvent(2, metadata({ ...occupied, forcedMutedUserIds: ["audience-1"] }), "UPDATE"));
    context.emit("storage", storageEvent(3, metadata({ ...occupied, forcedMutedUserIds: ["audience-1"], announcement: "新公告" }), "UPDATE"));
    try { expect(context.rtc.publishMicrophone).toHaveBeenCalledTimes(1); }
    finally { publishing.resolve(); }
    await vi.waitFor(() => expect(context.operations).toContain("rtc:mute:true"));
    expect(context.rtc.publishMicrophone).toHaveBeenCalledTimes(1);
    await context.client.leaveRoom();
  });

  it("退出后迟到发布被回收且不再写入 Presence", async () => {
    const context = setup("audience");
    const publishing = deferred();
    context.rtc.publishMicrophone = vi.fn(async () => publishing.promise);
    context.rtc.unpublishMicrophone = vi.fn(async () => {});
    const entering = context.client.enterRoom(); context.resolveSubscribe(); await entering;
    const occupied = createInitialRoomSnapshot("host-1", "Host", 1);
    occupied.seats["seat-1"] = { seatId: "seat-1", userId: "audience-1", displayName: "A" };
    context.emit("storage", storageEvent(1, metadata(occupied)));
    await vi.waitFor(() => expect(context.rtc.publishMicrophone).toHaveBeenCalledTimes(1));
    await context.client.leaveRoom();
    const count = context.presenceStates.length;
    publishing.resolve();
    await vi.waitFor(() => expect(context.rtc.unpublishMicrophone).toHaveBeenCalledTimes(1));
    expect(context.presenceStates).toHaveLength(count);
  });
});
