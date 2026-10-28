export interface RoomName {
  roomName: string;
  canonicalName: string;
  nameKey: string;
}

export function normalizeRoomName(input: string): Omit<RoomName, 'nameKey'> {
  if (/[\p{Cc}\p{Cf}]/u.test(input)) throw new Error('房间名称不能包含换行或不可见字符');
  const roomName = input.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!roomName) throw new Error('请输入房间名称');
  if ([...roomName].length > 32) throw new Error('房间名称最多 32 个字符');
  return { roomName, canonicalName: roomName.replace(/[A-Z]/g, c => c.toLowerCase()) };
}

export function isNameKey(value: unknown): value is string {
  return typeof value === 'string' && /^vrn-v1-[A-Za-z0-9_-]{43}$/u.test(value);
}

export async function resolveRoomName(input: string): Promise<RoomName> {
  const normalized = normalizeRoomName(input);
  const bytes = new TextEncoder().encode(`voice-room:v1:${normalized.canonicalName}`);
  if (!crypto.subtle) throw new Error('请使用 HTTPS 或本机 localhost 地址打开体验馆');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const encoded = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
  return { ...normalized, nameKey: `vrn-v1-${encoded}` };
}
