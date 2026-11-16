import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { assignableMembers, assignConversation } from './assign';

/** Records the builder chain and resolves with `error`. */
function fakeClient(error: unknown = null) {
  const calls: {
    table?: string;
    patch?: Record<string, unknown>;
    eq?: [string, unknown];
  } = {};
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        update(patch: Record<string, unknown>) {
          calls.patch = patch;
          return {
            eq(column: string, value: unknown) {
              calls.eq = [column, value];
              return Promise.resolve({ error });
            },
          };
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe('assignConversation', () => {
  it('writes assigned_agent_id on that one conversation', async () => {
    const { client, calls } = fakeClient();
    const result = await assignConversation(client, 'conv-1', 'user-2');
    expect(result).toEqual({ ok: true });
    expect(calls.table).toBe('conversations');
    expect(calls.patch).toEqual({ assigned_agent_id: 'user-2' });
    expect(calls.eq).toEqual(['id', 'conv-1']);
  });

  it('releases the chat with null', async () => {
    const { client, calls } = fakeClient();
    await assignConversation(client, 'conv-1', null);
    expect(calls.patch).toEqual({ assigned_agent_id: null });
  });

  it('passes the database error through', async () => {
    const error = { message: 'denied', code: '42501' };
    const { client } = fakeClient(error);
    const result = await assignConversation(client, 'conv-1', 'user-2');
    expect(result).toEqual({ ok: false, error });
  });
});

describe('assignableMembers', () => {
  const profiles = [
    { user_id: 'me', deactivated_at: null },
    { user_id: 'led', deactivated_at: null },
    { user_id: 'other' },
    { user_id: 'gone', deactivated_at: '2026-11-01T00:00:00Z' },
    { user_id: 'led-gone', deactivated_at: '2026-11-01T00:00:00Z' },
  ];
  const ids = (list: { user_id: string }[]) => list.map((p) => p.user_id);
  const base = {
    myUserId: 'me',
    profiles,
    leadableUserIds: new Set(['led', 'led-gone']),
  };

  it('offers an admin every live member, in order', () => {
    expect(ids(assignableMembers({ ...base, accountRole: 'admin' }))).toEqual([
      'me',
      'led',
      'other',
    ]);
    expect(ids(assignableMembers({ ...base, accountRole: 'owner' }))).toEqual([
      'me',
      'led',
      'other',
    ]);
  });

  it('offers an agent only themselves', () => {
    expect(
      ids(
        assignableMembers({
          ...base,
          accountRole: 'agent',
          leadableUserIds: new Set(),
        })
      )
    ).toEqual(['me']);
  });

  it('offers a team leader themselves plus the live people they lead', () => {
    expect(
      ids(assignableMembers({ ...base, accountRole: 'team_leader' }))
    ).toEqual(['me', 'led']);
  });

  it('offers the narrow list while the role is unknown', () => {
    expect(
      ids(
        assignableMembers({
          ...base,
          accountRole: null,
          leadableUserIds: new Set(),
        })
      )
    ).toEqual(['me']);
  });

  it('never offers a deactivated member, self included', () => {
    const list = assignableMembers({
      ...base,
      accountRole: 'agent',
      profiles: [{ user_id: 'me', deactivated_at: '2026-11-01T00:00:00Z' }],
    });
    expect(list).toEqual([]);
  });
});
