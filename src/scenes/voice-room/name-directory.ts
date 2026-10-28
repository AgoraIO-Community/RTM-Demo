import { normalizeRoomName, resolveRoomName } from './room-name';

export interface NameDirectoryEntry {
  schemaVersion: 1;
  canonicalName: string;
  roomName: string;
  roomId: string;
  hostUserId: string;
  status: 'active' | 'inactive';
  createdAt: number;
  endedAt?: number;
  banUserIds: string[];
}

export interface NameDirectorySnapshot {
  majorRevision: number;
  entry?: NameDirectoryEntry;
}

export interface DirectoryMetadataResult {
  majorRevision: number;
  metadata: Record<string, { value: string }>;
}

export interface DirectoryTransport {
  readonly nameKey: string;
  readDirectory(): Promise<DirectoryMetadataResult>;
}

export function parseNameDirectoryEntry(value: unknown): NameDirectoryEntry {
  if (!value || typeof value !== 'object') throw new Error('房间登记信息不完整');
  const entry = value as NameDirectoryEntry;
  if (entry.schemaVersion !== 1 || !['active', 'inactive'].includes(entry.status) ||
      ![entry.canonicalName, entry.roomName, entry.roomId, entry.hostUserId].every(v => typeof v === 'string' && v.length > 0) ||
      !Number.isFinite(entry.createdAt) || (entry.endedAt !== undefined && !Number.isFinite(entry.endedAt)) ||
      !Array.isArray(entry.banUserIds) || !entry.banUserIds.every(v => typeof v === 'string' && v.length > 0) ||
      normalizeRoomName(entry.roomName).canonicalName !== entry.canonicalName) {
    throw new Error('房间登记格式不兼容，请联系房主重新创建');
  }
  return { ...entry, banUserIds: [...new Set(entry.banUserIds)] };
}

function parseSnapshot(nameKey: string, data: DirectoryMetadataResult): Promise<NameDirectorySnapshot> {
  return (async () => {
    if (!Number.isSafeInteger(data.majorRevision) || data.majorRevision < 0) throw new Error('房间登记版本无效');
    if (Object.keys(data.metadata).length === 0) return { majorRevision: data.majorRevision };
    if (!data.metadata.entry) throw new Error('房间登记信息不完整');
    const entry = parseNameDirectoryEntry(JSON.parse(data.metadata.entry.value));
    if ((await resolveRoomName(entry.roomName)).nameKey !== nameKey) throw new Error('房间名称与登记信息不匹配');
    return { majorRevision: data.majorRevision, entry };
  })();
}

/** Demo-only name directory used only by API reads and writes before room admission. */
export class NameDirectory {
  private closed = false;

  constructor(readonly transport: DirectoryTransport, private readonly timeoutMs = 12000) {}
  get isClosed(): boolean { return this.closed; }

  async read(): Promise<NameDirectorySnapshot> {
    if (this.closed) throw new Error('操作已取消');
    const result = await this.withTimeout(this.transport.readDirectory());
    return parseSnapshot(this.transport.nameKey, result);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('暂时无法确认房间状态，请检查网络后重试')), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
