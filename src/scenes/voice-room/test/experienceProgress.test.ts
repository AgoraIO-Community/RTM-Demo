import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createTraceStore, type TraceEntry } from '../../../shared/timeline/traceStore';
import { createInitialRoomSnapshot, type SingleRoomView } from '../event-driven-single-room-client';
import { milestonesFromTrace, milestonesFromView, useVoiceRoomExperienceProgress } from '../experienceProgress';

function trace(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return { uid: 'self', role: 'host', seq: 1, at: 1, kind: 'api', name: 'rtm.login', ...overrides };
}

function view(overrides: Partial<SingleRoomView> = {}): SingleRoomView {
  return { userId: 'self', snapshot: createInitialRoomSnapshot('self', '房主'), onlineUsers: ['self'], interactions: [], memberMuted: {}, ...overrides } as SingleRoomView;
}

describe('语聊房体验证据', () => {
  it('调用成功才推进任务，失败码与失败信息都不能被当作成功', () => {
    expect(milestonesFromTrace(trace())).toEqual(['login']);
    expect(milestonesFromTrace(trace({ errorCode: -10003 }))).toEqual([]);
    expect(milestonesFromTrace(trace({ errorMessage: '登录失败' }))).toEqual([]);
    expect(milestonesFromTrace(trace({ kind: 'event' }))).toEqual([]);
    expect(milestonesFromTrace(trace({ name: 'linkState' }))).toEqual([]);
  });

  it('消息内容中提及其他 API 或信令不能完成对应任务', () => {
    const entry = trace({ kind: 'event', name: 'message', eventTag: 'MESSAGE', summary: 'chat.message from 听众: USER seat.request from demo announcement=test muted=true' });
    expect(milestonesFromTrace(entry)).toEqual([]);
    expect(milestonesFromTrace(trace({ name: 'storage.setChannelMetadata', summary: 'initialize' }))).toEqual([]);
    expect(milestonesFromTrace(trace({ name: 'presence.setState', summary: 'muted=false' }))).toEqual([]);
  });

  it.each(['chat.message', 'gift.sent', 'emoji.reaction'])('实际发送 %s 可完成发送小步', (type) => {
    expect(milestonesFromTrace(trace({ name: 'rtm.publish', eventTag: 'MESSAGE', summary: `voice-room-...-1234: to ALL ${type}` }))).toEqual(['interaction-sent']);
  });

  it('上下麦信令与权威麦位分别完成，公告初始化快照不算修改', () => {
    expect(milestonesFromTrace(trace({ name: 'rtm.publish', eventTag: 'USER', summary: 'to 房主 seat.request 2号麦' }))).toEqual(['seat-signal']);
    expect(milestonesFromTrace(trace({ kind: 'event', name: 'message', eventTag: 'USER', summary: 'seat.request 2号麦 from 听众' }))).toEqual(['seat-signal']);
    expect(milestonesFromTrace(trace({ kind: 'event', name: 'message', eventTag: 'USER', summary: 'seat.invited from 房主' }))).toEqual(['seat-signal']);
    expect(milestonesFromTrace(trace({ kind: 'event', name: 'storage', eventTag: 'SNAPSHOT', summary: 'announcement=公告' }))).toEqual([]);
    expect(milestonesFromTrace(trace({ kind: 'event', name: 'storage', eventTag: 'UPDATE', summary: 'announcement=新公告' }))).toEqual(['announcement']);
    expect(milestonesFromTrace(trace({ name: 'presence.setState', summary: 'muted=true' }))).toEqual(['muted']);
    expect(milestonesFromTrace(trace({ name: 'storage.setChannelMetadata', summary: 'forcedMutedUserIds=听众' }))).toEqual(['muted']);
  });

  it('publish 缺少对应 USER/MESSAGE tag 时不能仅凭摘要推进任务', () => {
    expect(milestonesFromTrace(trace({ name: 'rtm.publish', summary: 'to 房主 seat.request 2号麦' }))).toEqual([]);
    expect(milestonesFromTrace(trace({ name: 'rtm.publish', summary: 'voice-room-...-1234: to ALL chat.message' }))).toEqual([]);
  });

  it('Host 需要公告和强制静音都完成，Audience 任一远端状态变化即可完成同步任务', () => {
    const hostStore = createTraceStore({ uid: 'host', role: 'host' });
    const hostView = view({ role: 'host' });
    const hostClient = {
      getTraces: hostStore.getEntries, subscribeTraces: hostStore.subscribe,
      getView: () => hostView, subscribe: () => () => {},
    };
    const host = renderHook(() => useVoiceRoomExperienceProgress({ getTraces: () => [], subscribeTraces: () => () => {} }, hostClient));
    act(() => hostStore.record({ at: 1, kind: 'api', name: 'storage.setChannelMetadata', summary: 'announcement=新公告' }));
    expect(host.result.current.milestones).not.toContain('state-synced');
    act(() => hostStore.record({ at: 2, kind: 'api', name: 'storage.setChannelMetadata', summary: 'forcedMutedUserIds=听众' }));
    expect(host.result.current.milestones).toContain('state-synced');

    const audienceStore = createTraceStore({ uid: 'audience', role: 'audience' });
    const audienceClient = {
      getTraces: audienceStore.getEntries, subscribeTraces: audienceStore.subscribe,
      getView: () => view({ role: 'audience' }), subscribe: () => () => {},
    };
    const audience = renderHook(() => useVoiceRoomExperienceProgress({ getTraces: () => [], subscribeTraces: () => () => {} }, audienceClient));
    act(() => audienceStore.record({ at: 1, kind: 'event', name: 'storage', eventTag: 'UPDATE', summary: 'announcement=新公告' }));
    expect(audience.result.current.milestones).toContain('state-synced');
  });

  it('本端在线、默认房主麦位、本地回显和系统消息不算另一位成员互动', () => {
    expect(milestonesFromView(view({ interactions: [
      { id: '1', type: 'chat', senderId: 'self', displayName: '房主', value: '你好' },
      { id: '2', type: 'system-member-joined', senderId: 'system', displayName: '系统', value: '加入了房间' },
    ], memberMuted: { self: true } }))).toEqual([]);
    const snapshot = createInitialRoomSnapshot('self', '房主');
    snapshot.seats['seat-1'] = { seatId: 'seat-1', userId: 'remote', displayName: '听众' };
    expect(milestonesFromView(view({ snapshot, onlineUsers: ['self', 'remote'], memberMuted: { remote: true }, interactions: [
      { id: '3', type: 'chat', senderId: 'remote', displayName: '房主', value: '同名也能区分身份' },
    ] }))).toEqual(['remote-member', 'seat-occupied', 'interaction-received', 'muted']);
  });

  it('响应订阅事件；清空日志不丢进度，重新挂载才重置', () => {
    const store = createTraceStore({ uid: 'self', role: 'app' });
    const session = { getTraces: store.getEntries, subscribeTraces: store.subscribe };
    const { result, unmount } = renderHook(() => useVoiceRoomExperienceProgress(session));
    act(() => store.record({ at: 1, kind: 'api', name: 'rtm.login' }));
    expect(result.current.milestones).toEqual(['login']);
    act(() => store.clear());
    expect(result.current.milestones).toEqual(['login']);
    act(() => store.record({ at: 2, kind: 'api', name: 'rtm.subscribe' }));
    expect(result.current.milestones).toEqual(['login', 'subscribe']);
    unmount();
    act(() => store.clear());
    const next = renderHook(() => useVoiceRoomExperienceProgress(session));
    expect(next.result.current.milestones).toEqual([]);
  });
});
