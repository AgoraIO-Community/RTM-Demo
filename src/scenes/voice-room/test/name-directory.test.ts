import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { RtcHelper } from '../../../shared/rtc';
import { RoomEntryController } from '../room-entry-controller';
import { createDirectoryTestHub } from './name-directory.testing';
import { resolveRoomName, normalizeRoomName } from '../room-name';
import { createVoiceRoomUrl, parseVoiceRoomUrl, type VoiceRoomUrlPayload } from '../voice-room-url';
import { parseNameDirectoryEntry } from '../name-directory';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())); });

async function page(
  hub: ReturnType<typeof createDirectoryTestHub>,
  userId: string,
  options: { directoryTimeoutMs?: number; retryDirectoryWriteDelay?: () => Promise<void> } = {},
) {
  const session = hub.session(userId);
  await session.login();
  const rtcJoin = vi.fn(async () => {});
  const noop = async () => {};
  const createRtc = (): RtcHelper => ({
    registerEvents() {}, join: rtcJoin, leave: noop, publishMicrophone: noop, unpublishMicrophone: noop,
    setMicrophoneMuted: noop, isMicrophoneCaptureHealthy: () => true, publishCamera: noop,
    unpublishCamera: noop, setCameraMuted: noop, getLocalVideoTrack: () => undefined,
  });
  const replaced: VoiceRoomUrlPayload[] = [];
  const controller = new RoomEntryController({
    appId: 'test-app', session, createRtc, directoryTimeoutMs: 300, ...options,
    replaceUrl: payload => replaced.push(payload),
  });
  cleanups.push(async () => { await controller.leaveRoom(); await session.logout(); });
  return { controller, session, rtcJoin, replaced };
}

function audiencePayload(controller: RoomEntryController): VoiceRoomUrlPayload {
  return { ...controller.getView().payload!, role: 'audience', pageUid: null, nickname: null };
}

