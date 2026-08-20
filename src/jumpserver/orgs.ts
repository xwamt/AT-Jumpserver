export const GLOBAL_ORG_ID = '00000000-0000-0000-0000-000000000000';
export const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000002';
export const RESERVED_INTERNAL_ORG_ID = '00000000-0000-0000-0000-000000000004';

export interface JumpServerOrg {
  id: string;
  name: string;
  source?: 'api' | 'env' | 'reserved_auto_select';
}

export function isReservedAutoSelectSet(ids: Iterable<string>): boolean {
  const set = new Set([...ids].filter(Boolean));
  if (set.size === 1 && set.has(DEFAULT_ORG_ID)) {
    return true;
  }
  return set.size === 2 && set.has(DEFAULT_ORG_ID) && set.has(RESERVED_INTERNAL_ORG_ID);
}
