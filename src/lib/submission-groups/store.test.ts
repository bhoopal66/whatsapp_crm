import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  SubmissionGroupDbError,
  SubmissionGroupStore,
  toGroup,
} from './store';
import type { SubmissionGroup } from './store';
import { fakeSupabase, type FakeDb } from './test-db';

const failing = (code: string | undefined) =>
  new SubmissionGroupStore({
    rpc: async () => ({ data: null, error: { message: 'boom', code } }),
  } as unknown as SupabaseClient);

describe('SubmissionGroupStore RPC errors', () => {
  it('carry the SQLSTATE so routes can tell an ended group apart', async () => {
    const err = await failing('55000')
      .accessSet('g', 'u', 'agent', null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionGroupDbError);
    expect((err as SubmissionGroupDbError).code).toBe('55000');
    expect((err as Error).message).toBe('sg_access_set: boom');
  });

  it('carry null when the driver gives no code', async () => {
    const err = await failing(undefined)
      .accessRemove('g', 'u')
      .catch((e: unknown) => e);
    expect((err as SubmissionGroupDbError).code).toBeNull();
  });
});

describe('the 1:1 invite (118)', () => {
  it('noteInvite calls sg_note_invite and answers its boolean', async () => {
    const calls: [string, unknown][] = [];
    const store = new SubmissionGroupStore({
      rpc: async (fn: string, args: unknown) => {
        calls.push([fn, args]);
        return { data: false, error: null };
      },
    } as unknown as SupabaseClient);
    expect(await store.noteInvite('g1', false, 'gateway down')).toBe(false);
    expect(calls).toEqual([
      [
        'sg_note_invite',
        { p_group: 'g1', p_sent: false, p_error: 'gateway down' },
      ],
    ]);
  });

  it('toGroup reads invite_sent_at and invite_send_error', () => {
    const g = toGroup({
      id: 'g1',
      account_id: 'a',
      submission_ref: 'S',
      status: 'ACTIVE',
      created_at: '2026-10-16T10:00:00Z',
      last_activity_at: '2026-10-16T10:00:00Z',
      invite_sent_at: '2026-10-16T10:05:00Z',
      invite_send_error: null,
    });
    expect(g.inviteSentAt).toEqual(new Date('2026-10-16T10:05:00Z'));
    expect(g.inviteSendError).toBeNull();
  });
});

describe('reconcileEcho (267)', () => {
  it('asks sg_reconcile_echo and answers its boolean', async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const store = new SubmissionGroupStore({
      rpc,
    } as unknown as SupabaseClient);
    const echo = {
      groupId: 'sg-1',
      waMessageId: 'wa-echo',
      type: 'image',
      text: 'Ali (Agent)',
    };
    expect(
      await store.reconcileEcho({
        ...echo,
        sentAt: new Date('2026-10-16T10:19:58.000Z'),
      })
    ).toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('sg_reconcile_echo', {
      p_group: 'sg-1',
      p_wa_message_id: 'wa-echo',
      p_type: 'image',
      p_text: 'Ali (Agent)',
      p_sent_at: '2026-10-16T10:19:58.000Z',
    });
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await store.reconcileEcho({ ...echo, sentAt: null })).toBe(false);
    expect(rpc).toHaveBeenLastCalledWith(
      'sg_reconcile_echo',
      expect.objectContaining({ p_sent_at: null })
    );
  });
});