describe('共享名称房间', () => {
  it('目录 DTO 只接受 active/inactive 生命周期状态', () => {
    const entry = parseNameDirectoryEntry({
      schemaVersion: 1, canonicalName: '周五语聊', roomName: '周五语聊', roomId: 'voice-room-random',
      hostUserId: 'host', status: 'active', createdAt: 1, banUserIds: [],
    });
    expect(() => parseNameDirectoryEntry({ ...entry, status: 'pending' })).toThrow('格式不兼容');
  });

  it('两角色在首次 await 前固定规范昵称，目录不存 nickname', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'nickname-host'), audience = await page(hub, 'nickname-audience');
    const input = { roomName: '昵称固定测试', nickname: '  Ａlice e\u0301 👩‍💻  ' };
    const creating = host.controller.createHostRoom(input);
    input.nickname = '迟到修改';
    await creating;
    expect(host.controller.getView().client!.getView()).toMatchObject({ userId: 'nickname-host', displayName: 'Ａlice é 👩‍💻' });
    await audience.controller.joinAudienceByName('昵称固定测试', '  观众 😀  ');
    expect(audience.controller.getView().client!.getView()).toMatchObject({ userId: 'nickname-audience', displayName: '观众 😀' });
    const room = host.controller.getView().entry!;
    expect(JSON.parse(hub.records.get(room.nameKey)!.metadata.entry.value)).not.toHaveProperty('nickname');
  });

  it('Audience 先读取目录，再写 Presence，最后只订阅实际房间', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'host'), audience = await page(hub, 'audience');
    await host.controller.createHostRoom({ roomName: 'API 准入房' });
    const start = hub.calls.length;
    await audience.controller.joinAudienceByName('API 准入房');
    const calls = hub.calls.slice(start).filter(call => call.userId === 'audience');
    expect(calls[0]).toMatchObject({ name: 'get', channel: expect.stringMatching(/^vrn-v1-/u) });
    expect(calls.slice(1).map(call => call.name)).toEqual(['presence', 'subscribe']);
    expect(calls[1].channel).toBe(host.controller.getView().entry!.roomId);
    expect(calls[2].channel).toBe(host.controller.getView().entry!.roomId);
  });

  it('Host 用读取到的目录 revision 先登记，再写 Presence 并订阅实际房间', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'host');
    await host.controller.createHostRoom({ roomName: '单次登记房' });
    const nameKey = host.controller.getView().entry!.nameKey;
    const calls = hub.calls.filter(call => call.userId === 'host');
    const directoryWrites = calls.filter(call => call.name === 'write' && call.channel === nameKey);
    const directoryWriteIndex = calls.findIndex(call => call.name === 'write' && call.channel === nameKey);
    const presenceIndex = calls.findIndex(call => call.name === 'presence');
    const subscribeIndex = calls.findIndex(call => call.name === 'subscribe');
    const record = JSON.parse(hub.records.get(nameKey)!.metadata.entry.value);
    expect(directoryWrites).toHaveLength(1);
    expect(directoryWrites[0].revision).toBe(0);
    expect(directoryWriteIndex).toBeLessThan(presenceIndex);
    expect(presenceIndex).toBeLessThan(subscribeIndex);
    expect(calls.filter(call => call.name === 'subscribe')).toHaveLength(1);
    expect(record).toMatchObject({ status: 'active' });
  });

  it('目录写入应答丢失后读取到自己的 roomId，确认创建成功且不重放写入', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'host');
    hub.failNextWrite('after');
    await host.controller.createHostRoom({ roomName: '未知结果房' });
    const nameKey = host.controller.getView().entry!.nameKey;
    expect(hub.calls.filter(call => call.userId === 'host' && call.name === 'write' && call.channel === nameKey)).toHaveLength(1);
    expect(host.controller.getView().phase).toBe('room');
  });

  it('目录竞争写连续失败时每隔 300ms 重试，三次后提示房间被占用', async () => {
    const delay = vi.fn(async () => {});
    const hub = createDirectoryTestHub(), host = await page(hub, 'host', { retryDirectoryWriteDelay: delay });
    hub.failNextWrite('before');
    hub.failNextWrite('before');
    hub.failNextWrite('before');
    await expect(host.controller.createHostRoom({ roomName: '竞争房' }))
      .rejects.toThrow('房间被占用，请更换房间名再次创建');
    const nameKey = (await resolveRoomName('竞争房')).nameKey;
    expect(hub.calls.filter(call => call.userId === 'host' && call.name === 'write' && call.channel === nameKey)).toHaveLength(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it('实际房间订阅失败后的迟到回滚不能删除同名新房间记录', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'host');
    const name = await resolveRoomName('迟到回滚房');
    const subscribe = vi.spyOn(host.session.getRoomPort(), 'subscribe').mockImplementation(async channel => {
      const current = hub.records.get(name.nameKey)!;
      const replacement = {
        schemaVersion: 1, canonicalName: name.canonicalName, roomName: name.roomName,
        roomId: 'voice-room-replacement', hostUserId: 'replacement-host', status: 'active',
        createdAt: Date.now(), banUserIds: [],
      } as const;
      hub.records.set(name.nameKey, {
        majorRevision: current.majorRevision + 1,
        metadata: { entry: {
          value: JSON.stringify(replacement), revision: current.majorRevision + 1,
          authorUid: 'replacement-host', updated: Date.now(),
        } },
      });
      throw new Error(`订阅 ${channel} 失败`);
    });

    await expect(host.controller.createHostRoom({ roomName: name.roomName })).rejects.toThrow('订阅');

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(JSON.parse(hub.records.get(name.nameKey)!.metadata.entry.value)).toMatchObject({
      roomId: 'voice-room-replacement', hostUserId: 'replacement-host',
    });
  });

  it('规范化后的同名输入加入同一个随机实际房间，浏览器不共享状态', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'host'), audience = await page(hub, 'audience');
    await host.controller.createHostRoom({ roomName: '  ＲＴＭ   茶话会  ' });
    await audience.controller.joinAudienceByName('rtm 茶话会');
    expect(audience.controller.getView().entry?.roomId).toBe(host.controller.getView().entry?.roomId);
    expect(hub.clients.get('host')?.channels.size).toBe(1);
    expect(hub.clients.get('audience')?.channels.size).toBe(1);
  });

  it('查无房间由 getChannelMetadata 的空结果判定，不订阅任何频道', async () => {
    const hub = createDirectoryTestHub(), audience = await page(hub, 'audience');
    await expect(audience.controller.joinAudienceByName('不存在')).rejects.toThrow('未找到');
    expect(hub.calls.filter(call => call.userId === 'audience' && call.name === 'subscribe')).toEqual([]);
  });

  it('实际房间 subscribe 成功即开放并启动 RTC，不等待 Storage 快照', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'host');
    hub.pauseRoomSnapshots(true);
    await host.controller.createHostRoom({ roomName: '准备中' });
    expect(host.controller.getView().phase).toBe('room');
    expect(hub.calls.findIndex(call => call.name === 'presence')).toBeLessThan(hub.calls.findIndex(call => call.name === 'subscribe'));
    await waitFor(() => expect(host.rtcJoin).toHaveBeenCalledTimes(1));
  });

  it('房主暂时离开保持 active，Host URL 可恢复，听众仍可按名加入', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'host'), audience = await page(hub, 'audience');
    await host.controller.createHostRoom({ roomName: '暂离房' });
    const payload = host.controller.getView().payload!;
    await host.controller.leaveRoom();
    await audience.controller.joinAudienceByName('暂离房');
    await host.controller.restoreHostFromUrlPayload(payload);
    expect(host.controller.getView().phase).toBe('room');
    expect(audience.controller.getView().phase).toBe('room');
  });

  it('解散通知听众、清空实际房间并删除目录记录，同名可重建为新 roomId', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'host'), audience = await page(hub, 'audience');
    await host.controller.createHostRoom({ roomName: '清理验证' });
    await audience.controller.joinAudienceByName('清理验证');
    const oldRoomId = host.controller.getView().entry!.roomId;
    await host.controller.getView().client!.dissolveRoom();
    await waitFor(() => expect(audience.controller.getView().client?.getView().endedReason).toBe('房间已解散'));
    const nameKey = host.controller.getView().entry!.nameKey;
    expect(hub.records.get(nameKey)?.metadata).toEqual({});
    expect(hub.records.get(oldRoomId)!.metadata).toEqual({});
    await host.controller.leaveRoom();
    await host.controller.createHostRoom({ roomName: '清理验证' });
    expect(host.controller.getView().entry!.roomId).not.toBe(oldRoomId);
  });

  it('同名重建后旧 URL 不跳转到新房间', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'host'), audience = await page(hub, 'audience');
    await host.controller.createHostRoom({ roomName: '重建房' });
    const oldUrl = audiencePayload(host.controller);
    await host.controller.getView().client!.dissolveRoom();
    await host.controller.leaveRoom();
    await host.controller.createHostRoom({ roomName: '重建房' });
    await expect(audience.controller.joinAudienceFromUrlPayload(oldUrl)).rejects.toThrow('原房间已结束');
  });

  it('封禁先写共享目录；P2P 失败不回滚封禁，重新准入仍会被拒绝', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'host'), audience = await page(hub, 'audience');
    await host.controller.createHostRoom({ roomName: '封禁房' });
    await audience.controller.joinAudienceByName('封禁房');
    hub.failMessages(true);
    await expect(host.controller.getView().client!.banMember('audience')).resolves.toBeUndefined();
    expect(host.controller.getView().client!.getView().error).toBe('封禁已生效，P2P 通知失败，请稍后再试');
    await audience.controller.leaveRoom();
    await expect(audience.controller.joinAudienceByName('封禁房')).rejects.toThrow('你已被该房间封禁');
  });

  it('没有 Host 身份的页面不能通过改 role 接管已有名称', async () => {
    const hub = createDirectoryTestHub(), host = await page(hub, 'host'), other = await page(hub, 'other');
    await host.controller.createHostRoom({ roomName: '身份房' });
    const forged = { ...audiencePayload(host.controller), role: 'host' as const, pageUid: 'other' };
    await expect(other.controller.restoreHostFromUrlPayload(forged)).rejects.toThrow('房主身份');
  });
});

