import type { CachedJumpServerAsset } from '../config/schema';
import type { JumpServerAccountRef, JumpServerEndpoint, JumpServerSettingsWithPassword } from './types';

export const DEFAULT_CONNECT_OPTIONS = {
  charset: 'default',
  disableautohash: false,
  token_reusable: false,
  resolution: 'auto',
  backspaceAsCtrlH: false,
  appletConnectMethod: 'web',
  virtualappConnectMethod: 'web',
  reusable: false,
  rdp_connection_speed: 'auto'
} as const;

export function buildOrigin(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return `${parsed.protocol}//${parsed.host}`;
}

export function buildKokoConnectUrl(baseUrl: string, tokenId: string, timestamp = Date.now()): string {
  const origin = buildOrigin(baseUrl);
  return `${origin}/koko/connect/?disableautohash=false&token=${encodeURIComponent(tokenId)}&_=${timestamp}`;
}

export function buildKokoWsUrl(
  baseUrl: string,
  endpoint: JumpServerEndpoint,
  tokenId: string,
  timestamp = Date.now()
): string {
  const parsed = new URL(baseUrl);
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  const host = endpoint.host || parsed.hostname;
  const port = parsed.protocol === 'https:' ? endpoint.https_port : endpoint.http_port;
  const authority = port && !((scheme === 'wss' && port === 443) || (scheme === 'ws' && port === 80))
    ? `${host}:${port}`
    : host;
  return `${scheme}://${authority}/koko/ws/terminal/?disableautohash=false&token=${encodeURIComponent(tokenId)}&_=${timestamp}`;
}

export function parseCsrfMiddlewareToken(html: string): string {
  const match = html.match(/name="csrfmiddlewaretoken"[^>]*value="([^"]+)"/i);
  if (!match) {
    throw new Error('Unable to find csrfmiddlewaretoken in JumpServer login page.');
  }
  return match[1];
}

export function normalizeJumpServerAsset(item: Record<string, any>): CachedJumpServerAsset {
  const platform = item.platform;
  const category = item.category;
  const type = item.type;
  const nodes = Array.isArray(item.nodes) ? item.nodes : [];
  const zone = item.zone;
  const nodePath = nodes
    .filter((node: unknown): node is { name: string } => Boolean(node && typeof node === 'object' && 'name' in node))
    .map((node) => String(node.name));
  const zoneName = typeof zone === 'object' && zone ? String(zone.name || '') : String(zone || '');

  return {
    id: String(item.id || ''),
    name: String(item.name || item.address || item.id || ''),
    address: String(item.address || ''),
    platform: typeof platform === 'object' && platform ? String(platform.name || '') : String(platform || ''),
    category: typeof category === 'object' && category ? String(category.value || '') : String(category || ''),
    type: typeof type === 'object' && type ? String(type.value || '') : String(type || ''),
    zoneName: zoneName || nodePath.at(-1) || '',
    nodePath,
    protocolNames: extractProtocolNames(item),
    raw: item
  };
}

export function extractProtocolNames(item: Record<string, any>): string[] {
  const rawProtocols = Array.isArray(item.permed_protocols)
    ? item.permed_protocols
    : Array.isArray(item.protocols)
      ? item.protocols
      : [];
  return rawProtocols
    .map((protocol: any) => String(protocol?.name || ''))
    .filter((name: string) => name.length > 0);
}

export function resolveFirstUsableAccount(detail: Record<string, any>): JumpServerAccountRef {
  const accounts = Array.isArray(detail.permed_accounts)
    ? detail.permed_accounts
    : Array.isArray(detail.accounts)
      ? detail.accounts
      : [];
  for (const account of accounts) {
    const id = account?.id ? String(account.id) : '';
    const username = account?.username || account?.name || account?.alias || '';
    if (id && username) {
      return { id, username: String(username) };
    }
  }
  throw new Error('No usable JumpServer account was returned for this asset.');
}

export function buildConnectionTokenPayload(input: {
  assetId: string;
  account: JumpServerAccountRef;
  protocol: 'ssh';
}): Record<string, unknown> {
  return {
    asset: input.assetId,
    account: input.account.id,
    protocol: input.protocol,
    input_username: input.account.username,
    input_secret: '',
    connect_method: 'web_cli',
    connect_options: DEFAULT_CONNECT_OPTIONS
  };
}

export class JumpServerClient {
  constructor(private readonly settings: JumpServerSettingsWithPassword) {}
}
