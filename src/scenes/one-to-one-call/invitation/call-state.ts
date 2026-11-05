export enum CallerInvitationState {
  IDLE = 0,
  SENT_TO_CALLEE = 1,
  RECEIVED_BY_CALLEE = 2,
  ACCEPTED_BY_CALLEE = 3,
  REFUSED_BY_CALLEE = 4,
  CANCELED = 5,
  FAILURE = 6,
}

export enum CalleeInvitationState {
  IDLE = 10,
  INVITATION_RECEIVED = 11,
  ACCEPT_SENT_TO_CALLER = 12,
  ACCEPTED = 13,
  REFUSED = 14,
  CANCELED_BY_CALLER = 15,
  FAILURE = 16,
}

export type InvitationRole = 'CALLER' | 'CALLEE';
export type InvitationState = CallerInvitationState | CalleeInvitationState;
export type InvitationLinkState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
export type CallFinishReason =
  | 'PEER_OFFLINE' | 'LOCAL_NETWORK_ERROR' | 'PUBLISH_TIMEOUT' | 'PUBLISH_FAILED'
  | 'SEND_TIMEOUT' | 'PEER_NO_RESPONSE' | 'INVITATION_EXPIRE' | 'ACCEPT_ACK_TIMEOUT' | 'STOPPED';
export type InvitationTrigger = 'SEND_TIMEOUT' | 'RETRY_EXHAUSTED' | 'INVITATION_TIMEOUT' | 'ACK_TIMEOUT' | 'STOPPED' | 'LINK_FAILED';

export interface InvitationOptions {
  maxRetries?: number;
  retryIntervalMs?: number;
  sendTimeoutMs?: number;
  callerInvitationExpireMs?: number;
  calleeInvitationExpireMs?: number;
}

export interface InvitationMessageOutcome {
  consumed: boolean;
  reason: string;
}

export function isTerminalInvitationState(state: InvitationState): boolean {
  return (state >= 3 && state <= 6) || (state >= 13 && state <= 16);
}

const CALLER_TRANSITIONS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 6], 1: [2, 5, 6], 2: [3, 4, 5, 6],
};
const CALLEE_TRANSITIONS: Readonly<Record<number, readonly number[]>> = {
  10: [11, 16], 11: [12, 14, 15, 16], 12: [13, 15, 16],
};

export function canTransitionInvitation(role: InvitationRole, from: InvitationState, to: InvitationState): boolean {
  return (role === 'CALLER' ? CALLER_TRANSITIONS : CALLEE_TRANSITIONS)[from]?.includes(to) ?? false;
}
