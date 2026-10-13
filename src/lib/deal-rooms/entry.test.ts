import { describe, expect, it } from 'vitest';

import {
  dealRoomEntry,
  hasMetaNumber,
  prefillFromDeal,
  roomScopeFilter,
  roomScopeQuery,
} from './entry';

const STAFF_WHO_CREATE = ['owner', 'admin', 'team_leader', 'agent'] as const;
const NONE = { load: false, show: false, create: false };

describe('hasMetaNumber', () => {
  it('is null until the numbers load, then whether one is a Meta number', () => {
    expect(hasMetaNumber(null)).toBeNull();
    expect(hasMetaNumber([])).toBe(false);
    expect(hasMetaNumber([{ provider: 'whapi' }])).toBe(false);
    expect(hasMetaNumber([{ provider: 'whapi' }, { provider: 'meta' }])).toBe(
      true
    );
  });
});

describe('dealRoomEntry', () => {
  it('offers agents and up the block and New, rooms or not', () => {
    for (const accountRole of STAFF_WHO_CREATE) {
      for (const rooms of [null, 0, 2]) {
        expect(dealRoomEntry({ accountRole, metaNumber: true, rooms })).toEqual(
          { load: true, show: true, create: true }
        );
      }
    }
  });

  it('shows a viewer only the rooms RLS hands them, never New', () => {
    const viewer = (rooms: number | null) =>
      dealRoomEntry({ accountRole: 'viewer', metaNumber: true, rooms });
    expect(viewer(1)).toEqual({ load: true, show: true, create: false });
    expect(viewer(0)).toEqual({ load: true, show: false, create: false });
    expect(viewer(null)).toEqual({ load: true, show: false, create: false });
  });

  it('never shows a bank guest anything, nor asks for their rooms', () => {
    for (const rooms of [null, 0, 3]) {
      expect(
        dealRoomEntry({ accountRole: 'bank_guest', metaNumber: true, rooms })
      ).toEqual(NONE);
    }
  });

  it('shows nothing without a Meta number, or before the numbers load', () => {
    for (const metaNumber of [false, null]) {
      for (const accountRole of [...STAFF_WHO_CREATE, 'viewer']) {
        expect(dealRoomEntry({ accountRole, metaNumber, rooms: 4 })).toEqual(
          NONE
        );
      }
    }
  });

  it('shows nothing for a role it does not know', () => {
    for (const accountRole of [null, '', 'superuser']) {
      expect(
        dealRoomEntry({ accountRole, metaNumber: true, rooms: 1 })
      ).toEqual(NONE);
    }
  });
});

describe('room scopes', () => {
  it('asks the list route for one contact or one deal', () => {
    expect(roomScopeQuery({ contactId: 'c-1' })).toBe('contactId=c-1');
    expect(roomScopeQuery({ dealId: 'd 1' })).toBe('dealId=d%201');
  });

  it('listens to the same rooms on the realtime signal', () => {
    expect(roomScopeFilter({ contactId: 'c-1' })).toBe('contact_id=eq.c-1');
    expect(roomScopeFilter({ dealId: 'd-1' })).toBe('deal_id=eq.d-1');
  });
});

describe('prefillFromDeal', () => {
  it("prefills the deal's contact and the deal", () => {
    expect(
      prefillFromDeal({
        id: 'deal-1',
        title: 'Home loan',
        contact_id: 'contact-1',
        contact: { name: 'Aisha', phone: '+971500000001', company: null },
      })
    ).toEqual({
      contact: {
        id: 'contact-1',
        name: 'Aisha',
        phone: '+971500000001',
        company: null,
      },
      deal: { id: 'deal-1', title: 'Home loan' },
    });
  });

  it('keeps the contact id when the embed did not load', () => {
    expect(
      prefillFromDeal({ id: 'd', title: null, contact_id: 'c' })?.contact
    ).toEqual({ id: 'c', name: null, phone: null, company: null });
  });

  it('has nothing to prefill once the contact is deleted', () => {
    expect(
      prefillFromDeal({ id: 'd', title: 'x', contact_id: null, contact: null })
    ).toBeNull();
  });
});
