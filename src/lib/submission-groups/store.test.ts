import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { SubmissionGroupDbError, SubmissionGroupStore, toGroup } from './store';

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
