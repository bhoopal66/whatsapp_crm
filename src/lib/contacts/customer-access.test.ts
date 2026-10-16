import { describe, expect, it } from 'vitest';

import { ACCOUNT_ROLES } from '@/lib/auth/roles';

import { customerAccess } from './customer-access';

describe('customerAccess', () => {
  it('offers nothing while the role is unknown', () => {
    for (const role of [null, undefined]) {
      expect(Object.values(customerAccess(role)).some(Boolean)).toBe(false);
    }
  });

  it('keeps a bank guest and a viewer read-only', () => {
    for (const role of ['bank_guest', 'viewer'] as const) {
      expect(Object.values(customerAccess(role)).some(Boolean)).toBe(false);
    }
  });

  it('lets an agent and a team leader work the customer, not delete it', () => {
    for (const role of ['agent', 'team_leader'] as const) {
      expect(customerAccess(role)).toEqual({
        edit: true,
        addNote: true,
        send: true,
        call: true,
        setDoNotContact: true,
        manageConsent: false,
        deleteContact: false,
      });
    }
  });

  it('gives admins and owners consent changes and delete', () => {
    for (const role of ['admin', 'owner'] as const) {
      const a = customerAccess(role);
      expect(a.manageConsent).toBe(true);
      expect(a.deleteContact).toBe(true);
      expect(a.edit && a.addNote && a.send && a.call).toBe(true);
    }
  });

  it('covers every role on the ladder', () => {
    const editors = ACCOUNT_ROLES.filter((r) => customerAccess(r).edit);
    expect([...editors].sort()).toEqual(
      ['admin', 'agent', 'owner', 'team_leader'].sort()
    );
  });
});
