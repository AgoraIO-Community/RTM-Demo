/** Demo identity rules; customer apps supply their own RTM UID and profile. */
const STORAGE_KEY = 'rtm-lab.one-to-one-call.uid';
const VALID_UID = /^call-[A-Za-z0-9_-]{6,64}$/;

export function isValidCallUid(value: string): boolean {
  return VALID_UID.test(value);
}

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getOrCreateCallIdentity(
  storage: SessionStorageLike,
  randomSegment: () => string = defaultRandomSegment,
): { uid: string } {
  const existing = storage.getItem(STORAGE_KEY);
  if (existing && isValidCallUid(existing)) return { uid: existing };
  const uid = `call-${randomSegment()}`;
  storage.setItem(STORAGE_KEY, uid);
  return { uid };
}

function defaultRandomSegment(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

export type NormalizedNickname = { value: string } | { error: string };

export function normalizeCallNickname(input: string): NormalizedNickname {
  if (/\r|\n|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(input)) {
    return { error: '昵称不能包含换行或控制字符' };
  }
  const value = input.normalize('NFC').trim();
  if ([...value].length > 20) return { error: '昵称最多 20 个字符' };
  return { value };
}
