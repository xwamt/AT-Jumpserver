import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_ID, RESERVED_INTERNAL_ORG_ID, isReservedAutoSelectSet } from '../../src/jumpserver/orgs';
import { resolveOrgContext } from '../../src/jumpserver/orgContext';

const defaultOrg = { id: DEFAULT_ORG_ID, name: 'Default' };
const internal = { id: RESERVED_INTERNAL_ORG_ID, name: 'Internal' };
const prod = { id: '11111111-1111-1111-1111-111111111111', name: 'Prod' };

describe('isReservedAutoSelectSet', () => {
  it('is true for Default alone or Default plus Internal', () => {
    expect(isReservedAutoSelectSet([DEFAULT_ORG_ID])).toBe(true);
    expect(isReservedAutoSelectSet([DEFAULT_ORG_ID, RESERVED_INTERNAL_ORG_ID])).toBe(true);
  });

  it('is false for any other org set', () => {
    expect(isReservedAutoSelectSet([])).toBe(false);
    expect(isReservedAutoSelectSet([RESERVED_INTERNAL_ORG_ID])).toBe(false);
    expect(isReservedAutoSelectSet([prod.id])).toBe(false);
    expect(isReservedAutoSelectSet([DEFAULT_ORG_ID, prod.id])).toBe(false);
    expect(isReservedAutoSelectSet([DEFAULT_ORG_ID, RESERVED_INTERNAL_ORG_ID, prod.id])).toBe(false);
  });
});

describe('resolveOrgContext', () => {
  it('uses a saved org when it is still accessible', () => {
    const context = resolveOrgContext({
      savedOrgId: prod.id,
      accessibleOrgs: [defaultOrg, prod]
    });
    expect(context.selectionRequired).toBe(false);
    expect(context.effectiveOrg).toMatchObject({ id: prod.id, source: 'env' });
    expect(context.reservedAutoSelectEligible).toBe(false);
  });

  it('auto-selects Default when only reserved orgs are visible', () => {
    expect(
      resolveOrgContext({ savedOrgId: '', accessibleOrgs: [defaultOrg] }).effectiveOrg
    ).toMatchObject({ id: DEFAULT_ORG_ID, source: 'reserved_auto_select' });
    expect(
      resolveOrgContext({ savedOrgId: '', accessibleOrgs: [defaultOrg, internal] }).effectiveOrg
    ).toMatchObject({ id: DEFAULT_ORG_ID, source: 'reserved_auto_select' });
  });

  it('requires a choice when several real orgs exist and none is saved', () => {
    const context = resolveOrgContext({
      savedOrgId: '',
      accessibleOrgs: [defaultOrg, prod]
    });
    expect(context.selectionRequired).toBe(true);
    expect(context.effectiveOrg).toBeUndefined();
    expect(context.candidateOrgs).toHaveLength(2);
  });

  it('requires a new choice when the saved org disappeared', () => {
    const context = resolveOrgContext({
      savedOrgId: prod.id,
      accessibleOrgs: [defaultOrg]
    });
    expect(context.selectionRequired).toBe(true);
    expect(context.selectedOrgAccessible).toBe(false);
  });
});
