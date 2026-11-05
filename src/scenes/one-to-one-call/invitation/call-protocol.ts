export const CALL_SIGNAL_TYPES = [
  'CALL_KIT_INVITE',
  'CALL_KIT_ACCEPT',
  'CALL_KIT_REFUSE',
  'CALL_KIT_CANCEL',
] as const;

export type CallSignalType = typeof CALL_SIGNAL_TYPES[number];
export type AcceptType = 'accepted' | 'ack';

export interface CallSignalEnvelope {
  callId: string;
  extra: string;
  type?: AcceptType;
}

export interface CallSignal extends CallSignalEnvelope {
  customType: CallSignalType;
  senderId: string;
}

export interface BuildCallSignalInput {
  customType: CallSignalType;
  callId: string;
  extra?: string;
  type?: AcceptType;
}

export interface InvitationMessageEvent {
  channelType?: unknown;
  customType?: unknown;
  publisher?: unknown;
  message?: unknown;
}

export type ParsedCallSignal =
  | { accepted: true; signal: CallSignal }
  | { accepted: false; reason: string };

const CALL_ID_PATTERN = /^[0-9A-F]{32}$/;

export function createCallId(randomBytes: (size: number) => Uint8Array = defaultRandomBytes): string {
  return [...randomBytes(16)].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

export function buildCallSignal(input: BuildCallSignalInput): CallSignalEnvelope {
  return {
    callId: input.callId,
    extra: input.extra ?? '',
    ...(input.type === undefined ? {} : { type: input.type }),
  };
}

export function parseCallSignal(event: InvitationMessageEvent, localUid: string): ParsedCallSignal {
  if (event.channelType !== 'USER') return { accepted: false, reason: '不是 USER 点对点消息' };
  if (!CALL_SIGNAL_TYPES.includes(event.customType as CallSignalType)) {
    return { accepted: false, reason: '信令类型无效' };
  }
  if (typeof event.publisher !== 'string' || !event.publisher || event.publisher === localUid) {
    return { accepted: false, reason: '信令来源无效' };
  }
  if (typeof event.message !== 'string') return { accepted: false, reason: '信令必须是文本消息' };
  let raw: unknown;
  try { raw = JSON.parse(event.message); }
  catch { return { accepted: false, reason: '信令 JSON 无效' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { accepted: false, reason: '信令结构无效' };
  const value = raw as Record<string, unknown>;
  if (typeof value.callId !== 'string' || !CALL_ID_PATTERN.test(value.callId)) {
    return { accepted: false, reason: 'callId 无效' };
  }
  if (value.extra !== undefined && typeof value.extra !== 'string') {
    return { accepted: false, reason: 'extra 必须为字符串' };
  }
  const customType = event.customType as CallSignalType;
  if (customType === 'CALL_KIT_ACCEPT' && value.type !== 'accepted' && value.type !== 'ack') {
    return { accepted: false, reason: 'ACCEPT type 无效' };
  }
  if (customType !== 'CALL_KIT_ACCEPT' && value.type !== undefined) {
    return { accepted: false, reason: '信令 type 无效' };
  }
  return {
    accepted: true,
    signal: {
      customType, callId: value.callId, senderId: event.publisher, extra: value.extra as string | undefined ?? '',
      ...(customType === 'CALL_KIT_ACCEPT' ? { type: value.type as AcceptType } : {}),
    },
  };
}
