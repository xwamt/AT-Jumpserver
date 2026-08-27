import { JumpServerClient } from './JumpServerClient';
import type { JumpServerSettingsWithPassword } from './types';
import { log } from '../utils/logger';

interface CachedClient {
  client: JumpServerClient;
  identity: string;
}

/**
 * One live client per bastion. The Bearer token and KoKo cookie jar live on
 * the client instance, so constructing a new one for every connect repeated
 * the full login. Org is not part of the identity: `setOrgId` is enough.
 */
export class JumpServerClientPool {
  private readonly entries = new Map<string, CachedClient>();

  constructor(
    private readonly factory: (settings: JumpServerSettingsWithPassword) => JumpServerClient = (settings) =>
      new JumpServerClient(settings)
  ) {}

  acquire(bastionId: string, settings: JumpServerSettingsWithPassword): JumpServerClient {
    const identity = clientCacheIdentity(settings);
    const cached = this.entries.get(bastionId);
    if (cached && cached.identity === identity) {
      cached.client.setOrgId(settings.orgId);
      log.info(`JumpServer client reused for bastion ${bastionId}`);
      return cached.client;
    }
    // A replaced client would otherwise keep its keep-alive sockets open.
    disposeClient(cached?.client);
    const client = this.factory(settings);
    this.entries.set(bastionId, { client, identity });
    log.info(`JumpServer client created for bastion ${bastionId}`);
    return client;
  }

  drop(bastionId: string): void {
    disposeClient(this.entries.get(bastionId)?.client);
    this.entries.delete(bastionId);
  }

  dropAll(): void {
    for (const cached of this.entries.values()) {
      disposeClient(cached.client);
    }
    this.entries.clear();
  }
}

function disposeClient(client: JumpServerClient | undefined): void {
  // Guarded so test doubles without dispose() keep working.
  if (client && typeof (client as { dispose?: unknown }).dispose === 'function') {
    client.dispose();
  }
}

function clientCacheIdentity(settings: JumpServerSettingsWithPassword): string {
  return [settings.baseUrl, settings.username, settings.password, settings.verifyTls ? '1' : '0'].join('\0');
}
