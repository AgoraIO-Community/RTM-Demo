import { resolveRoomName, type RoomName } from './room-name';
import { NameDirectory, type DirectoryTransport, type NameDirectoryEntry } from './name-directory';
import { HostNameDirectoryRtm } from './host/name-directory-rtm';
import { AudienceNameDirectoryRtm } from './audience/name-directory-rtm';
import type { RtcHelper } from '../../shared/rtc';
import { resolveEntryNickname } from './nickname';
import { SingleRoomClient, type SingleRoomClientOptions } from './event-driven-single-room-client';
import type { AppRtmSession } from './app-rtm';
import { withVoiceRoomPageIdentity, type VoiceRoomUrlPayload } from './voice-room-url';

export type RoomEntryPhase = 'idle' | 'admitting' | 'subscribing' | 'room' | 'ended';

export interface NamedRoomEntry extends NameDirectoryEntry {
  nameKey: string;
}

export interface RoomEntryView {
  phase: RoomEntryPhase;
  client?: SingleRoomClient;
  entry?: NamedRoomEntry;
  payload?: VoiceRoomUrlPayload;
  error?: string;
  statusText?: string;
  managing?: boolean;
}

export interface RoomEntryControllerOptions {
  appId: string;
  session: AppRtmSession;
  createClient?: (options: SingleRoomClientOptions) => SingleRoomClient;
  createRtc?: () => RtcHelper;
  randomRoomId?: () => string;
  now?: () => number;
  replaceUrl?: (payload: VoiceRoomUrlPayload) => void;
  directoryTimeoutMs?: number;
  retryDirectoryWriteDelay?: () => Promise<void>;
}

function randomRoomId(): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 12);
  return `voice-room-${suffix}`;
}

export class RoomEntryController {
  private readonly createClient: (options: SingleRoomClientOptions) => SingleRoomClient;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private currentClient?: SingleRoomClient;
  private currentDirectory?: NameDirectory;
  private view: RoomEntryView = { phase: 'idle' };
  private busy = false;
  private pendingOperation?: Promise<void>;
  private leavePromise?: Promise<void>;

  constructor(private readonly options: RoomEntryControllerOptions) {
    this.createClient = options.createClient ?? (clientOptions => new SingleRoomClient(clientOptions));
    this.now = options.now ?? (() => Date.now());
  }

