import {
  DEFAULT_ORG_ID,
  isReservedAutoSelectSet,
  type JumpServerOrg
} from './orgs';

export interface OrgContext {
  accessibleOrgs: JumpServerOrg[];
  candidateOrgs: JumpServerOrg[];
  effectiveOrg?: JumpServerOrg;
  selectionRequired: boolean;
  reservedAutoSelectEligible: boolean;
  selectedOrgAccessible: boolean;
}

export function resolveOrgContext(input: {
  savedOrgId: string;
  accessibleOrgs: JumpServerOrg[];
}): OrgContext {
  const accessibleOrgs = input.accessibleOrgs;
  const byId = new Map(accessibleOrgs.map((org) => [org.id, org]));
  const reservedAutoSelectEligible = isReservedAutoSelectSet(accessibleOrgs.map((org) => org.id));
  const saved = input.savedOrgId.trim();
  const selected = saved ? byId.get(saved) : undefined;
  if (selected) {
    return {
      accessibleOrgs,
      candidateOrgs: accessibleOrgs,
      effectiveOrg: { ...selected, source: 'env' },
      selectionRequired: false,
      reservedAutoSelectEligible,
      selectedOrgAccessible: true
    };
  }
  if (reservedAutoSelectEligible && !saved) {
    const auto = byId.get(DEFAULT_ORG_ID) ?? { id: DEFAULT_ORG_ID, name: 'Default' };
    return {
      accessibleOrgs,
      candidateOrgs: accessibleOrgs,
      effectiveOrg: { ...auto, source: 'reserved_auto_select' },
      selectionRequired: false,
      reservedAutoSelectEligible: true,
      selectedOrgAccessible: true
    };
  }
  return {
    accessibleOrgs,
    candidateOrgs: accessibleOrgs,
    effectiveOrg: undefined,
    selectionRequired: true,
    reservedAutoSelectEligible,
    selectedOrgAccessible: false
  };
}
