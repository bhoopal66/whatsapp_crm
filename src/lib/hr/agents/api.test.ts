import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  agentSettings,
  decideDraft,
  listDrafts,
  runAgents,
  setAgentSetting,
} from './api';

type Result = { data: unknown; error: unknown };

/** A query builder recording each chained call; awaiting it yields `result`. */
function builder(result: Result, calls: unknown[][]) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'order', 'limit']) {
    q[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return q;
    };
  }
  q.then = (ok: (v: Result) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve(result).then(ok, bad);
  return q;
}

function client(results: Result[]) {
  const queries: unknown[][][] = [];
  const tables: string[] = [];
  const rpc = vi.fn();
  const sb = {
    rpc,
    from: (table: string) => {
      tables.push(table);
      const calls: unknown[][] = [];
      queries.push(calls);
      return builder(results[queries.length - 1], calls);
    },
  } as unknown as SupabaseClient;
  return { sb, rpc, queries, tables };
}

const draft = (id: string, status: string) => ({ id, status });

describe('listDrafts', () => {
  it('lists pending drafts first, then the rest, newest first, capped at 20', async () => {
    const pending = [draft('p2', 'pending'), draft('p1', 'pending')];
    const rest = Array.from({ length: 20 }, (_, i) =>
      draft(`r${i}`, 'approved')
    );
    const { sb, queries, tables } = client([
      { data: pending, error: null },
      { data: rest, error: null },
    ]);
    const res = await listDrafts(sb, 'conv-1');
    expect(tables).toEqual(['hr_agent_drafts', 'hr_agent_drafts']);
    expect(queries[0]).toContainEqual(['eq', 'conversation_id', 'conv-1']);
    expect(queries[0]).toContainEqual(['eq', 'status', 'pending']);
    expect(queries[1]).toContainEqual(['neq', 'status', 'pending']);
    for (const q of queries) {
      expect(q).toContainEqual(['order', 'created_at', { ascending: false }]);
      expect(q).toContainEqual(['limit', 20]);
    }
    expect('data' in res && res.data.map((d) => d.id)).toEqual([
      'p2',
      'p1',
      ...rest.slice(0, 18).map((d) => d.id),
    ]);
  });

  it('answers the error code when a read fails', async () => {
    const { sb } = client([
      { data: [], error: null },
      { data: null, error: { message: 'x', hint: 'NOT_ALLOWED' } },
    ]);
    await expect(listDrafts(sb, 'conv-1')).resolves.toEqual({
      error: 'NOT_ALLOWED',
    });
  });
});

describe('decideDraft', () => {
  it('passes the decision and a trimmed reason', async () => {
    const { sb, rpc } = client([]);
    rpc.mockResolvedValue({
      data: { id: 'd1', status: 'rejected' },
      error: null,
    });
    await expect(
      decideDraft(sb, 'd1', 'reject', '  wrong tone ')
    ).resolves.toEqual({ data: { id: 'd1', status: 'rejected' } });
    expect(rpc).toHaveBeenCalledWith('hr_agent_draft_decide', {
      p_draft_id: 'd1',
      p_decision: 'reject',
      p_reason: 'wrong tone',
    });
  });

  it('sends a null reason when none is given', async () => {
    const { sb, rpc } = client([]);
    rpc.mockResolvedValue({ data: {}, error: null });
    await decideDraft(sb, 'd1', 'approve');
    expect(rpc.mock.calls[0][1].p_reason).toBeNull();
  });

  it.each(['ALREADY_DECIDED', 'LIMIT', 'OPTED_OUT'])(
    'maps the hint %s',
    async (hint) => {
      const { sb, rpc } = client([]);
      rpc.mockResolvedValue({ data: null, error: { message: 'no', hint } });
      await expect(decideDraft(sb, 'd1', 'approve')).resolves.toEqual({
        error: hint,
      });
    }
  );
});

describe('agentSettings', () => {
  it('reports all five kinds, a missing row as off', async () => {
    const { sb } = client([
      {
        data: [
          { agent_kind: 'orchestrator', enabled: true },
          { agent_kind: 'scheduling', enabled: false },
        ],
        error: null,
      },
    ]);
    await expect(agentSettings(sb)).resolves.toEqual({
      data: {
        orchestrator: true,
        cv_screening: false,
        scheduling: false,
        candidate_faq: false,
        escalation: false,
      },
    });
  });
});

describe('setAgentSetting', () => {
  it('calls hr_agent_settings_set', async () => {
    const { sb, rpc } = client([]);
    rpc.mockResolvedValue({ data: { agent_kind: 'scheduling' }, error: null });
    await setAgentSetting(sb, 'scheduling', true);
    expect(rpc).toHaveBeenCalledWith('hr_agent_settings_set', {
      p_agent_kind: 'scheduling',
      p_enabled: true,
    });
  });
});

describe('runAgents', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the chat and slots and answers the outcome', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ outcome: 'drafted', draftId: 'd9' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runAgents('conv-1', ['Mon 10:00'])).resolves.toEqual({
      data: { outcome: 'drafted', draftId: 'd9' },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/hr/agents/run');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      conversationId: 'conv-1',
      slots: ['Mon 10:00'],
    });
  });

  it("answers the route's error code", async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: 'agents_off' }, { status: 409 })
        )
    );
    await expect(runAgents('conv-1')).resolves.toEqual({ error: 'agents_off' });
  });

  it('answers failed when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(runAgents('conv-1')).resolves.toEqual({ error: 'failed' });
  });
});
