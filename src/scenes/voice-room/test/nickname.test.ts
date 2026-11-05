import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudienceDisplayName } from '../audience-display-name';
import {
  getNicknameInitial,
  isValidNickname,
  normalizeNicknameInput,
  resolveEntryNickname,
} from '../nickname';

afterEach(() => vi.restoreAllMocks());

describe('入房昵称', () => {
  it('规范化首尾空格和组合字符，保留内部空格、大小写及全半角', () => {
    expect(normalizeNicknameInput('  小明  Alice_１２.e\u0301  ')).toBe('小明  Alice_１２.é');
    expect(normalizeNicknameInput('Ａlice')).toBe('Ａlice');
  });

  it('只有缺省或空白输入使用原角色默认值', () => {
    for (const input of [undefined, null, '', '   ', '\u3000']) {
      expect(resolveEntryNickname(input, 'host', 'host-self')).toBe('Host');
      expect(resolveEntryNickname(input, 'audience', 'audience-self')).toBe(createAudienceDisplayName('audience-self'));
    }
    expect(resolveEntryNickname(' 小明 ', 'host', 'host-self')).toBe('小明');
    expect(resolveEntryNickname(' 小明 ', 'audience', 'audience-self')).toBe('小明');
  });

  it('长度按 NFC 后 Unicode 码点计算，基本 Emoji 不按 UTF-16 算两位', () => {
    expect(normalizeNicknameInput('明'.repeat(20))).toBe('明'.repeat(20));
    expect(normalizeNicknameInput('😀'.repeat(20))).toBe('😀'.repeat(20));
    expect(() => normalizeNicknameInput('明'.repeat(21))).toThrow('昵称最多 20 个字符');
    expect(() => normalizeNicknameInput('😀'.repeat(21))).toThrow('昵称最多 20 个字符');
    expect(normalizeNicknameInput('e\u0301'.repeat(20))).toBe('é'.repeat(20));
    expect(normalizeNicknameInput('👩‍💻'.repeat(6))).toBe('👩‍💻'.repeat(6));
    expect(() => normalizeNicknameInput('👩‍💻'.repeat(7))).toThrow('昵称最多 20 个字符');
  });

  it.each([
    '小明\n', '\t小明', '小\u0000明', '小\u2028明', '小\u2029明',
    '小\u202e明', '小\u2066明', '小\u200b明', '\ufeff小明', '\ud83d', '\udc00',
    '\u200d', '\u200c', '\ufe0f', '\u0301', ' \u200d\ufe0f ',
  ])('拒绝控制、非法或仅不可见字符：%j', input => {
    expect(() => normalizeNicknameInput(input)).toThrow('昵称不能包含换行或不可见控制字符');
    expect(() => resolveEntryNickname(input, 'audience', 'same-user')).toThrow();
    expect(isValidNickname(input)).toBe(false);
  });

  it('允许正常 Emoji 连接、变体和旗帜标记序列', () => {
    for (const name of ['小明😀', '👩‍💻', '❤️', '🇨🇳', '🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}']) {
      expect(normalizeNicknameInput(name)).toBe(name);
      expect(isValidNickname(name)).toBe(true);
    }
  });

  it('URL 校验只接受最终非空规范值，兼容默认英文昵称', () => {
    for (const value of ['Host', 'Alice_037', '小明', '👩‍💻', '<小明>']) expect(isValidNickname(value)).toBe(true);
    for (const value of [null, undefined, 123, {}, '', '   ', ' 小明 ', 'e\u0301', '明'.repeat(21)]) {
      expect(isValidNickname(value)).toBe(false);
    }
  });
});

describe('昵称头像首字', () => {
  it('使用首个完整字素显示中文及组合 Emoji', () => {
    expect(getNicknameInitial('小明')).toBe('小');
    expect(getNicknameInitial('😀小明')).toBe('😀');
    expect(getNicknameInitial('👩‍💻小明')).toBe('👩‍💻');
    expect(getNicknameInitial('🇨🇳小明')).toBe('🇨🇳');
    expect(getNicknameInitial('e\u0301clair')).toBe('e\u0301');
    expect(getNicknameInitial(null)).toBe('+');
  });

  it('缺少 Segmenter 时回退到完整 Unicode 码点', () => {
    vi.spyOn(Intl, 'Segmenter', 'get').mockReturnValue(undefined as unknown as typeof Intl.Segmenter);
    expect(getNicknameInitial('😀小明')).toBe('😀');
    expect(getNicknameInitial('小明')).toBe('小');
    expect(getNicknameInitial('')).toBe('+');
  });
});
