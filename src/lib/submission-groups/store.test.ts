import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { GroupInboundMessage } from '@/lib/groups/inbound';

import { reconcileEcho } from './inbound';
import {
  PENDING_OUT_SCAN,
  SubmissionGroupDbError,
  SubmissionGroupStore,
  toGroup,
} from './store';
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

describe('echo reconcile queries', () => {
  const NOW = new Date('2026-10-16T10:20:00.000Z');
  const SINCE = new Date('2026-10-16T10:05:00.000Z');
  const UNTIL = new Date('2026-10-16T10:19:58.999Z');
  const BODY = 'Ali (Agent): hi';

  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    group_id: 'sg-1',
    direction: 'out',
    send_status: 'pending',
    created_at: '2026-10-16T10:19:00.000Z',
    prefixed_body: BODY,
    wa_message_id: null,
    ...over,
  });

  /** A store over an in-memory table; sg_settle_send settles a pending row once, as the SQL does. */
  const storeOver = (rows: Record<string, unknown>[]) => {
    const db: FakeDb = {
      tables: { submission_group_messages: rows },
      rpc: {
        sg_settle_send: (a) => {
          const r = rows.find((x) => x.id === a.p_message);
          if (!r || r.send_status !== 'pending') return false;
          r.send_status = a.p_status;
          r.wa_message_id = a.p_wa_message_id;
          return true;
        },
      },
    };
    return new SubmissionGroupStore(
      fakeSupabase(db) as unknown as SupabaseClient
    );
  };

  const echo: GroupInboundMessage = {
    id: 'wa-echo',
    waGroupId: '120363000000000001@g.us',
    fromMe: true,
    senderWaId: '971500000001',
    senderName: null,
    type: 'text',
    body: BODY,
    media: null,
    sentAt: '2026-10-16T10:19:58.000Z',
  };

  it("pendingOutMatching keeps only the group's pending 'out' rows in the window with exactly that text", async () => {
    const store = storeOver([
      row('match'),
      row('other-group', { group_id: 'sg-2' }),
      row('inbound', { direction: 'in' }),
      row('failed', { send_status: 'failed' }),
      row('too-old', { created_at: '2026-10-16T10:04:59.000Z' }),
      row('after-echo', { created_at: '2026-10-16T10:19:59.000Z' }),
      row('other-text', { prefixed_body: 'Ali (Agent): hi ' }),
    ]);
    expect(await store.pendingOutMatching('sg-1', BODY, SINCE, UNTIL)).toEqual([
      'match',
    ]);
    // No upper bound when the echo has no timestamp.
    expect(await store.pendingOutMatching('sg-1', BODY, SINCE, null)).toEqual([
      'match',
      'after-echo',
    ]);
  });

  it('a full scan page answers no match: a twin past it cannot be ruled out', async () => {
    const rows = Array.from({ length: PENDING_OUT_SCAN }, (_, i) =>
      row(`r${String(i).padStart(2, '0')}`, {
        prefixed_body: i === 0 ? BODY : `Ali (Agent): other ${i}`,
      })
    );
    expect(
      await storeOver(rows).pendingOutMatching('sg-1', BODY, SINCE, UNTIL)
    ).toEqual([]);
    expect(
      await storeOver(rows.slice(0, -1)).pendingOutMatching(
        'sg-1',
        BODY,
        SINCE,
        UNTIL
      )
    ).toEqual(['r00']);
  });

  it("one matching pending row is settled sent with the echo's id", async () => {
    const rows = [row('m1', { created_at: '2026-10-16T10:19:58.500Z' })];
    expect(await reconcileEcho(storeOver(rows), 'sg-1', echo, NOW)).toBe(true);
    expect(rows[0]).toMatchObject({
      send_status: 'sent',
      wa_message_id: 'wa-echo',
    });
  });

  it('two identical pending rows are ambiguous: neither is settled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = [
      row('m1', { created_at: '2026-10-16T10:18:00.000Z' }),
      row('m2', { created_at: '2026-10-16T10:19:00.000Z' }),
    ];
    expect(await reconcileEcho(storeOver(rows), 'sg-1', echo, NOW)).toBe(false);
    expect(rows.map((r) => [r.send_status, r.wa_message_id])).toEqual([
      ['pending', null],
      ['pending', null],
    ]);
    warn.mockRestore();
  });

  it('an echo whose WhatsApp id is already recorded in the group settles nothing', async () => {
    const rows = [
      row('done', { send_status: 'sent', wa_message_id: 'wa-echo' }),
      row('m1'),
    ];
    expect(await reconcileEcho(storeOver(rows), 'sg-1', echo, NOW)).toBe(false);
    expect(rows[1]).toMatchObject({ send_status: 'pending' });
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
    };
    await store.open({ ...base, channelId: 'ch' });
    await store.open({ ...base, channelId: null, waMode: 'none' });
    expect(calls.map(([, a]) => [a.p_wa_mode, a.p_channel])).toEqual([
      ['group', 'ch'],
      ['none', null],
    ]);
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
    for (const m of ['select', 'eq', 'is', 'not', 'lt', 'order'])
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
  });

  it('listUnclosedEnded only lists group rows', async () => {
    const { store, filters } = recording();
    await store.listUnclosedEnded();
    expect(filters).toContainEqual(['eq', 'wa_mode', 'group']);
  });
});
