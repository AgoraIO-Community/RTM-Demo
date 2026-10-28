import { describe, expect, it } from 'vitest';

import { getOrCreateCallIdentity, isValidCallUid, normalizeCallNickname } from '../../app/identity';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('呼叫身份', () => {
  it('同一标签页恢复已有呼叫 ID，不重复生成', () => {
    const target = storage();
    const first = getOrCreateCallIdentity(target, () => 'A1B2C3');
    const second = getOrCreateCallIdentity(target, () => 'SHOULD-NOT-BE-USED');
    expect(first).toEqual({ uid: 'call-A1B2C3' });
    expect(second).toEqual(first);
  });

  it('忽略损坏的缓存并生成格式稳定的呼叫 ID', () => {
    const target = storage();
    target.setItem('rtm-lab.one-to-one-call.uid', 'not valid');
    expect(getOrCreateCallIdentity(target, () => 'XYZ789')).toEqual({ uid: 'call-XYZ789' });
  });

  it('昵称 NFC 规范化、清理首尾空白并限制 20 个 Unicode 码点', () => {
    expect(normalizeCallNickname('  e\u0301  ')).toEqual({ value: 'é' });
    expect(normalizeCallNickname('😀'.repeat(21))).toEqual({ error: '昵称最多 20 个字符' });
    expect(normalizeCallNickname('Alice\nBob')).toEqual({ error: '昵称不能包含换行或控制字符' });
    expect(normalizeCallNickname('   ')).toEqual({ value: '' });
  });

  it('只接受完整的 call- 呼叫 ID 格式', () => {
    expect(isValidCallUid('call-remote02')).toBe(true);
    expect(isValidCallUid('remote02')).toBe(false);
    expect(isValidCallUid('call-a')).toBe(false);
    expect(isValidCallUid(`call-${'a'.repeat(65)}`)).toBe(false);
  });
});
