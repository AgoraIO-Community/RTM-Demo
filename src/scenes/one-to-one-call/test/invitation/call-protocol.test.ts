import { describe, expect, it } from 'vitest';

import { buildCallSignal, createCallId, parseCallSignal } from '../../invitation/call-protocol';

const ID = '0123456789ABCDEF0123456789ABCDEF';
const event = (customType: string, payload: unknown, publisher = 'alice') => ({
  channelType: 'USER', customType, publisher, message: JSON.stringify(payload),
});

describe('纯信令 USER 协议', () => {
  it('只携带邀请身份与透传数据，不绑定频道、RTC 或 Demo UID', () => {
    expect(buildCallSignal({ customType: 'CALL_KIT_INVITE', callId: ID, extra: '业务数据' }))
      .toEqual({ callId: ID, extra: '业务数据' });
    expect(parseCallSignal(event('CALL_KIT_INVITE', { callId: ID, extra: '业务数据' }), 'bob'))
      .toMatchObject({ accepted: true, signal: { callId: ID, senderId: 'alice', extra: '业务数据' } });
  });

  it('省略 extra 时以空串透传，重试可复用同一载荷', () => {
    expect(buildCallSignal({ customType: 'CALL_KIT_INVITE', callId: ID }))
      .toEqual({ callId: ID, extra: '' });
    expect(parseCallSignal(event('CALL_KIT_INVITE', { callId: ID }), 'bob'))
      .toMatchObject({ accepted: true, signal: { extra: '' } });
  });

  it.each(['accepted', 'ack'] as const)('接听 %s 使用同一 customType，校验合法子类型', (type) => {
    expect(parseCallSignal(event('CALL_KIT_ACCEPT', { callId: ID, extra: '', type }), 'bob'))
      .toMatchObject({ accepted: true, signal: { type } });
  });

  it.each([
    ['CALL_KIT_ACCEPT', { callId: ID, type: 'request' }],
    ['CALL_KIT_ACCEPT', { callId: ID }],
    ['CALL_KIT_INVITE', { callId: 'invalid' }],
    ['CALL_KIT_INVITE', { callId: ID, extra: {} }],
    ['CALL_KIT_BUSY', { callId: ID }],
    ['CALL_KIT_END', { callId: ID }],
  ])('非法 %s 载荷不进入邀请状态机', (customType, payload) => {
    expect(parseCallSignal(event(customType, payload), 'bob').accepted).toBe(false);
  });

  it('只接受 USER 和合法文本 JSON，拒绝本端回环与空 publisher', () => {
    const valid = event('CALL_KIT_INVITE', { callId: ID });
    for (const invalid of [
      { ...valid, channelType: 'MESSAGE' },
      { ...valid, message: '{' },
      { ...valid, message: new Uint8Array() },
      { ...valid, message: 'null' },
      { ...valid, publisher: '' },
      { ...valid, publisher: 'bob' },
    ]) expect(parseCallSignal(invalid, 'bob').accepted).toBe(false);
  });

  it('每次随机字节生成独立的 32 位大写十六进制 callId', () => {
    expect(createCallId(() => new Uint8Array(16).fill(0xab))).toBe('ABABABABABABABABABABABABABABABAB');
    expect(createCallId(() => new Uint8Array(16).fill(0xcd))).not.toBe('ABABABABABABABABABABABABABABABAB');
  });
});
