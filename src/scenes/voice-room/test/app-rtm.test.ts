import type { RTMEvents } from "agora-rtm";
import { describe, expect, it, vi } from "vitest";

import {
  AppRtmSession,
  type AppRtmClient,
} from "../app-rtm";

type EventName = "linkState" | "message" | "presence" | "storage" | "token";

function createFakeClient(options: { failLogin?: boolean } = {}) {
  const operations: string[] = [];
  const listeners = new Map<EventName, Set<(event: never) => void>>();
  const client: AppRtmClient = {
    addEventListener(name, listener) {
      operations.push(`on:${name}`);
      const set = listeners.get(name as EventName) ?? new Set();
      set.add(listener as (event: never) => void);
      listeners.set(name as EventName, set);
    },
    removeEventListener(name, listener) {
      operations.push(`off:${name}`);
      listeners.get(name as EventName)?.delete(listener as (event: never) => void);
    },
    async login() {
      operations.push("login");
      if (options.failLogin) throw new Error("登录失败");
    },
    async logout() { operations.push("logout"); },
    async subscribe(roomId) { operations.push(`subscribe:${roomId}`); },
    async unsubscribe(roomId) { operations.push(`unsubscribe:${roomId}`); },
    async publish(channelName, _message, publishOptions) {
      operations.push(`publish:${publishOptions?.channelType}:${channelName}`);
    },
    presence: {
      async setState(roomId) { operations.push(`presence:set:${roomId}`); },
      async removeState(roomId) { operations.push(`presence:remove:${roomId}`); },
    },
    storage: {
      async getChannelMetadata(roomId) {
        operations.push(`storage:get:${roomId}`);
        return { majorRevision: 0, totalCount: 0, metadata: {} };
      },
      async removeChannelMetadata(roomId) { operations.push(`storage:remove:${roomId}`); },
      async setChannelMetadata(roomId, _type, _data, metadataOptions) {
        operations.push(`storage:set:${roomId}:${metadataOptions?.majorRevision ?? "none"}`);
      },
    },
  };

  return {
    client,
    operations,
    emit<Event extends EventName>(
      name: Event,
      event: Parameters<RTMEvents.RTMClientEventMap[Event]>[0],
    ) {
      for (const listener of listeners.get(name) ?? []) listener(event as never);
    },
  };
}

