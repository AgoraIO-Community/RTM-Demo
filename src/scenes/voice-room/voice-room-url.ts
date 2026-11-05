import { isNameKey } from './room-name';
import { isValidNickname } from './nickname';
import { appPath } from '../../shared/paths';

export interface VoiceRoomUrlPayload {
  version: 2;
  nameKey: string;
  roomId: string;
  role: 'host' | 'audience';
  pageUid: string | null;
  nickname: string | null;
}

export type NamedVoiceRoomUrlPayload = VoiceRoomUrlPayload;

export function isNamedVoiceRoomPayload(payload: VoiceRoomUrlPayload): payload is NamedVoiceRoomUrlPayload {
  return payload.version === 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64UrlToBytes(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error('非法的 Base64URL');
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

export function parseVoiceRoomUrlPayloadValue(value: unknown): VoiceRoomUrlPayload | undefined {
  if (!isRecord(value) || value.version !== 2 ||
      !hasExactKeys(value, ['version', 'nameKey', 'roomId', 'role', 'pageUid', 'nickname']) ||
      !isNameKey(value.nameKey) || !isNonEmptyString(value.roomId) ||
      (value.role !== 'host' && value.role !== 'audience') ||
      (value.pageUid !== null && !isNonEmptyString(value.pageUid)) ||
      (value.role === 'host' && value.pageUid === null) ||
      (value.nickname !== null && !isValidNickname(value.nickname))) return undefined;
  return value as unknown as VoiceRoomUrlPayload;
}

export function encodeVoiceRoomUrlPayload(payload: VoiceRoomUrlPayload): string {
  const validated = parseVoiceRoomUrlPayloadValue(payload);
  if (!validated) throw new Error('非法的语聊房 URL payload');
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(validated)));
}

export function decodeVoiceRoomUrlPayload(encoded: string): VoiceRoomUrlPayload | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(encoded)));
    return parseVoiceRoomUrlPayloadValue(value);
  } catch {
    return undefined;
  }
}

export function parseVoiceRoomUrl(urlOrSearch: string): VoiceRoomUrlPayload | undefined {
  const input = urlOrSearch.trim();
  if (/^[A-Za-z0-9_-]+$/u.test(input)) return decodeVoiceRoomUrlPayload(input);
  if (input.startsWith('data=')) return decodeVoiceRoomUrlPayload(input.slice('data='.length));
  try {
    const url = new URL(input, 'http://localhost/social/voice-room');
    const values = url.searchParams.getAll('data');
    return [...url.searchParams.keys()].length === 1 && values.length === 1
      ? decodeVoiceRoomUrlPayload(values[0])
      : undefined;
  } catch {
    return undefined;
  }
}

export function createVoiceRoomInviteCode(payload: VoiceRoomUrlPayload): string {
  return `data=${encodeVoiceRoomUrlPayload(payload)}`;
}

export function createVoiceRoomUrl(origin: string, payload: VoiceRoomUrlPayload): string {
  return `${origin.replace(/\/$/u, '')}${appPath('/social/voice-room')}?data=${encodeVoiceRoomUrlPayload(payload)}`;
}

export function withVoiceRoomPageIdentity(payload: VoiceRoomUrlPayload, pageUid: string, nickname: string): VoiceRoomUrlPayload {
  if (!isNonEmptyString(pageUid)) throw new Error('页面 UID 不能为空');
  if (!isValidNickname(nickname)) throw new Error('昵称格式不正确');
  return { ...payload, pageUid, nickname };
}
