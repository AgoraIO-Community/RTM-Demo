import { describe, expect, it } from 'vitest';
import {
  createVoiceRoomInviteCode,
  createVoiceRoomUrl,
  decodeVoiceRoomUrlPayload,
  encodeVoiceRoomUrlPayload,
  parseVoiceRoomUrl,
  withVoiceRoomPageIdentity,
  type VoiceRoomUrlPayload,
} from '../voice-room-url';

const nameKey = `vrn-v1-${'a'.repeat(43)}`;

function payload(overrides: Partial<VoiceRoomUrlPayload> = {}): VoiceRoomUrlPayload {
  return {
    version: 2,
    nameKey,
    roomId: 'voice-room-1',
    role: 'audience',
    pageUid: null,
    nickname: null,
    ...overrides,
  };
}

function encodeRaw(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

describe('语聊房 URL payload', () => {
  it('拒绝不受支持的非 V2 payload', () => {
    expect(decodeVoiceRoomUrlPayload(encodeRaw({
      directorySnapshot: { roomId: 'voice-room-old' },
      role: 'audience', pageUid: null, nickname: null,
    }))).toBeUndefined();
  });

  it('V2 两角色保留中文、空格和 Emoji 昵称', () => {
    for (const role of ['host', 'audience'] as const) {
      for (const nickname of ['小明', 'Alice Smith', '👩‍💻小雨', '😀'.repeat(20), 'Alice_037', 'Host']) {
        const original = payload({ role, pageUid: role === 'host' ? 'host-identity' : null, nickname });
        expect(parseVoiceRoomUrl(createVoiceRoomUrl('https://example.com', original))).toEqual(original);
        expect(withVoiceRoomPageIdentity(original, 'preserved-uid', nickname)).toMatchObject({ pageUid: 'preserved-uid', nickname });
      }
    }
  });

  it('非法非空昵称使整个 payload 失效', () => {
    for (const nickname of ['', '   ', ' 未规范化 ', 'e\u0301', '😀'.repeat(21), '换\n行', 'tab\t字符', '\u200b']) {
      const invalid = { ...payload({ pageUid: 'original-uid' }), nickname };
      expect(decodeVoiceRoomUrlPayload(encodeRaw(invalid))).toBeUndefined();
      expect(() => encodeVoiceRoomUrlPayload(invalid as VoiceRoomUrlPayload)).toThrow('非法的语聊房 URL payload');
      expect(() => withVoiceRoomPageIdentity(payload(), 'new-uid', nickname)).toThrow('昵称格式不正确');
    }
  });

  it('UTF-8 Base64URL 往返保留内容且 URL 只有 data 参数', () => {
    const original = payload({ nickname: '周五 😀' });
    const encoded = encodeVoiceRoomUrlPayload(original);
    const url = createVoiceRoomUrl('https://example.com/', original);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeVoiceRoomUrlPayload(encoded)).toEqual(original);
    expect([...new URL(url).searchParams.keys()]).toEqual(['data']);
    expect(parseVoiceRoomUrl(url)).toEqual(original);
  });

  it('兼容完整 URL、查询串、data 字段和纯 payload', () => {
    const encoded = encodeVoiceRoomUrlPayload(payload());
    expect(createVoiceRoomInviteCode(payload())).toBe(`data=${encoded}`);
    for (const input of [
      createVoiceRoomUrl('http://10.103.1.149:8080', payload()),
      `?data=${encoded}`,
      `data=${encoded}`,
      encoded,
    ]) expect(parseVoiceRoomUrl(input)).toEqual(payload());
  });

  it('拒绝额外字段、额外查询参数和 Host 空身份', () => {
    expect(decodeVoiceRoomUrlPayload(encodeRaw({ ...payload(), extra: true }))).toBeUndefined();
    expect(parseVoiceRoomUrl(`?data=${encodeVoiceRoomUrlPayload(payload())}&room=voice-room-1`)).toBeUndefined();
    expect(decodeVoiceRoomUrlPayload(encodeRaw(payload({ role: 'host', pageUid: null })))).toBeUndefined();
  });
});