describe("AppRtmSession", () => {
  it("登录前通过共享工具获取当前 UID 的 Token", async () => {
    const fake = createFakeClient();
    fake.client.login = vi.fn(async () => undefined);
    const getToken = vi.fn(async () => 'rtm-token');
    const session = new AppRtmSession('app', 'user-1', { createClient: () => fake.client, getToken });
    await session.login();
    expect(getToken).toHaveBeenCalledWith({ service: 'rtm', appId: 'app', userId: 'user-1' });
    expect(fake.client.login).toHaveBeenCalledWith({ token: 'rtm-token' });
  });

  it("使用单调高精度时钟计算 login durationMs", async () => {
    const fake = createFakeClient();
    let monotonicNow = 100;
    const session = new AppRtmSession("app", "user-1", {
      createClient: () => fake.client,
      monotonicNow: () => monotonicNow,
    });

    const loggingIn = session.login();
    await Promise.resolve();
    monotonicNow = 114.5;
    await loggingIn;

    expect(session.getTraces()).toContainEqual(
      expect.objectContaining({ name: "rtm.login", durationMs: 14.5 }),
    );
  });

  it("真实 login 调用完成后保留页面级 rtm.login trace", async () => {
    const fake = createFakeClient();
    const session = new AppRtmSession("app", "user-1", { createClient: () => fake.client });

    await session.login();

    expect(session.getTraces()).toEqual([
      expect.objectContaining({ kind: "api", role: "app", name: "rtm.login", uid: "user-1" }),
    ]);
  });

  it("页面级 port 把 Presence State 删除映射到 SDK removeState", async () => {
    const fake = createFakeClient();
    const session = new AppRtmSession("app", "user-1", { createClient: () => fake.client });
    const port = await session.login();

    await port.removePresenceState("room-1", ["muted", "microphoneError"]);

    expect(fake.operations).toContain("presence:remove:room-1");
  });

  it("在 login 前注册全部事件，并发登录只创建一个 client", async () => {
    const fake = createFakeClient();
    const createClient = vi.fn(() => fake.client);
    const session = new AppRtmSession("app", "user-1", { createClient });

    const [left, right] = await Promise.all([session.login(), session.login()]);

    expect(left).toBe(right);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(fake.operations.slice(0, 6)).toEqual([
      "on:linkState",
      "on:message",
      "on:presence",
      "on:storage",
      "on:token",
      "login",
    ]);
  });

  it("注销完成后在原 Client 上重登录，不能重复构造同 UID 实例", async () => {
    let releaseLogout!: () => void;
    const logoutGate = new Promise<void>(resolve => { releaseLogout = resolve; });
    const first = createFakeClient();
    const second = createFakeClient();
    const createClient = vi.fn()
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    first.client.logout = async () => {
      first.operations.push("logout:start");
      await logoutGate;
      first.operations.push("logout:end");
    };
    const session = new AppRtmSession("app", "user-1", { createClient });

    await session.login();
    const loggingOut = session.logout();
    const loggingIn = session.login();
    await Promise.resolve();
    expect(createClient).toHaveBeenCalledTimes(1);

    releaseLogout();
    await Promise.all([loggingOut, loggingIn]);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(first.operations).toContain("logout:end");
    expect(first.operations.filter(operation => operation === "login")).toHaveLength(2);
    expect(second.operations).toEqual([]);
  });

  it("只把事件分发给当前角色 handler，旧 cleanup 不解绑新角色", async () => {
    const fake = createFakeClient();
    const session = new AppRtmSession("app", "user-1", {
      createClient: () => fake.client,
    });
    const first = vi.fn();
    const second = vi.fn();
    await session.login();

    const unbindFirst = session.bindRtmEvents({ storage: first });
    fake.emit("storage", { timestamp: 1, channelName: "room", channelType: "MESSAGE", storageType: "CHANNEL", eventType: "SNAPSHOT", data: { majorRevision: 1, totalCount: 0, metadata: {} }, publisher: "" });
    session.bindRtmEvents({ storage: second });
    unbindFirst();
    fake.emit("storage", { timestamp: 2, channelName: "room", channelType: "MESSAGE", storageType: "CHANNEL", eventType: "SNAPSHOT", data: { majorRevision: 2, totalCount: 0, metadata: {} }, publisher: "" });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("角色晚于登录绑定时只读当前状态，不回放历史 linkState 事件", async () => {
    const fake = createFakeClient();
    const session = new AppRtmSession("app", "user-1", {
      createClient: () => fake.client,
    });
    await session.login();
    const event = {
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
    } as unknown as RTMEvents.LinkStateEvent;
    fake.emit("linkState", event);
    const handler = vi.fn();

    session.bindRtmEvents({ linkState: handler });

    expect(session.getCurrentLinkState()).toBe("connected");
    expect(handler).not.toHaveBeenCalled();
    expect(session.getTraces()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "event",
        role: "app",
        name: "linkState",
        eventTag: "CONNECTED",
        summary: "CONNECTING→CONNECTED · LOGIN_SUCCESS",
      }),
    ]));
  });

  it("登录失败后清理 listener 并允许重试，保留最初错误", async () => {
    const failed = createFakeClient();
    failed.client.login = vi.fn()
      .mockRejectedValueOnce(new Error("登录失败"))
      .mockResolvedValue(undefined);
    const createClient = vi.fn(() => {
      if (createClient.mock.calls.length > 1) {
        throw Object.assign(new Error("duplicate RTM instance"), { errorCode: -10027 });
      }
      return failed.client;
    });
    const session = new AppRtmSession("app", "user-1", { createClient });

    await expect(session.login()).rejects.toThrow("登录失败");
    const port = await session.login();
    expect(port).toBe(session.getRoomPort());

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(failed.client.login).toHaveBeenCalledTimes(2);
    expect(failed.operations).toContain("off:storage");
    expect(failed.operations).toContain("logout");
  });

  it("离房只取消订阅，页面注销才移除 listener 并 logout", async () => {
    const fake = createFakeClient();
    const session = new AppRtmSession("app", "user-1", {
      createClient: () => fake.client,
    });
    const port = await session.login();

    await port.unsubscribe("room-1");
    expect(fake.operations).not.toContain("logout");

    await session.logout();
    expect(fake.operations.slice(-6)).toEqual([
      "off:linkState",
      "off:message",
      "off:presence",
      "off:storage",
      "off:token",
      "logout",
    ]);
  });

  it("构造异常由 login Promise 拒绝并记录错误，不同步抛出导致白屏", async () => {
    const error = Object.assign(new Error("duplicate RTM instance"), { errorCode: -10027 });
    const session = new AppRtmSession("app", "user-1", {
      createClient: () => { throw error; },
    });
    let pending: Promise<unknown> | undefined;
    expect(() => { pending = session.login(); }).not.toThrow();
    await expect(pending).rejects.toBe(error);
    expect(session.getTraces().at(-1)).toMatchObject({ name: "rtm.login", errorCode: -10027 });
  });
});
