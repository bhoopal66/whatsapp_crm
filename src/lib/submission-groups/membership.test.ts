import { describe, expect, it, vi } from 'vitest';

vi.mock('./server', () => ({
  submissionGroupStore: vi.fn(),
  submissionGroupService: vi.fn(),
}));

import type { SupabaseClient } from '@supabase/supabase-js';

import { mergeGroupList } from '@/lib/groups/merge-list';
import { parseWhapiParticipants } from '@/lib/whatsapp/whapi-api';
import type { WhapiGroupEvent } from '@/lib/whatsapp/whapi-group-events';

import {
  MEMBERSHIP_BUDGET_MS,
  MEMBERSHIP_CHECKS_PER_RUN,
  runSubmissionGroupsCron,
} from './cron';
import { recordSubmissionGroupMembership } from './inbound';
import { customerMembershipFrom, noteCreatedMembership } from './membership';
import { SubmissionGroupStore, type SubmissionGroup } from './store';
import { customerNotInGroup } from './ui';

const PHONE = '971501234567';
const OTHER = '971509999999';

describe('customerMembershipFrom', () => {
  it('finds the customer among real numbers, whatever else is listed', () => {
    expect(customerMembershipFrom([OTHER, PHONE], [PHONE])).toBe('joined');
    expect(customerMembershipFrom(['1@lid', PHONE], [PHONE])).toBe('joined');
    expect(customerMembershipFrom([`${PHONE}@s.whatsapp.net`], [PHONE])).toBe(
      'joined'
    );
  });

  it('reads a list of real numbers without the customer as absent', () => {
    expect(customerMembershipFrom([OTHER], [PHONE])).toBe('absent');
  });

  it('reads a hidden number as unsure, never absent', () => {
    expect(customerMembershipFrom([OTHER, '123456@lid'], [PHONE])).toBe(
      'unsure'
    );
  });

  it('keeps a hidden id hidden all the way from the Whapi list', () => {
    const read = (id: unknown) =>
      customerMembershipFrom(
        parseWhapiParticipants([{ id: OTHER }, { id }]).map(
          (p) => p.waId ?? p.jid
        ),
        [PHONE]
      );
    expect(read('1234567890123@lid')).toBe('unsure');
    expect(read({ id: '1234567890123@lid' })).toBe('unsure');
    expect(read({ id: '1234567890123@lid', phone: '1234567890123' })).toBe(
      'unsure'
    );
    expect(read('12345678901234567')).toBe('unsure');
    expect(read({ id: '1234567890123@lid', phone: PHONE })).toBe('joined');
    expect(read(`${OTHER}0@s.whatsapp.net`)).toBe('absent');
    expect(read({ id: `${PHONE}@s.whatsapp.net`, phone: PHONE })).toBe(
      'joined'
    );
  });

  it('says nothing from an empty list or without a phone', () => {
    expect(customerMembershipFrom([], [PHONE])).toBe('unknown');
    expect(customerMembershipFrom([OTHER], [null])).toBe('unknown');
  });
});

