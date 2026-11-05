import type { RTMEvents } from 'agora-rtm';
import { AppRtmSession, type AppRtmClient, type AppRtmEventListeners } from '../app-rtm';

/** Shared cloud boundary for independent page sessions; no shared browser storage. */
export function createDirectoryTestHub() {
  const records = new Map<string, { majorRevision: number; metadata: Record<string, { value: string; revision: number; authorUid: string; updated: number }> }>();
  const clients = new Map<string, { listeners: AppRtmEventListeners; channels: Set<string> }>();
  const calls: Array<{ userId: string; name: string; channel?: string; revision?: number; options?: unknown }> = [];
  const writeFailures: Array<'before' | 'after'> = [];
  let skipSnapshots = false;
  let skipRoomSnapshots = false;
  let skipMessages = false;
  function emitStorage(userId: string, channelName: string, eventType: 'SNAPSHOT' | 'UPDATE' | 'REMOVE') {
    const current = records.get(channelName) ?? { majorRevision: 0, metadata: {} };
    clients.get(userId)?.listeners.storage?.({ timestamp: Date.now(), channelName, channelType: 'MESSAGE', storageType: 'CHANNEL', eventType,
      publisher: '', data: { ...current, totalCount: Object.keys(current.metadata).length } });
  }
  function emitLink(userId: string, connected: boolean) {
    clients.get(userId)?.listeners.linkState?.({ timestamp: Date.now(), previousState: connected ? 'DISCONNECTED' : 'CONNECTED',
      currentState: connected ? 'CONNECTED' : 'DISCONNECTED', operation: 'AUTO_RECONNECT', reasonCode: 'TEST', reason: '',
      affectedChannels: [], unrestoredChannels: [], isResumed: connected, serviceType: 'RTM' } as unknown as RTMEvents.LinkStateEvent);
  }
  function session(userId: string) {
    const state = { listeners: {} as AppRtmEventListeners, channels: new Set<string>() };
    clients.set(userId, state);
    const sdk: AppRtmClient = {
      addEventListener(name, listener) { Object.assign(state.listeners, { [name]: listener }); },
      removeEventListener(name) { delete state.listeners[name as keyof AppRtmEventListeners]; },
      async login() { calls.push({ userId, name: 'login' }); emitLink(userId, true); },
      async logout() { calls.push({ userId, name: 'logout' }); state.channels.clear(); },
      async subscribe(channel, options) {
        calls.push({ userId, name: 'subscribe', channel, options });
        state.channels.add(channel);
        if (!skipSnapshots && !(skipRoomSnapshots && !channel.startsWith('vrn-v1-'))) emitStorage(userId, channel, 'SNAPSHOT');
      },
      async unsubscribe(channel) { calls.push({ userId, name: 'unsubscribe', channel }); state.channels.delete(channel); },
      async publish(channel, message, options) {
        calls.push({ userId, name: `publish:${JSON.parse(message).type}`, channel });
        if (skipMessages) throw new Error('消息发送失败');
        for (const [uid, other] of clients) {
          if (uid !== userId && (options?.channelType === 'USER' ? uid === channel : other.channels.has(channel))) {
            other.listeners.message?.({ timestamp: Date.now(), channelName: channel, channelType: options?.channelType ?? 'MESSAGE',
              publisher: userId, message } as RTMEvents.MessageEvent);
          }
        }
      },
      presence: {
        async setState(channel) { calls.push({ userId, name: 'presence', channel }); },
        async removeState() {},
      },
      storage: {
        async getChannelMetadata(channel) {
          calls.push({ userId, name: 'get', channel });
          const current = records.get(channel) ?? { majorRevision: 0, metadata: {} };
          return { ...current, totalCount: Object.keys(current.metadata).length };
        },
        async removeChannelMetadata(channel, _channelType, options?: { majorRevision?: number }) {
          calls.push({ userId, name: 'remove', channel });
          const current = records.get(channel) ?? { majorRevision: 0, metadata: {} };
          if (options?.majorRevision !== undefined && options.majorRevision !== current.majorRevision) {
            throw Object.assign(new Error('版本冲突'), { errorCode: -12014 });
          }
          records.set(channel, { majorRevision: (current?.majorRevision ?? 0) + 1, metadata: {} });
          for (const [uid, other] of clients) if (other.channels.has(channel)) emitStorage(uid, channel, 'REMOVE');
          return { totalCount: 0 };
        },
        async setChannelMetadata(channel, _type, data, options) {
          calls.push({ userId, name: 'write', channel, revision: options?.majorRevision });
          const failure = writeFailures.shift();
          if (failure === 'before') throw new Error('写入网络失败');
          const current = records.get(channel) ?? { majorRevision: 0, metadata: {} };
          if (options?.majorRevision !== undefined && options.majorRevision !== -1 && options.majorRevision !== current.majorRevision) {
            throw Object.assign(new Error('版本冲突'), { errorCode: -12014 });
          }
          const revision = current.majorRevision + 1;
          records.set(channel, { majorRevision: revision, metadata: { ...current.metadata,
            ...Object.fromEntries(data.map(item => [item.key, { value: item.value, revision, authorUid: userId, updated: Date.now() }])) } });
          for (const [uid, other] of clients) if (other.channels.has(channel)) emitStorage(uid, channel, 'UPDATE');
          if (failure === 'after') throw new Error('应答丢失');
          return { totalCount: Object.keys(records.get(channel)!.metadata).length };
        },
      },
    };
    return new AppRtmSession('test-app', userId, { createClient: () => sdk });
  }
  return { session, records, clients, calls, emitStorage, emitLink,
    failNextWrite: (when: 'before' | 'after') => { writeFailures.push(when); },
    pauseSnapshots: (value: boolean) => { skipSnapshots = value; },
    pauseRoomSnapshots: (value: boolean) => { skipRoomSnapshots = value; },
    failMessages: (value: boolean) => { skipMessages = value; },
  };
}