  getView(): RoomEntryView { return this.view; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createHostRoom(input: { roomName: string; nickname?: string }): Promise<void> {
    return this.runNamed(async generation => {
      const nickname = resolveEntryNickname(input.nickname, 'host', this.options.session.userId);
      const name = await resolveRoomName(input.roomName);
      this.checkGeneration(generation);
      const directory = this.createDirectory('host', name.nameKey);
      const snapshot = await directory.read();
      this.checkGeneration(generation);
      if (snapshot.entry?.status === 'active') {
        if (snapshot.entry.hostUserId !== this.options.session.userId) {
          throw new Error('房间被占用，请更换房间名再次创建');
        }
        await this.admitNamed('host', directory, snapshot, generation, nickname);
        return;
      }
      await this.createNamedHost(name, directory, snapshot.majorRevision, generation, nickname);
    });
  }

  joinAudienceByName(roomName: string, inputNickname?: string): Promise<void> {
    return this.runNamed(async generation => {
      const nickname = resolveEntryNickname(inputNickname, 'audience', this.options.session.userId);
      const name = await resolveRoomName(roomName);
      this.checkGeneration(generation);
      const directory = this.createDirectory('audience', name.nameKey);
      const snapshot = await directory.read();
      this.checkGeneration(generation);
      await this.admitNamed('audience', directory, snapshot, generation, nickname);
    });
  }

  joinAudienceFromUrlPayload(payload: VoiceRoomUrlPayload): Promise<void> {
    if (payload.role !== 'audience') return Promise.reject(new Error('邀请 URL 不是 Audience 入口'));
    return this.joinNamedPayload(payload);
  }

  restoreHostFromUrlPayload(payload: VoiceRoomUrlPayload): Promise<void> {
    if (payload.role !== 'host' || payload.pageUid !== this.options.session.userId) {
      return Promise.reject(new Error('Host 刷新 URL 与当前页面身份不匹配'));
    }
    return this.joinNamedPayload(payload);
  }

  private joinNamedPayload(payload: VoiceRoomUrlPayload): Promise<void> {
    return this.runNamed(async generation => {
      const nickname = resolveEntryNickname(payload.nickname, payload.role, this.options.session.userId);
      const source = { ...payload, nickname };
      const directory = this.createDirectory(payload.role, payload.nameKey);
      const snapshot = await directory.read();
      this.checkGeneration(generation);
      await this.admitNamed(payload.role, directory, snapshot, generation, nickname, source);
    });
  }

  private runNamed(action: (generation: number) => Promise<void>): Promise<void> {
    if (this.busy || this.currentClient || this.leavePromise) {
      return Promise.reject(new Error('已有房间操作进行中，请先完成或取消'));
    }
    this.busy = true;
    const generation = ++this.generation;
    this.setView({ phase: 'admitting', statusText: '正在查找房间…' });
    const operation = (async () => {
      try {
        await action(generation);
      } catch (error) {
        if (this.generation === generation) {
          const message = error instanceof Error ? error.message : '暂时无法确认房间状态，请重试';
          const client = this.currentClient;
          this.currentClient = undefined;
          try { await client?.leaveRoom(); } catch { /* Preserve admission failure. */ }
          try { await this.currentDirectory?.close(); } catch { /* Preserve admission failure. */ }
          this.currentDirectory = undefined;
          this.setView({ phase: 'idle', error: message });
          throw error;
        }
      } finally {
        this.busy = false;
        this.pendingOperation = undefined;
      }
    })();
    this.pendingOperation = operation;
    return operation;
  }

  private createDirectory(role: 'host' | 'audience', nameKey: string): NameDirectory {
    const transport = role === 'host'
      ? new HostNameDirectoryRtm(this.options.session, nameKey)
      : new AudienceNameDirectoryRtm(this.options.session, nameKey);
    const directory = new NameDirectory(transport, this.options.directoryTimeoutMs);
    this.currentDirectory = directory;
    return directory;
  }

  private async createNamedHost(
    name: RoomName,
    directory: NameDirectory,
    directoryRevision: number,
    generation: number,
    nickname: string,
  ): Promise<void> {
    const record: NameDirectoryEntry = {
      schemaVersion: 1,
      roomName: name.roomName,
      canonicalName: name.canonicalName,
      roomId: (this.options.randomRoomId ?? randomRoomId)(),
      hostUserId: this.options.session.userId,
      status: 'active',
      createdAt: this.now(),
      banUserIds: [],
    };
    const entry = this.namedEntry(name.nameKey, record);
    const payload = this.namedPayload('host', name.nameKey, record.roomId, nickname);
    const client = this.makeClient('host', entry, nickname);
    this.currentClient = client;
    this.setView({ phase: 'subscribing', client, entry, payload, statusText: '正在准备房间…' });
    await this.registerWithRetry(directory, record, directoryRevision, generation);
    try {
      await client.initializeMemberState();
      this.checkGeneration(generation);
      await client.subscribeRoom();
      this.checkGeneration(generation);
      this.finishNamed(client, entry, payload);
    } catch (error) {
      await this.removeDirectoryEntryIfCurrent(directory.transport, entry).catch(() => {});
      throw error;
    }
  }

  private async admitNamed(
    role: 'host' | 'audience',
    directory: NameDirectory,
    snapshot: Awaited<ReturnType<NameDirectory['read']>>,
    generation: number,
    nickname: string,
    source?: VoiceRoomUrlPayload,
  ): Promise<void> {
    const record = snapshot.entry;
    if (!record) throw new Error('未找到该房间，请检查名称');
    if (source && record.roomId !== source.roomId) throw new Error('原房间已结束，此链接不能加入同名的新房间');
    if (record.status === 'inactive') throw new Error('房间已解散');
    if (record.banUserIds.includes(this.options.session.userId)) throw new Error('你已被该房间封禁');
    if (role === 'host' && record.hostUserId !== this.options.session.userId) throw new Error('房主身份与房间登记不匹配');
    const entry = this.namedEntry(directory.transport.nameKey, record);
    const payload = source ?? this.namedPayload(role, entry.nameKey, entry.roomId, nickname);
    const client = this.makeClient(role, entry, nickname);
    this.currentClient = client;
    this.setView({ phase: 'subscribing', client, entry, payload, statusText: '正在加入房间…' });
    await client.initializeMemberState();
    this.checkGeneration(generation);
    await client.subscribeRoom();
    this.checkGeneration(generation);
    const finalPayload = role === 'audience'
      ? withVoiceRoomPageIdentity(payload, this.options.session.userId, nickname)
      : payload;
    this.finishNamed(client, entry, finalPayload);
  }

  private finishNamed(client: SingleRoomClient, entry: NamedRoomEntry, payload: VoiceRoomUrlPayload): void {
    this.options.replaceUrl?.(payload);
    this.setView({ phase: 'room', client, entry, payload });
    client.startRoomRuntime();
  }

  leaveRoom(): Promise<void> {
    if (this.leavePromise) return this.leavePromise;
    this.generation += 1;
    const client = this.currentClient;
    this.currentClient = undefined;
    const directory = this.currentDirectory;
    this.currentDirectory = undefined;
    const pendingOperation = this.pendingOperation;
    this.leavePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([client?.leaveRoom(), directory?.close()]);
      await pendingOperation?.catch(() => {});
      this.setView({ phase: 'idle' });
    }).finally(() => { this.leavePromise = undefined; });
    return this.leavePromise;
  }

  private makeClient(role: 'host' | 'audience', entry: NamedRoomEntry, displayName: string): SingleRoomClient {
    const directory = this.currentDirectory!;
    return this.createClient({
      appId: this.options.appId,
      roomId: entry.roomId,
      roomName: entry.roomName,
      hostUserId: entry.hostUserId,
      userId: this.options.session.userId,
      displayName,
      role,
      session: this.options.session,
      createRtc: this.options.createRtc,
      onBanUser: role === 'host' ? userId => this.changeNamedRoom(directory, entry, userId) : undefined,
      onRoomDissolved: role === 'host' ? () => this.changeNamedRoom(directory, entry) : undefined,
      onRoomCleanup: role === 'host' ? () => this.removeDirectoryEntryIfCurrent(directory.transport, entry) : undefined,
      now: this.now,
    });
  }

  private async changeNamedRoom(directory: NameDirectory, entry: NamedRoomEntry, banUserId?: string): Promise<void> {
    if (this.view.managing) throw new Error('正在同步房间状态，请稍候');
    this.setView({ ...this.view, managing: true });
    try {
      const snapshot = await directory.read();
      const record = snapshot.entry;
      if (!record) throw new Error('房间登记不存在');
      if (record.roomId !== entry.roomId || record.hostUserId !== this.options.session.userId) {
        throw new Error('原房间已结束，无法修改同名的新房间');
      }
      if (record.status === 'inactive' && !banUserId) return;
      if (record.status !== 'active') throw new Error('房间已结束');
      const next: NameDirectoryEntry = banUserId
        ? { ...record, banUserIds: [...new Set([...record.banUserIds, banUserId])] }
        : { ...record, status: 'inactive', endedAt: this.now() };
      const transport = directory.transport as HostNameDirectoryRtm;
      await (banUserId
        ? transport.banMember(next, snapshot.majorRevision)
        : transport.endRoom(next, snapshot.majorRevision));
    } finally {
      this.setView({ ...this.view, managing: false });
    }
  }

  private async registerWithRetry(
    directory: NameDirectory,
    record: NameDirectoryEntry,
    initialRevision: number,
    generation: number,
  ): Promise<void> {
    let revision = initialRevision;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await (directory.transport as HostNameDirectoryRtm).registerRoom(record, revision);
        return;
      } catch {
        this.checkGeneration(generation);
        const latest = await directory.read();
        if (latest.entry?.hostUserId === record.hostUserId && latest.entry.roomId === record.roomId) return;
        if (latest.entry?.status === 'active') throw new Error('房间被占用，请更换房间名再次创建');
        revision = latest.majorRevision;
        if (attempt < 2) {
          await (this.options.retryDirectoryWriteDelay?.() ?? new Promise(resolve => setTimeout(resolve, 300)));
        }
      }
    }
    throw new Error('房间被占用，请更换房间名再次创建');
  }

  private async removeDirectoryEntryIfCurrent(transport: DirectoryTransport, entry: NamedRoomEntry): Promise<void> {
    const directory = new NameDirectory(transport, this.options.directoryTimeoutMs);
    const snapshot = await directory.read();
    const current = snapshot.entry;
    if (!current || current.roomId !== entry.roomId || current.hostUserId !== entry.hostUserId) return;
    await (transport as HostNameDirectoryRtm).removeRoom(snapshot.majorRevision);
  }

  private namedEntry(nameKey: string, record: NameDirectoryEntry): NamedRoomEntry {
    return { ...record, nameKey };
  }

  private namedPayload(role: 'host' | 'audience', nameKey: string, roomId: string, nickname: string): VoiceRoomUrlPayload {
    return { version: 2, nameKey, roomId, role, pageUid: role === 'host' ? this.options.session.userId : null, nickname };
  }

  private checkGeneration(generation: number): void {
    if (this.generation !== generation) throw new Error('操作已取消');
    if (this.currentClient?.getView().endedReason) throw new Error(this.currentClient.getView().endedReason);
  }

  private setView(view: RoomEntryView): void {
    this.view = view;
    for (const listener of this.listeners) listener();
  }
}
