import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { loadWorklistInputs } from './load';

type Answer = { data: unknown; error: unknown } | 'throw';

/** A chainable query whose every method returns itself and awaits to `answer`. */
function fakeSupabase(answers: Record<string, Answer>): SupabaseClient {
  return {
    from(table: string) {
      const answer = answers[table] ?? { data: [], error: null };
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'like', 'lt', 'order', 'limit'])
        q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        answer === 'throw'
          ? Promise.reject(new Error('boom')).then(ok, bad)
          : Promise.resolve(answer).then(ok, bad);
      return q;
    },
  } as unknown as SupabaseClient;
}

const jsonFetch = (status: number, body: unknown) =>
  vi.fn(
    async () => new Response(JSON.stringify(body), { status })
  ) as unknown as typeof fetch;

describe('loadWorklistInputs', () => {
  it('a failing HR source and a 403 case inbox each count as empty', async () => {
    const sb = fakeSupabase({
      hr_conversations: { data: null, error: { message: 'denied' } },
      tasks: 'throw',
      hr_workflow_rules: { data: null, error: { message: 'x' } },
      hr_agent_drafts: { data: null, error: { message: 'x' } },
    });
    const f = jsonFetch(403, {
      error: 'Your department does not have access to this',
    });
    const out = await loadWorklistInputs(sb, f);
    expect(out).toEqual({
      hrConversations: [],
      hrTasks: [],
      hrRules: [],
      drafts: [],
      cases: [],
    });
    expect(
      String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    ).toMatch(/^\/api\/cases\?.*limit=200/);
  });

  it('attaches owner ids from the embedded chat and keeps no names', async () => {
    const sb = fakeSupabase({
      hr_conversations: {
        data: [
          {
            conversation_id: 'c-1',
            inbox: 'recruiter',
            closed_at: null,
            chat: { assigned_agent_id: 'u-1' },
          },
          {
            conversation_id: 'c-2',
            inbox: 'dept',
            closed_at: null,
            chat: null,
          },
        ],
        error: null,
      },
      hr_agent_drafts: {
        data: [
          {
            id: 'd-1',
            conversation_id: 'c-1',
            status: 'pending',
            created_at: '2026-11-19T00:00:00Z',
            hr: { inbox: 'recruiter', chat: [{ assigned_agent_id: 'u-1' }] },
          },
        ],
        error: null,
      },
    });
    const f = jsonFetch(200, { rows: [], nextCursor: null });
    const out = await loadWorklistInputs(sb, f);
    expect(
      out.hrConversations.map((c) => [c.conversation_id, c.ownerId])
    ).toEqual([
      ['c-1', 'u-1'],
      ['c-2', null],
    ]);
    expect(out.hrConversations[0]).not.toHaveProperty('chat');
    expect(out.drafts).toEqual([
      {
        id: 'd-1',
        conversation_id: 'c-1',
        status: 'pending',
        created_at: '2026-11-19T00:00:00Z',
        inbox: 'recruiter',
        ownerId: 'u-1',
      },
    ]);
  });
});
