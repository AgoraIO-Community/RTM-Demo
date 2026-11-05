import type { AppRtmSession } from '../app-rtm';
import type { DirectoryMetadataResult, DirectoryTransport } from '../name-directory';

/** Demo-only Audience admission read is intentionally excluded from the RTM timeline. */
export class AudienceNameDirectoryRtm implements DirectoryTransport {
  constructor(private readonly session: AppRtmSession, readonly nameKey: string) {}
  readDirectory(): Promise<DirectoryMetadataResult> {
    return this.session.getDirectoryPort().read(this.nameKey);
  }
}