describe('名称与协议', () => {
  it('全半角、大小写与空格归一，中文可用，目录频道固定 50 个 ASCII 字符', async () => {
    const a = await resolveRoomName(' ＡＢＣ　 茶话会 '), b = await resolveRoomName('abc 茶话会');
    expect(a.nameKey).toBe(b.nameKey);
    expect(a.nameKey).toHaveLength(50);
    expect(a.roomName).toBe('ABC 茶话会');
    expect(() => normalizeRoomName('😀'.repeat(32))).not.toThrow();
    for (const input of ['', '   ', '字'.repeat(33), 'ab\u200Bcd', 'a\nb']) expect(() => normalizeRoomName(input)).toThrow();
  });

  it('V2 链接只有 data 参数，四种输入形式均可解析', async () => {
    const payload: VoiceRoomUrlPayload = {
      version: 2, nameKey: (await resolveRoomName('链接房')).nameKey, roomId: 'random-room',
      role: 'audience', pageUid: null, nickname: null,
    };
    const url = createVoiceRoomUrl('https://example.com', payload), encoded = new URL(url).searchParams.get('data')!;
    for (const input of [url, `?data=${encoded}`, `data=${encoded}`, encoded]) expect(parseVoiceRoomUrl(input)).toEqual(payload);
  });

  it('未知协议与名称不匹配不会订阅实际房间', async () => {
    const hub = createDirectoryTestHub(), audience = await page(hub, 'audience');
    const nameKey = (await resolveRoomName('错误登记')).nameKey;
    hub.records.set(nameKey, { majorRevision: 1, metadata: { entry: {
      value: JSON.stringify({ schemaVersion: 99 }), revision: 1, authorUid: 'host', updated: 1,
    } } });
    await expect(audience.controller.joinAudienceByName('错误登记')).rejects.toThrow('格式不兼容');
    expect(hub.calls.filter(call => call.userId === 'audience' && call.name === 'subscribe')).toEqual([]);
  });

});
