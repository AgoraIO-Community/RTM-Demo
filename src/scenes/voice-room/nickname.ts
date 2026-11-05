import { createAudienceDisplayName } from './audience-display-name';

const INVALID_CHARACTERS = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;
const FORMAT_CHARACTER = /\p{Cf}/u;
const VISIBLE_CHARACTER = /[\p{L}\p{N}\p{P}\p{S}]/u;
const INVALID_MESSAGE = '昵称不能包含换行或不可见控制字符';
export const MAX_NICKNAME_LENGTH = 20;

/** Join controls and emoji tag characters can be part of visible Unicode text. */
function isAllowedFormatCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return codePoint === 0x200c || codePoint === 0x200d
    || (codePoint >= 0xe0020 && codePoint <= 0xe007f);
}

/** Empty input is optional; non-empty invalid input must never become a default name. */
export function normalizeNicknameInput(input?: string | null): string {
  if (input == null) return '';
  if (INVALID_CHARACTERS.test(input)
    || [...input].some(character => FORMAT_CHARACTER.test(character) && !isAllowedFormatCharacter(character))) {
    throw new Error(INVALID_MESSAGE);
  }
  const nickname = input.normalize('NFC').trim();
  if (!nickname) return '';
  if (!VISIBLE_CHARACTER.test(nickname)) throw new Error(INVALID_MESSAGE);
  if ([...nickname].length > MAX_NICKNAME_LENGTH) throw new Error('昵称最多 20 个字符');
  return nickname;
}

export function resolveEntryNickname(
  input: string | null | undefined,
  role: 'host' | 'audience',
  userId: string,
): string {
  return normalizeNicknameInput(input) || (role === 'host' ? 'Host' : createAudienceDisplayName(userId));
}

/** URL payloads contain the final normalized nickname, or an explicit legacy null. */
export function isValidNickname(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try { return normalizeNicknameInput(value) === value; }
  catch { return false; }
}

/** Preserve a whole emoji/grapheme; older browsers still preserve surrogate pairs. */
export function getNicknameInitial(value?: string | null): string {
  if (!value) return '+';
  if (typeof Intl.Segmenter === 'function') {
    return new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      .segment(value)[Symbol.iterator]().next().value?.segment ?? '+';
  }
  return [...value][0] ?? '+';
}
