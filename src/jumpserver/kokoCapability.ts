import type { JumpServerClient } from './JumpServerClient';
import { JumpServerApiError } from './apiError';
import { log } from '../utils/logger';

export interface KokoCapabilities {
  cookieLess: boolean;
}

export interface KokoCapabilityClient {
  getClientVersions(): Promise<string[]>;
  getBaseUrl?(): string;
}

const capabilityCache = new Map<string, KokoCapabilities>();
const capabilityInflight = new Map<string, Promise<KokoCapabilities>>();

export function clearKokoCapabilityCache(bastionKey?: string): void {
  if (bastionKey) {
    capabilityCache.delete(bastionKey);
    capabilityInflight.delete(bastionKey);
  } else {
    capabilityCache.clear();
    capabilityInflight.clear();
  }
}

export function isKokoCookieLess(bastionKey?: string): boolean | undefined {
  if (!bastionKey) {
    return undefined;
  }
  return capabilityCache.get(bastionKey)?.cookieLess;
}

export async function detectKokoCapabilities(
  client: KokoCapabilityClient,
  bastionKey?: string
): Promise<KokoCapabilities> {
  const cacheKey = bastionKey || (typeof client.getBaseUrl === 'function' ? client.getBaseUrl() : undefined);
  if (cacheKey && capabilityCache.has(cacheKey)) {
    return capabilityCache.get(cacheKey)!;
  }

  if (cacheKey && capabilityInflight.has(cacheKey)) {
    return capabilityInflight.get(cacheKey)!;
  }

  const promise = (async (): Promise<KokoCapabilities> => {
    try {
      const versions = await client.getClientVersions();
      const cookieLess = versions.includes('5.0.0') || versions.some((v) => v.startsWith('5.'));
      const result: KokoCapabilities = { cookieLess };
      if (cacheKey) {
        capabilityCache.set(cacheKey, result);
      }
      log.info(`KoKo capability detected: cookieLess=${cookieLess}`);
      return result;
    } catch (error: any) {
      const statusCode = error instanceof JumpServerApiError ? error.statusCode : error?.statusCode;
      if (statusCode === 404) {
        // Explicit 404 => older JumpServer (e.g. v3.x) where client/versions does not exist
        const result: KokoCapabilities = { cookieLess: false };
        if (cacheKey) {
          capabilityCache.set(cacheKey, result);
        }
        log.info('KoKo capability: client/versions 404, falling back to legacy cookie authentication');
        return result;
      }

      // Timeout, 5xx, network error, or auth failure: do not cache so next attempt can retry
      log.warn(`KoKo capability probe failed (${error?.message ?? String(error)}); fallback to cookie without caching`);
      return { cookieLess: false };
    }
  })().finally(() => {
    if (cacheKey) {
      capabilityInflight.delete(cacheKey);
    }
  });

  if (cacheKey) {
    capabilityInflight.set(cacheKey, promise);
  }

  return promise;
}