describe('wa_mode (136)', () => {
  it('open passes p_wa_mode, defaulting to group, and a NULL channel for none', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const store = new SubmissionGroupStore({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push([fn, args]);
        return { data: [{ group_id: 'g1', created: true }], error: null };
      },
    } as unknown as SupabaseClient);
    const base = {
      accountId: 'a',
      submissionRef: 'S',
      contactId: 'c',
      subject: 's',
      coordinatorPhone: null,
      access: [],
      keyId: null,
      customerName: null,
    };
    await store.open({ ...base, channelId: 'ch' });
    await store.open({ ...base, channelId: null, waMode: 'none' });
    expect(calls.map(([, a]) => [a.p_wa_mode, a.p_channel])).toEqual([
      ['group', 'ch'],
      ['none', null],
    ]);
  });

  it('open passes the customer name to sg_open as p_customer_name (141)', async () => {
    const calls: Record<string, unknown>[] = [];
    const store = new SubmissionGroupStore({
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        calls.push(args);
        return { data: [{ group_id: 'g1', created: true }], error: null };
      },
    } as unknown as SupabaseClient);
    const base = {
      accountId: 'a',
      submissionRef: 'S',
      contactId: 'c',
      channelId: null,
      waMode: 'none' as const,
      subject: 's',
      coordinatorPhone: null,
      access: [],
      keyId: null,
    };
    await store.open({ ...base, customerName: 'CANTUS - F.Z.E' });
    await store.open({ ...base, customerName: null });
    expect(calls.map((a) => a.p_customer_name)).toEqual([
      'CANTUS - F.Z.E',
      null,
    ]);
  });

  it('open passes p_coordinator_phones and toGroup maps coordinator_phones (142)', async () => {
    const calls: Record<string, unknown>[] = [];
    const store = new SubmissionGroupStore({
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        calls.push(args);
        return { data: [{ group_id: 'g1', created: true }], error: null };
      },
    } as unknown as SupabaseClient);
    const base = {
      accountId: 'a',
      submissionRef: 'S',
      contactId: 'c',
      channelId: 'ch',
      subject: 's',
      coordinatorPhone: null,
      access: [],
      keyId: null,
      customerName: null,
    };
    await store.open({ ...base, coordinatorPhones: ['971500000002'] });
    await store.open(base);
    expect(calls.map((a) => a.p_coordinator_phones)).toEqual([
      ['971500000002'],
      [],
    ]);
    const r = {
      id: 'g1',
      account_id: 'a',
      submission_ref: 'S',
      status: 'ACTIVE',
      created_at: '2026-10-16T10:00:00Z',
      last_activity_at: '2026-10-16T10:00:00Z',
    };
    expect(
      toGroup({ ...r, coordinator_phones: ['971500000002', '971500000003'] })
        .coordinatorPhones
    ).toEqual(['971500000002', '971500000003']);
    expect(toGroup(r).coordinatorPhones).toEqual([]);
  });

  it('toGroup reads wa_mode; a row without the column is a group row', () => {
    const r = {
      id: 'g1',
      account_id: 'a',
      submission_ref: 'S',
      status: 'ACTIVE',
      created_at: '2026-10-16T10:00:00Z',
      last_activity_at: '2026-10-16T10:00:00Z',
    };
    expect(toGroup({ ...r, wa_mode: 'none' }).waMode).toBe('none');
    expect(toGroup({ ...r, wa_mode: 'group' }).waMode).toBe('group');
    expect(toGroup(r).waMode).toBe('group');
  });

  /** A query builder that records every filter; awaiting it answers no rows. */
  const recording = () => {
    const filters: [string, ...unknown[]][] = [];
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'not', 'or', 'lt', 'order'])
      q[m] = (...args: unknown[]) => {
        filters.push([m, ...args]);
        return q;
      };
    q.limit = async () => ({ data: [], error: null });
    const store = new SubmissionGroupStore({
      from: () => q,
    } as unknown as SupabaseClient);
    return { store, filters };
  };

  it('listPendingCreates only lists group rows', async () => {
    const { store, filters } = recording();
    await store.listPendingCreates(new Date());
    expect(filters).toContainEqual(['eq', 'wa_mode', 'group']);
    // A stopped create must not fill the retry list for ever.
    expect(filters.find((f) => f[0] === 'or')?.[1]).toBe(
      'wa_create_error.is.null,wa_create_error.not.like.Stopped*'
    );
  });

  it('listUnclosedEnded only lists group rows', async () => {
    const { store, filters } = recording();
    await store.listUnclosedEnded();
    expect(filters).toContainEqual(['eq', 'wa_mode', 'group']);
  });
});

