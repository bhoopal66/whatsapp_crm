import { describe, expect, it } from 'vitest';

import {
  CONSENT_TEXT_VERSION,
  GROUP_NAME_MAX,
  INVITEE_MAX,
  allowedGuestBanks,
  canAddInvitee,
  createRoomBody,
  dealOptionLabel,
  defaultGroupName,
  groupNameOk,
  inviteeIssues,
  phoneDigits,
  placesTaken,
  type Invitee,
} from './create-form';

const customer: Invitee = {
  displayName: 'Omar',
  phone: '+971 50 123 4567',
  role: 'customer',
};
const person = (i: number, extra: Partial<Invitee> = {}): Invitee => ({
  displayName: `Person ${i}`,
  phone: `97150000000${i}`,
  role: 'partner',
  ...extra,
});
const banks = new Set(['MASHREQ']);

describe('inviteeIssues', () => {
  it('accepts a customer and up to 7 people', () => {
    expect(inviteeIssues([customer], banks)).toEqual([]);
    const seven = [customer, ...[1, 2, 3, 4, 5, 6].map((i) => person(i))];
    expect(seven).toHaveLength(INVITEE_MAX);
    expect(inviteeIssues(seven, banks)).toEqual([]);
  });

  it('refuses an 8th invitee: WhatsApp allows 8 with our number', () => {
    const eight = [customer, ...[1, 2, 3, 4, 5, 6, 7].map((i) => person(i))];
    expect(inviteeIssues(eight, banks)).toContainEqual({
      kind: 'too_many',
      max: 7,
    });
  });

  it('refuses an empty list and a list without the customer', () => {
    expect(inviteeIssues([], banks)).toEqual([{ kind: 'none' }]);
    expect(inviteeIssues([person(1)], banks)).toEqual([
      { kind: 'no_customer' },
    ]);
  });

  it('names a phone listed twice, however it is written', () => {
    const twice = { ...person(1), phone: '971501234567' };
    expect(inviteeIssues([customer, twice], banks)).toEqual([
      { kind: 'duplicate', name: 'Person 1' },
    ]);
  });

  it('needs a name and a 6–15 digit phone', () => {
    expect(
      inviteeIssues(
        [
          customer,
          person(1, { displayName: '  ' }),
          person(2, { phone: '12' }),
        ],
        banks
      )
    ).toEqual([
      { kind: 'name', name: '' },
      { kind: 'phone', name: 'Person 2' },
    ]);
  });

  it('lets a bank guest in only from a bank whose policy allows guests', () => {
    const ok = person(1, { role: 'bank_guest', bankCode: 'mashreq' });
    const off = person(2, { role: 'bank_guest', bankCode: 'ADCB' });
    const none = person(3, { role: 'bank_guest' });
    expect(inviteeIssues([customer, ok, off, none], banks)).toEqual([
      { kind: 'bank', name: 'Person 2' },
      { kind: 'bank', name: 'Person 3' },
    ]);
  });
});

describe('the small rules', () => {
  it('reads Arabic-Indic digits', () => {
    expect(phoneDigits('+٩٧١ ٥٠ 123')).toBe('97150123');
  });

  it('adds while there is room for one more', () => {
    expect(canAddInvitee(6)).toBe(true);
    expect(canAddInvitee(7)).toBe(false);
  });

  it('counts our own number among the places', () => {
    expect(placesTaken(3)).toBe(4);
  });

  it('keeps only banks whose guests are allowed', () => {
    expect(
      allowedGuestBanks([
        { bank_code: 'ADCB', guests_allowed: false },
        { bank_code: 'MASHREQ', guests_allowed: true },
      ])
    ).toEqual(new Set(['MASHREQ']));
  });
});

describe('defaultGroupName', () => {
  it('is "<customer> × <workspace> — <deal>"', () => {
    expect(
      defaultGroupName({
        customer: 'Omar',
        workspace: 'Acme',
        deal: 'Home loan',
      })
    ).toBe('Omar × Acme — Home loan');
    expect(defaultGroupName({ customer: 'Omar', workspace: 'Acme' })).toBe(
      'Omar × Acme'
    );
  });

  it('stays within 128 characters without splitting an emoji', () => {
    const name = defaultGroupName({
      customer: '😀'.repeat(200),
      workspace: 'Acme',
    });
    expect(Array.from(name)).toHaveLength(GROUP_NAME_MAX);
    expect(groupNameOk(name)).toBe(true);
    expect(groupNameOk(`${name}x`)).toBe(false);
    expect(groupNameOk('   ')).toBe(false);
  });
});

describe('dealOptionLabel', () => {
  it('prefers the company, then the contact name', () => {
    expect(
      dealOptionLabel({
        contactName: 'Omar',
        company: 'Omar Trading',
        dealTitle: 'Home loan',
      })
    ).toBe('Omar Trading · Home loan');
    expect(
      dealOptionLabel({ contactName: 'Omar', company: ' ', dealTitle: null })
    ).toBe('Omar');
  });
});

describe('createRoomBody', () => {
  it('sends digits, upper-case bank codes only for guests, and the consent', () => {
    const body = createRoomBody({
      contactId: 'c1',
      dealId: null,
      subject: '  Omar × Acme ',
      invitees: [
        { ...customer, bankCode: 'x' },
        person(1, { role: 'bank_guest', bankCode: 'mashreq' }),
      ],
      consentText: 'The customer agreed.',
      method: 'verbal',
    });
    expect(body.subject).toBe('Omar × Acme');
    expect(body.participants).toEqual([
      {
        displayName: 'Omar',
        phone: '971501234567',
        role: 'customer',
        contactId: null,
        bankCode: null,
      },
      {
        displayName: 'Person 1',
        phone: '971500000001',
        role: 'bank_guest',
        contactId: null,
        bankCode: 'MASHREQ',
      },
    ]);
    expect(body.consent).toEqual({
      textVersion: CONSENT_TEXT_VERSION,
      consentText: 'The customer agreed.',
      method: 'verbal',
    });
  });
});
