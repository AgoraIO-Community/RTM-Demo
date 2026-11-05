import type { AppRtmSession } from '../app-rtm';
import type { DirectoryMetadataResult, DirectoryTransport, NameDirectoryEntry } from '../name-directory';

/** Demo-only Host directory operations are intentionally excluded from the RTM timeline. */
export class HostNameDirectoryRtm implements DirectoryTransport {
  constructor(private readonly session: AppRtmSession, readonly nameKey: string) {}
  readDirectory(): Promise<DirectoryMetadataResult> {
    return this.session.getDirectoryPort().read(this.nameKey);
  }

  registerRoom(entry: NameDirectoryEntry, majorRevision: number): Promise<unknown> {
    return this.session.getDirectoryPort().write(this.nameKey, JSON.stringify(entry), majorRevision);
  }
  endRoom(entry: NameDirectoryEntry, majorRevision: number): Promise<unknown> {
    return this.session.getDirectoryPort().write(this.nameKey, JSON.stringify(entry), majorRevision);
  }
  banMember(entry: NameDirectoryEntry, majorRevision: number): Promise<unknown> {
    return this.session.getDirectoryPort().write(this.nameKey, JSON.stringify(entry), majorRevision);
  }
  removeRoom(majorRevision: number): Promise<unknown> {
    return this.session.getDirectoryPort().remove(this.nameKey, majorRevision);
  }
}