describe('noteCreatedMembership', () => {
  const noted = async (refused: string[], phone = `+${PHONE}`) => {
    const noteCustomerMembership = vi.fn().mockResolvedValue(true);
    await noteCreatedMembership(
      { noteCustomerMembership },
      'g1',
      phone,
      refused
    );
    return noteCustomerMembership.mock.calls[0]?.[1];
  };

  it('records absent for a refusal, unsure for a hidden one', async () => {
    expect(await noted([`${PHONE}@s.whatsapp.net`])).toBe('absent');
    expect(await noted(['123456@lid'])).toBe('unsure');
  });

  it('infers nothing from no refusal, leaving the group due at once', async () => {
    expect(await noted([OTHER])).toBeUndefined();
    expect(await noted([])).toBeUndefined();
  });

  it('records absent for a refused 00 or trunk-0 number on file', async () => {
    expect(await noted([PHONE], `00${PHONE}`)).toBe('absent');
    expect(await noted([PHONE], '9710501234567')).toBe('absent');
  });

  it('never throws', async () => {
    const noteCustomerMembership = vi.fn().mockRejectedValue(new Error('db'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      noteCreatedMembership({ noteCustomerMembership }, 'g1', PHONE, [])
    ).resolves.toBeUndefined();
    log.mockRestore();
  });
});

describe('recordSubmissionGroupMembership', () => {
  const channel = { id: 'c1', accountId: 'a1' };
  const event = (
    action: 'add' | 'remove' | 'promote',
    waIds: string[],
    unresolved = 0
  ): WhapiGroupEvent => ({
    kind: 'participants',
    groupId: 'wa1@g.us',
    action,
    waIds,
    unresolved,
    performedBy: null,
  });
  const fake = () => ({
    findByWaGroupId: vi
      .fn()
      .mockResolvedValue({ id: 'g1', contactId: 'k1' } as SubmissionGroup),
    contactConsent: vi.fn().mockResolvedValue({ allowed: true, phone: PHONE }),
    noteCustomerMembership: vi.fn().mockResolvedValue(true),
  });

  it('add of the customer is joined; remove is absent', async () => {
    const store = fake();
    await recordSubmissionGroupMembership(store, channel, [
      event('add', [PHONE]),
      event('remove', [PHONE]),
    ]);
    expect(store.noteCustomerMembership.mock.calls).toEqual([
      ['g1', 'joined'],
      ['g1', 'absent'],
    ]);
  });

  it('ignores a hidden id, someone else and other actions', async () => {
    const store = fake();
    await recordSubmissionGroupMembership(store, channel, [
      event('remove', [], 1),
      event('remove', ['123456@lid']),
      event('remove', [OTHER]),
      event('promote', [PHONE]),
    ]);
    expect(store.noteCustomerMembership).not.toHaveBeenCalled();
  });

  it('add of a hidden number with no match is unsure', async () => {
    const store = fake();
    await recordSubmissionGroupMembership(store, channel, [
      event('add', [], 1),
      event('add', [OTHER], 1),
      event('add', ['123456@lid']),
    ]);
    expect(store.noteCustomerMembership.mock.calls).toEqual([
      ['g1', 'unsure'],
      ['g1', 'unsure'],
      ['g1', 'unsure'],
    ]);
  });

  it('add of the customer beside a hidden number is joined', async () => {
    const store = fake();
    await recordSubmissionGroupMembership(store, channel, [
      event('add', [PHONE], 1),
    ]);
    expect(store.noteCustomerMembership.mock.calls).toEqual([['g1', 'joined']]);
  });

  it('add of someone else, or of a hidden number with no phone on file, changes nothing', async () => {
    const store = fake();
    await recordSubmissionGroupMembership(store, channel, [
      event('add', [OTHER]),
    ]);
    store.contactConsent.mockResolvedValue({ allowed: true, phone: null });
    await recordSubmissionGroupMembership(store, channel, [
      event('add', [], 1),
    ]);
    expect(store.noteCustomerMembership).not.toHaveBeenCalled();
  });

  it('counts a failure and carries on, never throwing', async () => {
    const store = fake();
    store.findByWaGroupId.mockRejectedValueOnce(new Error('db down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      recordSubmissionGroupMembership(store, channel, [
        event('add', [PHONE]),
        event('add', [PHONE]),
      ])
    ).resolves.toBe(1);
    expect(store.noteCustomerMembership).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

describe('the cron membership pass', () => {
  const group = (id: string) =>
    ({
      id,
      accountId: 'a1',
      contactId: 'k1',
      // A group named like 'x:g0' sits on channel 'x'.
      channelId: id.includes(':') ? id.split(':')[0] : 'c1',
      waGroupId: `${id}@g.us`,
    }) as SubmissionGroup;
  const run = (
    ids: string[],
    getParticipants: ReturnType<typeof vi.fn>,
    o: {
      accounts?: string[];
      idsOf?: (accountId: string) => string[];
      now?: () => number;
    } = {}
  ) => {
    const store = {
      listPendingCreates: vi.fn().mockResolvedValue([]),
      listUnclosedEnded: vi.fn().mockResolvedValue([]),
      failStalePending: vi.fn().mockResolvedValue([]),
      membershipAccounts: vi.fn().mockResolvedValue(o.accounts ?? ['a1']),
      membershipDue: vi.fn(async (accountId: string, limit: number) =>
        (o.idsOf?.(accountId) ?? ids).slice(0, limit)
      ),
      get: vi.fn(async (id: string) => group(id)),
      contactConsent: vi
        .fn()
        .mockResolvedValue({ allowed: true, phone: PHONE }),
      noteCustomerMembership: vi.fn().mockResolvedValue(true),
    };
    const result = runSubmissionGroupsCron({} as SupabaseClient, {
      store,
      serviceFor: () => ({
        retryPending: vi.fn(),
        retryClose: vi.fn(),
        sendWelcomeIfDue: vi.fn(),
      }),
      participantsFor: () => ({ getParticipants: getParticipants as never }),
      now: o.now,
    });
    return { store, result };
  };

  it('reaches an account with no retry work, and caps the run', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `g${i}`);
    const read = vi.fn().mockResolvedValue([OTHER]);
    const { store, result } = run(ids, read);
    const r = await result;
    expect(MEMBERSHIP_CHECKS_PER_RUN).toBe(10);
    expect(store.membershipDue).toHaveBeenCalledWith('a1', 10);
    expect(read).toHaveBeenCalledTimes(10);
    expect(r.membershipChecked).toBe(10);
    expect(store.noteCustomerMembership).toHaveBeenCalledWith('g0', 'absent');
  });

  it('a gateway failure stamps the group and skips its number for the run', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce([PHONE])
      .mockRejectedValueOnce(new Error('gateway 503'));
    const { store, result } = run(['g0', 'g1', 'g2'], read);
    const r = await result;
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.noteCustomerMembership.mock.calls).toEqual([
      ['g0', 'joined'],
      ['g1', 'unknown'],
    ]);
    expect(r.membershipChecked).toBe(2);
    expect(r.errors).toEqual(['a1: membership: gateway 503']);
  });

  it('a failing number does not stop another number or account', async () => {
    const read = vi.fn(async (channelId: string) => {
      if (channelId === 'bad') throw new Error('gateway 503');
      return [PHONE];
    });
    const { store, result } = run([], read, {
      accounts: ['a1', 'a2'],
      idsOf: (accountId) =>
        accountId === 'a1'
          ? ['bad:g0', 'bad:g1', 'good:g2', 'bad:g3', 'good:g4']
          : ['other:g5'],
    });
    await result;
    expect(read.mock.calls.map((c) => c[0])).toEqual([
      'bad',
      'good',
      'good',
      'other',
    ]);
    expect(store.noteCustomerMembership.mock.calls).toEqual([
      ['bad:g0', 'unknown'],
      ['good:g2', 'joined'],
      ['good:g4', 'joined'],
      ['other:g5', 'joined'],
    ]);
  });

  it('starts no read once the budget is used, across accounts', async () => {
    let clock = 0;
    const read = vi.fn(async () => {
      clock += MEMBERSHIP_BUDGET_MS / 2;
      return [PHONE];
    });
    const { store, result } = run(['g0', 'g1', 'g2', 'g3'], read, {
      accounts: ['a1', 'a2'],
      now: () => clock,
    });
    const r = await result;
    expect(MEMBERSHIP_BUDGET_MS).toBe(15_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(r.membershipChecked).toBe(2);
    expect(store.membershipDue).toHaveBeenCalledTimes(1);
  });

  it("runs every account's retries before any membership read", async () => {
    const order: string[] = [];
    const read = vi.fn(async () => {
      order.push('read');
      return [PHONE];
    });
    const { store } = run(['g0'], read);
    const result = runSubmissionGroupsCron({} as SupabaseClient, {
      store: {
        ...store,
        listPendingCreates: vi
          .fn()
          .mockResolvedValue([{ id: 'p', accountId: 'a1' }]),
        listUnclosedEnded: vi
          .fn()
          .mockResolvedValue([{ id: 'e', accountId: 'a2' }]),
        membershipAccounts: vi.fn().mockResolvedValue(['a1', 'a2']),
      },
      serviceFor: (accountId) => ({
        retryPending: vi.fn(async () => {
          order.push(`create ${accountId}`);
          return { attempted: 0, created: [], consentRequired: [], failed: [] };
        }),
        retryClose: vi.fn(async () => {
          order.push(`close ${accountId}`);
          return { closed: true } as never;
        }),
        sendWelcomeIfDue: vi.fn(),
      }),
      participantsFor: () => ({ getParticipants: read as never }),
    });
    await result;
    expect(order.slice(0, 2)).toEqual(['create a1', 'close a2']);
    expect(order.slice(2).every((step) => step === 'read')).toBe(true);
    expect(read).toHaveBeenCalled();
  });

  it('stamps a gone group so it cannot block the queue', async () => {
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValue([PHONE]);
    const { store, result } = run(['g0', 'g1'], read);
    await result;
    expect(store.noteCustomerMembership.mock.calls).toEqual([
      ['g0', 'unknown'],
      ['g1', 'joined'],
    ]);
  });
});

describe('the "Customer not in group" chip', () => {
  const live = { status: 'ACTIVE', wa_mode: 'group' } as const;

  it('shows only for absent on a live WhatsApp group', () => {
    expect(customerNotInGroup({ ...live, customer_membership: 'absent' })).toBe(
      true
    );
    for (const customer_membership of ['unknown', 'joined', undefined] as const)
      expect(customerNotInGroup({ ...live, customer_membership })).toBe(false);
    expect(
      customerNotInGroup({
        status: 'ENDED',
        wa_mode: 'group',
        customer_membership: 'absent',
      })
    ).toBe(false);
    expect(
      customerNotInGroup({
        status: 'ACTIVE',
        wa_mode: 'none',
        customer_membership: 'absent',
      })
    ).toBe(false);
  });

  it('reaches a /groups row only when absent', () => {
    const row = (customer_membership: 'absent' | 'unknown') => ({
      id: 's1',
      channel_id: null,
      subject: 'S',
      customer_name: null,
      submission_ref: 'R',
      wa_group_id: 'w@g.us',
      last_activity_at: null,
      customer_membership,
    });
    const list = (m: 'absent' | 'unknown') =>
      mergeGroupList({
        groups: [],
        submissionRows: [row(m)],
        mirrorWaIds: new Set(),
        unread: new Map(),
        canManage: new Set(),
        channelOf: new Map(),
      })[0].customer_absent;
    expect(list('absent')).toBe(true);
    expect(list('unknown')).toBe(false);
  });
});

describe('the store calls migration 174 by its contract', () => {
  it('leaves detached groups out of the account window', async () => {
    const q = {
      select: vi.fn(() => q),
      eq: vi.fn(() => q),
      not: vi.fn(() => q),
      neq: vi.fn(() => q),
      order: vi.fn(() => q),
      limit: vi.fn(async () => ({
        data: [{ account_id: 'a1' }, { account_id: 'a1' }],
        error: null,
      })),
    };
    const store = new SubmissionGroupStore({
      from: () => q,
    } as unknown as SupabaseClient);
    expect(await store.membershipAccounts()).toEqual(['a1']);
    expect(q.not).toHaveBeenCalledWith('channel_id', 'is', null);
  });

  it('passes p_group/p_state and p_account/p_limit', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: ['g1'], error: null });
    const store = new SubmissionGroupStore({
      rpc,
    } as unknown as SupabaseClient);
    expect(await store.noteCustomerMembership('g1', 'absent')).toBe(true);
    expect(await store.membershipDue('a1', 10)).toEqual(['g1']);
    expect(rpc.mock.calls).toEqual([
      ['sg_note_customer_membership', { p_group: 'g1', p_state: 'absent' }],
      ['sg_membership_due', { p_account: 'a1', p_limit: 10 }],
    ]);
  });
});