describe('listWithoutCase (the cron opens the missing case)', () => {
  it('asks for ACTIVE API-created groups with an agent and no case, newest first', async () => {
    const filters: unknown[][] = [];
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'not', 'lt', 'order'])
      q[m] = (...args: unknown[]) => {
        filters.push([m, ...args]);
        return q;
      };
    q.limit = async (n: number) => {
      filters.push(['limit', n]);
      return { data: [{ id: 'g1', account_id: 'A', cases: [] }], error: null };
    };
    const store = new SubmissionGroupStore({
      from: () => q,
    } as unknown as SupabaseClient);
    expect(
      await store.listWithoutCase(new Date('2026-11-23T10:00:00Z'), {
        limit: 20,
      })
    ).toEqual([{ id: 'g1', accountId: 'A' }]);
    // The embeds and filters PostgREST was asked with when this was written.
    expect(filters).toEqual([
      [
        'select',
        'id, account_id, cases!cases_group_fkey(id), submission_group_access!inner(id)',
      ],
      ['eq', 'status', 'ACTIVE'],
      ['not', 'created_by_key', 'is', null],
      ['is', 'cases', null],
      ['eq', 'submission_group_access.label', 'agent'],
      ['is', 'submission_group_access.removed_at', null],
      ['lt', 'created_at', '2026-11-23T10:00:00.000Z'],
      ['order', 'created_at', { ascending: false }],
      ['limit', 20],
    ]);
  });
});

describe('openAccessLabel (163 bank, 173 team lead fallback)', () => {
  const store = (role: string | null, rows: Record<string, unknown>[]) => {
    const calls: string[] = [];
    const db = fakeSupabase({
      tables: { submission_group_access: rows },
      rpc: {
        sg_resolve_role: () => {
          calls.push('sg_resolve_role');
          return role;
        },
      },
    });
    return { s: new SubmissionGroupStore(db as never), calls };
  };
  const open = {
    group_id: 'g1',
    user_id: 'u1',
    label: 'agent',
    removed_at: null,
  };

  it('keeps the open row label and asks nothing more', async () => {
    const { s, calls } = store('coordinator', [open]);
    expect(await s.openAccessLabel('g1', 'u1')).toBe('agent');
    expect(calls).toEqual([]);
  });

  it('falls back to coordinator when sg_resolve_role says so', async () => {
    const { s } = store('coordinator', []);
    expect(await s.openAccessLabel('g1', 'u1')).toBe('coordinator');
  });

  it('falls back to team_lead when sg_resolve_role says so', async () => {
    const { s } = store('team_lead', []);
    expect(await s.openAccessLabel('g1', 'u1')).toBe('team_lead');
  });

  it('stays null for any other answer', async () => {
    expect(await store('agent', []).s.openAccessLabel('g1', 'u1')).toBeNull();
    expect(await store('admin', []).s.openAccessLabel('g1', 'u1')).toBeNull();
    expect(await store('owner', []).s.openAccessLabel('g1', 'u1')).toBeNull();
    expect(await store(null, []).s.openAccessLabel('g1', 'u1')).toBeNull();
  });
});

describe('adoptionRivals', () => {
  const AT = new Date('2026-11-01T10:00:00Z');
  const row = (o: Record<string, unknown>) => ({
    account_id: 'a',
    channel_id: 'c',
    subject: 'Acme',
    wa_mode: 'group',
    wa_group_id: null,
    ended_at: null,
    ...o,
  });
  const rivals = (rows: Record<string, unknown>[]) =>
    new SubmissionGroupStore(
      fakeSupabase({
        tables: { submission_groups: rows },
      }) as unknown as SupabaseClient
    ).adoptionRivals(
      {
        id: 'me',
        accountId: 'a',
        channelId: 'c',
        subject: 'Acme',
        createdAt: AT,
      } as SubmissionGroup,
      ['x@g.us', 'y@g.us']
    );

  it('names the groups others hold and a twin without its group, never itself', async () => {
    expect(await rivals([row({ id: 'me' })])).toEqual({
      held: [],
      twin: false,
    });
    expect(
      await rivals([
        row({ id: 'me' }),
        row({ id: 'o', subject: 'Other', wa_group_id: 'x@g.us' }),
        row({ id: 't' }),
      ])
    ).toEqual({ held: ['x@g.us'], twin: true });
  });

  it('a twin ended before this submission existed is none; one ended since still is', async () => {
    const ended = (at: string) =>
      rivals([row({ id: 't', ended_at: at })]).then((r) => r.twin);
    expect(await ended('2026-11-01T09:00:00Z')).toBe(false);
    expect(await ended('2026-11-01T11:00:00Z')).toBe(true);
  });
});
