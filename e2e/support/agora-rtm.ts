import type { AppRtmClient } from '../../src/scenes/voice-room/app-rtm';

type E2eMetadataRecord = {
  majorRevision: number;
  metadata: Record<string, { value: string; revision: number }>;
};

type E2ePresenceStore = Record<string, Record<string, Record<string, string>>>;

type E2eBusEvent =
  | { kind: 'message'; channelName: string; channelType: 'MESSAGE' | 'USER'; publisher: string; message: string; customType?: string }
  | { kind: 'presence'; channelName: string; eventType: 'REMOTE_JOIN' | 'REMOTE_LEAVE' | 'REMOTE_STATE_CHANGED'; publisher: string; stateChanged: Record<string, string> }
  | { kind: 'storage'; channelName: string; eventType: 'UPDATE' | 'REMOVE'; publisher: string; data: E2eMetadataRecord };

const E2E_METADATA_PREFIX = 'voice-room-e2e:metadata:';
const E2E_PRESENCE_KEY = 'voice-room-e2e:presence';
const E2E_BUS_NAME = 'voice-room-e2e:events';

function readE2eJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function createE2eAppRtmClient(userId: string): AppRtmClient {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const subscriptions = new Set<string>();
  const bus = new BroadcastChannel(E2E_BUS_NAME);
  const metadataKey = (channelName: string) => `${E2E_METADATA_PREFIX}${channelName}`;
  const readMetadata = (channelName: string): E2eMetadataRecord =>
    readE2eJson(metadataKey(channelName), { majorRevision: 0, metadata: {} });
  const writeMetadata = (channelName: string, record: E2eMetadataRecord) => {
    localStorage.setItem(metadataKey(channelName), JSON.stringify(record));
  };
  const readPresence = (): E2ePresenceStore => readE2eJson(E2E_PRESENCE_KEY, {});
  const writePresence = (store: E2ePresenceStore) => {
    localStorage.setItem(E2E_PRESENCE_KEY, JSON.stringify(store));
  };

  try {
    const encoded = new URLSearchParams(window.location.search).get('data');
    if (encoded) {
      const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      const payload = JSON.parse(atob(padded)) as { version?: number; nameKey?: string; roomId?: string };
      if (payload.version === 2
          && payload.nameKey === 'vrn-v1-3ClZaE065tpz4y0sNaEmKBQTaEx_QY2Fr4abald0wPc'
          && payload.roomId) {
        const revision = 1;
        const hostUserId = 'host-e2e';
        const seats = Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
          const seatId = `seat-${index}`;
          return [seatId, { seatId, userId: index === 0 ? hostUserId : null, displayName: index === 0 ? 'Host' : null }];
        }));
        const entry = {
          schemaVersion: 1,
          canonicalName: '邀请房间',
          roomName: '邀请房间',
          roomId: payload.roomId,
          hostUserId,
          status: 'active',
          createdAt: Date.now(),
          banUserIds: [],
        };
        if (readMetadata(payload.nameKey).majorRevision === 0) {
          writeMetadata(payload.nameKey, { majorRevision: revision, metadata: { entry: { value: JSON.stringify(entry), revision } } });
        }
        if (readMetadata(payload.roomId).majorRevision === 0) {
          writeMetadata(payload.roomId, { majorRevision: revision, metadata: {
            hostUserId: { value: hostUserId, revision },
            announcement: { value: '', revision },
            seats: { value: JSON.stringify(seats), revision },
            forcedMutedUserIds: { value: '[]', revision },
          } });
        }
      }
    }
  } catch {
    // Invalid direct-entry payloads are handled by the application URL parser.
  }

  const emit = (name: string, event: unknown) => {
    queueMicrotask(() => {
      for (const listener of listeners.get(name) ?? []) listener(event as never);
    });
  };
  const receive = (event: E2eBusEvent) => {
    if (event.kind === 'message') {
      if (event.channelType === 'USER' ? event.channelName !== userId : !subscriptions.has(event.channelName)) return;
      emit('message', {
        timestamp: Date.now(), channelName: event.channelName, channelType: event.channelType,
        publisher: event.publisher, messageType: 'STRING', message: event.message,
        customType: event.customType ?? '',
      });
      return;
    }
    if (!subscriptions.has(event.channelName) || event.publisher === userId && event.kind === 'presence') return;
    if (event.kind === 'presence') {
      emit('presence', {
        timestamp: Date.now(), channelName: event.channelName, channelType: 'MESSAGE',
        eventType: event.eventType, publisher: event.publisher, stateChanged: event.stateChanged,
        snapshot: null, interval: null,
      });
      return;
    }
    emit('storage', {
      timestamp: Date.now(), channelName: event.channelName, channelType: 'MESSAGE', storageType: 'CHANNEL',
      eventType: event.eventType, publisher: event.publisher,
      data: { ...event.data, totalCount: Object.keys(event.data.metadata).length },
    });
  };
  bus.addEventListener('message', ({ data }) => receive(data as E2eBusEvent));

  const leaveChannel = (channelName: string) => {
    if (!subscriptions.delete(channelName)) return;
    const presence = readPresence();
    const channel = { ...presence[channelName] };
    delete channel[userId];
    if (Object.keys(channel).length === 0) delete presence[channelName];
    else presence[channelName] = channel;
    writePresence(presence);
    bus.postMessage({ kind: 'presence', channelName, eventType: 'REMOTE_LEAVE', publisher: userId, stateChanged: {} } satisfies E2eBusEvent);
  };
  const leaveAllChannels = () => {
    for (const channelName of [...subscriptions]) leaveChannel(channelName);
  };
  window.addEventListener('pagehide', leaveAllChannels, { once: true });

  return {
    addEventListener(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener as (event: never) => void);
      listeners.set(name, set);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener as (event: never) => void);
    },
    async login() {
      emit('linkState', {
        timestamp: Date.now(), previousState: 'CONNECTING', currentState: 'CONNECTED', operation: 'LOGIN',
        reasonCode: 'LOGIN_SUCCESS', reason: '', affectedChannels: [], unrestoredChannels: [],
        isResumed: false, serviceType: 'RTM',
      });
    },
    async logout() {
      leaveAllChannels();
      bus.close();
    },
    async subscribe(channelName) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      subscriptions.add(channelName);
      const presence = readPresence();
      emit('presence', {
        timestamp: Date.now(), channelName, channelType: 'MESSAGE', eventType: 'SNAPSHOT', publisher: '',
        snapshot: Object.entries(presence[channelName] ?? {}).map(([memberUserId, states]) => ({ userId: memberUserId, states })),
        interval: null,
      });
      const record = readMetadata(channelName);
      emit('storage', {
        timestamp: Date.now(), channelName, channelType: 'MESSAGE', storageType: 'CHANNEL',
        eventType: 'SNAPSHOT', publisher: '', data: { ...record, totalCount: Object.keys(record.metadata).length },
      });
      bus.postMessage({
        kind: 'presence', channelName, eventType: 'REMOTE_JOIN', publisher: userId,
        stateChanged: presence[channelName]?.[userId] ?? {},
      } satisfies E2eBusEvent);
    },
    async unsubscribe(channelName) {
      leaveChannel(channelName);
    },
    async publish(channelName, message, options) {
      const event: E2eBusEvent = {
        kind: 'message', channelName, message, publisher: userId,
        channelType: options?.channelType === 'USER' ? 'USER' : 'MESSAGE',
        customType: options?.customType,
      };
      receive(event);
      bus.postMessage(event);
    },
    presence: {
      async setState(channelName, _channelType, state) {
        const presence = readPresence();
        const channel = { ...presence[channelName] };
        const next = { ...channel[userId], ...state };
        channel[userId] = next;
        presence[channelName] = channel;
        writePresence(presence);
        bus.postMessage({
          kind: 'presence', channelName, eventType: 'REMOTE_STATE_CHANGED', publisher: userId, stateChanged: next,
        } satisfies E2eBusEvent);
      },
      async removeState(channelName, _channelType, options) {
        const presence = readPresence();
        const channel = { ...presence[channelName] };
        const next = { ...channel[userId] };
        for (const key of options.states) delete next[key];
        channel[userId] = next;
        presence[channelName] = channel;
        writePresence(presence);
        bus.postMessage({
          kind: 'presence', channelName, eventType: 'REMOTE_STATE_CHANGED', publisher: userId, stateChanged: next,
        } satisfies E2eBusEvent);
      },
    },
    storage: {
      async getChannelMetadata(channelName) {
        const current = readMetadata(channelName);
        return { ...current, totalCount: Object.keys(current.metadata).length };
      },
      async removeChannelMetadata(channelName, _channelType, options) {
        const current = readMetadata(channelName);
        if (options?.majorRevision !== undefined && options.majorRevision !== -1 && options.majorRevision !== current.majorRevision) {
          throw Object.assign(new Error('版本冲突'), { errorCode: -12014 });
        }
        const next = { majorRevision: current.majorRevision + 1, metadata: {} };
        writeMetadata(channelName, next);
        const event = { kind: 'storage', channelName, eventType: 'REMOVE', publisher: userId, data: next } satisfies E2eBusEvent;
        receive(event);
        bus.postMessage(event);
        return { totalCount: 0 };
      },
      async setChannelMetadata(channelName, _channelType, data, options) {
        const current = readMetadata(channelName);
        const revision = current.majorRevision;
        if (options?.majorRevision !== undefined && options.majorRevision !== -1 && options.majorRevision !== revision) {
          throw Object.assign(new Error('版本冲突'), { errorCode: -12014 });
        }
        const next = {
          majorRevision: revision + 1,
          metadata: {
            ...current.metadata,
            ...Object.fromEntries(data.map(({ key, value }) => [key, { value, revision: revision + 1 }])),
          },
        };
        writeMetadata(channelName, next);
        const event = { kind: 'storage', channelName, eventType: 'UPDATE', publisher: userId, data: next } satisfies E2eBusEvent;
        receive(event);
        bus.postMessage(event);
      },
    },
  };
}

function RTM(_appId: string, userId: string): AppRtmClient {
  return createE2eAppRtmClient(userId);
}

export default { RTM };
