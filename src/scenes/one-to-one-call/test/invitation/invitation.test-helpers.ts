import { CallController, type CallControllerOptions } from '../../invitation/call-controller';
import type { InvitationLinkState } from '../../invitation/call-state';

export const ALPHA = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const BETA = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
export const GAMMA = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

export function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export function message(customType: string, callId = ALPHA, type?: string, publisher = 'bob', extra = '') {
  return { channelType: 'USER', customType, publisher, message: JSON.stringify({ callId, extra, ...(type ? { type } : {}) }) };
}

export function setup(options: Partial<CallControllerOptions> = {}) {
  const sent: Array<{ target: string; customType: string; payload: Record<string, unknown> }> = [];
  let implementation: (target: string, type: string, payload: Record<string, unknown>) => Promise<void> = async () => undefined;
  let linkState: InvitationLinkState = 'connected';
  let id = 0;
  const controller = new CallController({
    localUid: 'alice', getLinkState: () => linkState,
    createCallId: () => [ALPHA, BETA, GAMMA][id++]!,
    port: { publishToUser(target: string, customType: string, content: string) {
      const payload = JSON.parse(content) as Record<string, unknown>;
      sent.push({ target, customType, payload });
      return implementation(target, customType, payload);
    } },
    ...options,
  });
  return {
    controller, sent,
    publishWith(value: typeof implementation) { implementation = value; },
    setLinkState(value: InvitationLinkState) { linkState = value; },
  };
}

export async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
