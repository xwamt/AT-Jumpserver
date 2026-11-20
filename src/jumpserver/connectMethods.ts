export type ConnectMethodType = 'web' | 'native' | 'applet' | 'virtual_app' | string;

export interface ConnectMethod {
  component: string;
  type: ConnectMethodType;
  endpoint_protocol?: string;
  value: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  listen?: string;
  [key: string]: unknown;
}

export function normalizeConnectMethods(payload: unknown): Record<string, ConnectMethod[]> {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const result: Record<string, ConnectMethod[]> = {};

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const method = item as ConnectMethod;
      const proto = String(method.endpoint_protocol || '').toLowerCase() || 'other';
      result[proto] ??= [];
      result[proto].push(method);
    }
    return result;
  }

  for (const [protocol, list] of Object.entries(payload as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      continue;
    }
    const cleanList = list.filter((item): item is ConnectMethod => Boolean(item && typeof item === 'object'));
    if (cleanList.length > 0) {
      result[protocol.toLowerCase()] = cleanList;
    }
  }

  return result;
}

export function selectConnectMethod(
  methods: Record<string, ConnectMethod[]> | ConnectMethod[] | null | undefined,
  options: { protocol: string; preferred?: string }
): ConnectMethod | undefined {
  if (!methods) {
    return undefined;
  }

  const targetProto = options.protocol.toLowerCase();
  const candidates: ConnectMethod[] = Array.isArray(methods)
    ? methods
    : (methods[targetProto] || []);

  if (candidates.length === 0) {
    return undefined;
  }

  // Filter out disabled ones if active ones are available
  const activeCandidates = candidates.filter((m) => !m.disabled);
  const pool = activeCandidates.length > 0 ? activeCandidates : candidates;

  if (options.preferred) {
    const matchedPreferred = pool.find((m) => m.value === options.preferred);
    if (matchedPreferred) {
      return matchedPreferred;
    }
  }

  const webMethod = pool.find((m) => m.type === 'web');
  if (webMethod) {
    return webMethod;
  }

  const nativeMethod = pool.find((m) => m.type === 'native');
  if (nativeMethod) {
    return nativeMethod;
  }

  return pool[0];
}
