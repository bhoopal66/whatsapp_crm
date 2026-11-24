import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignableMembers,
  assignConversation,
  assignFromScreen,
  type AssignScreen,
} from './assign';

type Row = { id: string; assigned_agent_id: string | null };

/**
 * One conversation behind PostgREST: filters decide whether an update
 * matches it, and an update that matches nothing is a success with no
 * row, as RLS makes it. `readable` / `writable` are the two policies.
 */
function fakeClient({
  row,
  readable = true,
  writable = true,
  error = null,
  readError = null,
}: {
  row: Row;
  readable?: boolean;
  writable?: boolean;
  error?: unknown;
  readError?: unknown;
}) {
  const patches: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      expect(table).toBe('conversations');
      let patch: Record<string, unknown> | null = null;
      let returning = false;
      const filters: [string, unknown][] = [];
      const settle = () => {
        if (patch && error) return { data: null, error };
        if (!patch && readError) return { data: null, error: readError };
        const visible = readable && (!patch || writable);
        const hit =
          visible &&
          filters.every(([c, v]) => (row as Record<string, unknown>)[c] === v);
        if (hit && patch) {
          patches.push(patch);
          Object.assign(row, patch);
        }
        return { data: hit && returning ? { ...row } : null, error: null };
      };
      const q: Record<string, unknown> = {
        update: (v: Record<string, unknown>) => ((patch = v), q),
        select: () => ((returning = true), q),
        eq: (c: string, v: unknown) => (filters.push([c, v]), q),
        is: (c: string, v: unknown) => (filters.push([c, v]), q),
        maybeSingle: async () => settle(),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve(settle()).then(ok),
      };
      return q;
    },
  };
  return { client: client as unknown as SupabaseClient, patches };
}

describe('assignConversation', () => {
  it('assigns an unassigned chat and returns the row it wrote', async () => {
    const row: Row = { id: 'conv-1', assigned_agent_id: null };
    const { client, patches } = fakeClient({ row });
    expect(await assignConversation(client, 'conv-1', null, 'omar')).toEqual({
      ok: true,
      assignedAgentId: 'omar',
    });
    expect(patches).toEqual([{ assigned_agent_id: 'omar' }]);
  });

  it('releases the chat with null', async () => {
    const row: Row = { id: 'conv-1', assigned_agent_id: 'sara' };
    const { client } = fakeClient({ row });
    expect(await assignConversation(client, 'conv-1', 'sara', null)).toEqual({
      ok: true,
      assignedAgentId: null,
    });
    expect(row.assigned_agent_id).toBeNull();
  });

  it('never overwrites an assignee the screen did not show', async () => {
    const row: Row = { id: 'conv-1', assigned_agent_id: 'sara' };
    const { client, patches } = fakeClient({ row });
    // The dialog was opened on an unassigned chat.
    expect(await assignConversation(client, 'conv-1', null, 'omar')).toEqual({
      ok: false,
      reason: 'changed',
      assignedAgentId: 'sara',
    });
    // And one opened while somebody else held it.
    expect(await assignConversation(client, 'conv-1', 'ali', 'omar')).toEqual({
      ok: false,
      reason: 'changed',
      assignedAgentId: 'sara',
    });
    expect(patches).toEqual([]);
    expect(row.assigned_agent_id).toBe('sara');
  });

  it('says the chat has moved when RLS hides it (0 rows, no error)', async () => {
    const row: Row = { id: 'conv-1', assigned_agent_id: 'me' };
    const { client } = fakeClient({ row, readable: false });
    expect(await assignConversation(client, 'conv-1', 'me', 'omar')).toEqual({
      ok: false,
      reason: 'moved',
    });
  });

  it('says refused when the chat can be read but not changed', async () => {
    const row: Row = { id: 'conv-1', assigned_agent_id: 'sara' };
    const { client } = fakeClient({ row, writable: false });
    expect(await assignConversation(client, 'conv-1', 'sara', 'omar')).toEqual({
      ok: false,
      reason: 'refused',
    });
  });

  it('counts as done when somebody already assigned that person', async () => {
    const row: Row = { id: 'conv-1', assigned_agent_id: 'omar' };
    const { client, patches } = fakeClient({ row });
    expect(await assignConversation(client, 'conv-1', 'sara', 'omar')).toEqual({
      ok: true,
      assignedAgentId: 'omar',
    });
    expect(patches).toEqual([]);
  });

  it('passes the database error through, from the write or the read', async () => {
    const row: Row = { id: 'conv-1', assigned_agent_id: 'sara' };
    const error = { message: 'denied', code: '42501' };
    expect(
      await assignConversation(
        fakeClient({ row, error }).client,
        'conv-1',
        'sara',
        'omar'
      )
    ).toEqual({ ok: false, reason: 'error', error });
    expect(
      await assignConversation(
        fakeClient({ row, readError: error }).client,
        'conv-1',
        null,
        'omar'
      )
    ).toEqual({ ok: false, reason: 'error', error });
  });
});

describe('assignFromScreen', () => {
  afterEach(() => vi.restoreAllMocks());
  const run = async (
    opts: Parameters<typeof fakeClient>[0],
    expected: string | null,
    userId: string | null
  ) => {
    const screen = {
      patch: vi.fn(),
      askAgain: vi.fn(),
      fail: vi.fn(),
    } satisfies AssignScreen;
    await assignFromScreen(
      fakeClient(opts).client,
      { conversationId: 'conv-1', expected, userId },
      screen
    );
    return screen;
  };

  it('patches the screen from the row that was written', async () => {
    const screen = await run(
      { row: { id: 'conv-1', assigned_agent_id: null } },
      null,
      'omar'
    );
    expect(screen.patch).toHaveBeenCalledWith('conv-1', 'omar');
    expect(screen.askAgain).not.toHaveBeenCalled();
    expect(screen.fail).not.toHaveBeenCalled();
  });

  it('shows the colleague’s assignee and asks again', async () => {
    const screen = await run(
      { row: { id: 'conv-1', assigned_agent_id: 'sara' } },
      null,
      'omar'
    );
    expect(screen.patch.mock.calls).toEqual([['conv-1', 'sara']]);
    expect(screen.askAgain).toHaveBeenCalledWith('sara');
    expect(screen.fail).not.toHaveBeenCalled();
  });

  it('patches nothing when the chat moved, was refused or failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = { id: 'conv-1', assigned_agent_id: 'sara' };
    const moved = await run({ row, readable: false }, 'sara', 'omar');
    expect(moved.fail).toHaveBeenCalledWith('assignMoved');
    const refused = await run({ row, writable: false }, 'sara', 'omar');
    expect(refused.fail).toHaveBeenCalledWith('assignFailed');
    const failed = await run({ row, error: { code: 'x' } }, 'sara', 'omar');
    expect(failed.fail).toHaveBeenCalledWith('assignFailed');
    for (const screen of [moved, refused, failed]) {
      expect(screen.patch).not.toHaveBeenCalled();
      expect(screen.askAgain).not.toHaveBeenCalled();
    }
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
